# Phase 2 SMC — Approved Specification

Status: APPROVED (implementation authorized). This document is the source of truth for the
Phase 2 SMC analyzers (liquidity, FVG, order blocks, premium/discount) and their integration
into `SMCEngine`.

## 0. Scope

- Components: liquidity sweeps, fair value gaps (FVG), order blocks (OB), premium/discount.
- Integration: `lib/analysis/smc.ts` (`SMCEngine`) aggregator.
- Out of scope: Phase 1 market structure / BOS / CHoCH rules, candle aggregation, websocket,
  symbol mappings, chart styling, and the Phase 3 signal engine.

## 1. Cross-cutting invariants

- **Closed-candle only.** Every analyzer filters `isClosed !== false`; anchors are closed-candle
  epochs. The caller supplies `getHistory` (closed candles only).
- **Stateless.** Each `analyze(symbol, timeframe, ...)` recomputes from inputs. No cross-call,
  cross-symbol, or cross-timeframe cache.
- **Determinism.** Identical closed input yields deep-equal output, excluding
  `SMCAnalysisResult.analyzedAt`.
- **Ordering.** `marketStructure` is computed first; liquidity / FVG / OB / premium-discount
  consume its output and never recompute structure.
- **No-throw.** Unmet preconditions yield empty arrays and `'WAITING FOR DATA'` (preserve enums).
- **Array ordering.** Chronological ascending by `epoch`; ties broken deterministically by ID.
- **Comparison operators.** Equality/tolerance comparisons use `<=` (consistent with Phase 1).
  "Penetrates by more than tolerance" is strict (`>`).
- `tol(price) = getSymbolEqualityTolerance(symbol, price, customTolerance?)`.

## 2. Isolation

Confirmed: results are produced per single `(symbol, timeframe)` call and IDs encode
`${symbol}:${timeframe}:...`. Sub-state containers additionally carry explicit `symbol` and
`timeframe` fields. No run can read or overwrite another pair's output.

## 3. Interface extensions

1. `LiquidityState`, `FVGState`, `OrderBlockState`: add `symbol: string` and `timeframe: Timeframe`.
2. `LiquidityLevel`: add `sweptEpoch?: number` (`swept` captures "remains swept").
3. `EqualHighLow`: add `id: string` and `epoch: number` (cluster's last-touch anchor epoch).
4. `OrderBlock`: add `invalidated: boolean`, `mitigationEpoch?: number`, `invalidatedEpoch?: number`.
5. `FairValueGap`: unchanged (`mitigated`, `mitigationEpoch?`).
6. Analyzer signatures:
   - `LiquidityAnalyzer.analyze(symbol, timeframe, candles, structure: MarketStructureState)`
   - `FVGAnalyzer.analyze(symbol, timeframe, candles)`
   - `OrderBlockAnalyzer.analyze(symbol, timeframe, candles, structure: MarketStructureState)`
     (the analyzer needs swings to apply the origin-swing window; `structure.breaks` supplies the
     break events).
   - Premium/discount computed in `SMCEngine.analyze` from `structure` and last closed close.

**Interface amendment (OrderBlockAnalyzer).** The originally approved signature was
`analyze(symbol, timeframe, candles, breaks: StructureBreak[])`. It was amended to accept the full
`MarketStructureState` because the origin-swing window (§6.1) is bounded by the most recent
confirmed swing (`structure.swings`), which a bare `StructureBreak[]` cannot supply. Passing the
whole state also keeps `SMCEngine` (§0) the single place that computes structure and hands the same
authoritative result to every sub-analyzer, avoiding a second structure pass. The public behavior of
the analyzer is otherwise unchanged.


## 4. Liquidity — sweep-on-rejection

- One `LiquidityLevel` per confirmed swing: swing high => `BUY_SIDE`, swing low => `SELL_SIDE`;
  `price = swing.price`; `epoch = swing.swingCandleEpoch`.
- **Buy-side sweep:** scanning closed candles with `epoch > swing.swingCandleEpoch` in order, the
  first candle where `high - level > tol(level)` AND `close < level` sets `swept = true` and
  `sweptEpoch = epoch`. First hit only; never cleared.
- **Sell-side sweep:** symmetric (`level - low > tol(level)` AND `close > level`).
- A touch/equal does not sweep. A close-through (penetration with close beyond) does not sweep.
- A single candle may sweep multiple levels on the same side.
- Sweep is descriptive only — no signal implication.

Boundaries: penetration exactly `= tol` => not swept. Close exactly `= level` => not a rejection.
The level's own candle and all earlier candles never sweep it.

### EQH/EQL clustering (fixed-anchor, chronological)

Precondition: swing highs/lows are sorted ascending by `swingCandleEpoch` before clustering.

1. Maintain an open cluster with `anchorPrice =` price of its first swing (never changes).
2. For each next swing `s`: join iff `|s.price - anchorPrice| <= tol(anchorPrice)`.
   - Join => `count++`, `price = max` of cluster members for EQH (min for EQL),
     `epoch = s.swingCandleEpoch`.
   - No-join => close current cluster (emit only if `count >= 2`) and start a new cluster.
3. Emit final cluster if `count >= 2`. Symmetric for lows.
4. `id = symbol:timeframe:LIQ:EQH|EQL:firstMemberEpoch`;
   `tolerancePips = tol(anchorPrice) / pipValue`, where `pipValue = 10^-(pipSize - 1)` for the
   symbol config (`pipSize` = number of decimal places). For an unsupported/misconfigured symbol
   the conversion is unavailable and the field is **omitted** (see §4.1).

Ambiguous case: clustering compares each swing only to the fixed anchor — never transitively.
A swing within tolerance of a non-anchor member but not the anchor starts a new cluster.

Boundary: `|Δ| == tol` => joins (`<=`).

### 4.1 Units and rounding for `tolerancePips` / `refinedPips`

- Both fields express a raw price distance on a symbol-consistent scale:
  `value = distance / pipValue`, with `pipValue = 10^-(pipSize - 1)` and `pipSize` = the symbol's
  number of decimal places (`DerivSymbolConfig.pipSize`).
- **Conventional FX pips:** for the 5-decimal forex majors (EURUSD, GBPUSD, AUDUSD) `pipValue =
  1e-4` (one conventional pip, the 4th decimal); for the 3-decimal JPY pair (USDJPY) `pipValue =
  1e-2` (2nd decimal).
- **Synthetic / Crash-Boom indices:** `pipValue` is a price-scaled unit one decimal below the
  quoted precision (V75/BOOM1000/CRASH1000 = `1e-3`, V10 = `1e-2`). These are **not** broker pips;
  the numbers are only meaningful relative to the symbol.
- **Unsupported symbol:** when `getSymbolConfig` has no entry (or `pipSize < 1`), the conversion is
  unavailable. `EqualHighLow.tolerancePips` and `OrderBlock.refinedPips` are **omitted**
  (`undefined`), never a raw price distance used as if it were a pip measurement. `getPipValue` /
  `toPipUnits` in `lib/deriv/symbols.ts` return `undefined` in this case.
- **Rounding:** both values are emitted at full floating-point precision (no rounding). Consumers
  round for display only. (An earlier draft rounded `refinedPips` to integers; that was removed to
  avoid discarding precision.)
- These helpers do **not** affect actual price-tolerance comparisons: sweep, clustering, mitigation,
  and invalidation all still compare raw prices via `getSymbolEqualityTolerance` (§1).

## 5. Fair Value Gaps — full-fill mitigation

- Triples of consecutive closed candles `a,b,c` (indices `i-2,i-1,i`):
  - Bullish if `c.low > a.high` => `bottomPrice = a.high`, `topPrice = c.low`.
  - Bearish if `c.high < a.low` => `topPrice = a.low`, `bottomPrice = c.high`.
- Filter: `topPrice - bottomPrice > tol(topPrice)`.
- `epoch = c.epoch` (confirmation candle; no look-ahead). `id` per Section 2.
- Full-fill mitigation, scanned from `j = i+1` (creation/confirmation candle cannot self-mitigate):
  - Bullish: first `low <= bottomPrice` => `mitigated`, `mitigationEpoch`.
  - Bearish: first `high >= topPrice` => `mitigated`, `mitigationEpoch`.
- `unmitigatedCount = unmitigated bullish + unmitigated bearish`.
- `status = 'ACTIVE'` iff the number of eligible **closed** candles is `>= 3`; otherwise
  `'WAITING FOR DATA'`. (The forming candle is excluded, so eligibility is measured after the
  closed-candle filter, not on the raw input length.)

Boundaries: `low == bottomPrice` (bullish) / `high == topPrice` (bearish) counts as filled.
Mitigation is permanent once set.

## 6. Order blocks — touch mitigation, distinct invalidation

### 6.1 Source-candle search window

- **Bullish** break (`BULLISH_BOS` / `BULLISH_CHOCH`): nearest preceding closed candle with
  `close < open`. **Bearish** break: nearest preceding closed candle with `close > open`.
- Window lower bound = most recent confirmed swing low (bullish) / swing high (bearish) with
  `swingCandleEpoch <= breakCandleEpoch`, inclusive of that swing candle.
- **Fallback** when no origin swing exists in range: examine at most `W_MAX = 20` eligible closed
  candles immediately preceding the break candle. Eligible = closed candles with
  `epoch < breakCandleEpoch`; the search scans at most 20 of them (exact distance boundary is
  tested to prevent off-by-one).
- No suitable opposing candle in window => emit no OB for that break (no throw, no fabrication).
- Dedupe key `${type}:${sourceEpoch}`; keep earliest break. No array cap in Phase 2.

### 6.2 Semantics

- `type`: `'BULLISH'` / `'BEARISH'`; `high`/`low` = source candle high/low; `epoch` = source epoch.
- `id = symbol:timeframe:OB:BULLISH|BEARISH:epoch`.
- **Mitigation (touch/return):** first later closed candle with bullish `low <= OB.high`
  (bearish `high >= OB.low`) sets `mitigated = true`, `mitigationEpoch`.
- **Invalidation (close-through):** first later closed candle that closes below `OB.low` (bullish)
  / above `OB.high` (bearish) sets `invalidated = true`, `invalidatedEpoch`.
- Scanned only at candles with `epoch > OB.epoch`.
- `refinedPips = (OB.high - OB.low) / pipValue` at full precision (see §4.1); omitted for
  unsupported symbols. `status` is defined in §6.4.

### 6.4 Status semantics

- `status = 'ACTIVE'` iff `structure.breaks.length > 0`; otherwise `'WAITING FOR DATA'`.
- `ACTIVE` describes the analyzer having structural input to work with, **not** that blocks were
  produced. It is possible (and valid) for the state to be `ACTIVE` with zero order blocks, e.g.
  when the only breaks are `INITIAL_*` (excluded by §6.1) or when no suitable opposing source
  candle exists in the window. `ACTIVE` + empty arrays is not an error and is not reclassified.

### 6.3 State invariant

> `invalidated === true` implies `mitigated === true`.

Enforcement during the chronological pass:

1. A touch-only candle sets `mitigated = true` and `mitigationEpoch` if not already set.
2. A close-through candle sets `invalidated = true` and `invalidatedEpoch`, and guarantees
   `mitigated = true`:
   - If mitigation occurred earlier, the earlier `mitigationEpoch` is preserved.
   - If not, that same candle sets `mitigationEpoch = invalidatedEpoch`.
3. `mitigationEpoch`, once set, never moves later. `invalidatedEpoch` is never overwritten.
4. `invalidated && !mitigated` is an illegal state and must never be emitted.
5. Neither event terminates detection of other blocks.

## 7. Premium / Discount

- Endpoints: `rangeHigh = max(latestSwingHigh.price, latestSwingLow.price)`,
  `rangeLow = min(...)`. Missing swing or `range <= 0` => `zone = 'WAITING FOR DATA'`.
- `equilibrium = (rangeHigh + rangeLow) / 2`; `band = 0.05 * range`.
- Price = last closed candle's close.
- `PREMIUM` if `price > equilibrium + band`; `DISCOUNT` if `price < equilibrium - band`; else
  `EQUILIBRIUM` (middle 10%, inclusive). `price == equilibrium ± band` => `EQUILIBRIUM`.

## 8. Assumptions

- Inputs are closed, chronological, unique-epoch candles.
- `SwingPoint.price` is the exact pivot price; `swingCandleEpoch` is the pivot candle.
- `MarketStructureState.breaks` are authoritative and `'NEUTRAL'`-seeded (no look-ahead).
- Anchoring epochs are unique per kind, so IDs are collision-free.
- `analyzedAt` is excluded from determinism assertions.
- No behavioral change to Phase 1 modules, candle aggregation, or websocket handling.

## 9. Test plan

- `test/liquidity.test.ts`: levels; sweep-on-rejection (buy/sell); touch not swept; close-through
  not swept; retained sweep; multi-level sweep; clustering + anchor split + exact-tolerance +
  no-emit for count-1; chronological sort independence; isolation.
- `test/fvg.test.ts`: bullish/bearish; size filter; no self-mitigation; full-fill boundary;
  inside-gap unmitigated; `unmitigatedCount`; isolation.
- `test/order-blocks.test.ts`: source selection; origin-bounded window; `W_MAX = 20` fallback +
  exact distance boundary; no-candle skip; dedupe; mitigation without invalidation; invalidation
  with mitigation; earlier mitigation timestamp preserved; both events same candle; invariant
  helper `!invalidated || mitigated`; sell-side symmetry; isolation.
- `test/premium-discount.test.ts`: three zones + both exact boundaries + missing-swing waiting +
  last-close price.
- `test/smc-engine.test.ts`: aggregate pair consistency; `zone` wiring; determinism (deep-equal
  minus `analyzedAt`); 2x2 isolation; closed-candle-only.

## 10. Validation

- `npx tsx --test` for `structure-breaks`, `market-structure`, `history-init`, `selection`,
  `history-recovery`, and all new Phase 2 test files.
- `npx tsc --noEmit`.
- `npm run build`.
- `test/verify-real-deriv-data.ts` is NOT run.
