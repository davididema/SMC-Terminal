# Phase 3 — Signal Engine Specification (PROPOSED, revised)

Status: **PROPOSED — decisions resolved; implementation is still NOT authorized.** Nothing below is
implemented and no code has been changed. Implementation requires separate authorization.

This revision resolves the nine review decisions, the required corrections (A–F), and the four
final-review points: trigger freshness (§4A5), opposing-zone conflict semantics (§4C6),
latest-trigger-only / no-fallback (§4D5), and duplicate-state mutation timing (§5.2). Where a rule
remains an explicit limitation rather than a decision, it is labeled **LIMITATION** and does not
block implementation.

## 0. Scope and non-goals

- In scope: a deterministic, explainable, analysis-only signal engine that consumes the existing
  `SMCAnalysisResult` plus a confirming closed candle, and returns `LONG`, `SHORT`, or `NO_TRADE`,
  with reasons and proposed parameters (entry / stop / target / R:R).
- Out of scope: order placement, account mutation, position sizing, broker/execution constraints,
  new market-structure or SMC computation, WebSocket/history/candle changes, symbol or timeframe
  changes, dependency changes.
- Phase 1 (market structure / BOS / CHoCH) and Phase 2 (liquidity / FVG / OB / premium-discount)
  methodology is **unchanged**. The engine only reads their outputs.

## 1. Current interface inventory (as-built)

### 1.1 `lib/signals/signal-engine.ts`

- `SignalDecision = 'NO_TRADE' | 'LONG' | 'SHORT'`.
- `SignalOutput` fields:
  - `decision: SignalDecision`
  - `confidence: number | null`
  - `setup: string`
  - `entry: number | null`
  - `stopLoss: number | null`
  - `takeProfit: number | null`
  - `riskReward: number | null`
  - `reason: string`
  - `timestamp: number` (currently `Math.floor(Date.now() / 1000)`)
- `class SignalEngine` currently exposes only `evaluate(analysis: SMCAnalysisResult): SignalOutput`,
  which unconditionally returns `NO_TRADE` with `reason: 'Waiting for market structure
  confirmation'`. There is **no state, no config, and no duplicate protection** yet.

Consumers:
- `app/dashboard/page.tsx:224` calls `signalEngineRef.current.evaluate(analysis)` **only inside the
  candle-close listener** (`app/dashboard/page.tsx:203-227`), immediately after `SMCEngine.analyze`
  on `getHistory(...)` (closed candles). It stores the result in `tradeSignal`.
- `components/SignalPanel.tsx` renders `confidence` as `` `${confidence}%` `` (so the score is
  expected to be 0–100), and `riskReward` as `` `1:${riskReward}` `` (so `riskReward` is the
  reward/risk multiple, e.g. `2.5` → `1:2.5`).

### 1.2 `SMCAnalysisResult` (the only analysis input to the engine)

`lib/analysis/smc.ts:9-18`:
```ts
interface SMCAnalysisResult {
  symbol: string;
  timeframe: Timeframe;
  marketStructure: MarketStructureState;
  liquidity: LiquidityState;
  fvg: FVGState;
  orderBlocks: OrderBlockState;
  zone: PremiumDiscountZone; // 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' | 'WAITING FOR DATA'
  analyzedAt: number;
}
```

### 1.3 Available fields the engine may read

Market structure (`lib/analysis/market-structure.ts:32-53`):
- `structuralBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'`
- `swings: SwingPoint[]` (`type`, `price`, `candleEpoch`, `swingCandleEpoch`, `confirmedAtEpoch`,
  `structureType`)
- `latestSwingHigh` / `latestSwingLow`, `latestHH/HL/LH/LL/EQH/EQL`
- `breaks: StructureBreak[]`, `latestBOS`, `latestCHoCH`
- `protectedHigh`, `protectedLow`

Structure breaks (`lib/analysis/structure-breaks.ts:12-24`):
- `type: 'BULLISH_BOS' | 'BEARISH_BOS' | 'BULLISH_CHOCH' | 'BEARISH_CHOCH' |
  'INITIAL_BULLISH_BREAK' | 'INITIAL_BEARISH_BREAK'`
- `direction`, `brokenPrice`, `breakCandleEpoch`, `brokenSwingEpoch`, `confirmationPrice`,
  `confirmedAtEpoch`, `id`
- Breaks are confirmed by closed candles only (`isClosed !== false`, `structure-breaks.ts:85-92`).
- In the current implementation `confirmedAtEpoch === breakCandleEpoch` and `brokenSwingEpoch` is
  the pivot candle that was broken (always earlier). See §4C.

Liquidity (`lib/analysis/liquidity.ts:9-35`):
- `buySideLiquidity` / `sellSideLiquidity: LiquidityLevel[]` with `price`, `epoch`, `swept: boolean`,
  `sweptEpoch?: number`
- `equalHighs` / `equalLows: EqualHighLow[]`
- `status: 'WAITING FOR DATA' | 'ACTIVE'`
- Sweep semantics are already Phase 2 sweep-on-rejection on closed candles
  (`liquidity.ts:124-142`): touch or close-through is **not** a sweep.

FVG (`lib/analysis/fvg.ts:4-21`):
- `bullishFVGs` / `bearishFVGs: FairValueGap[]` with `topPrice`, `bottomPrice`, `epoch`,
  `mitigated: boolean`, `mitigationEpoch?`
- `epoch` is the confirmation candle `c.epoch` (`fvg.ts:80`) — an exact confirmation timestamp.
- `unmitigatedCount`, `status`

Order blocks (`lib/analysis/order-blocks.ts:9-28`):
- `bullishOrderBlocks` / `bearishOrderBlocks: OrderBlock[]` with `high`, `low`, `epoch`,
  `mitigated`, `invalidated`, `mitigationEpoch?`, `invalidatedEpoch?`
- `epoch` is the **source candle** epoch, which predates the structural break (§4D). There is no
  confirmation epoch on the object.
- Invariant: `invalidated === true` implies `mitigated === true`.

### 1.4 Critical data gap — no price is exposed

`SMCAnalysisResult` does **not** expose any candle or the last closed price. The premium/discount
calculation reads the last closed close internally (`smc.ts:71-84`) but does not surface it. This is
resolved by the approved `SignalContext` (§3), not by changing `SMCAnalysisResult`.

## 2. Design principles (deterministic, explainable)

1. The engine consumes `SMCAnalysisResult`; it never recomputes swings, breaks, sweeps, FVG, or OB.
2. Only closed-candle-confirmed data qualifies. The engine rejects any candidate whose confirming
   candle `isClosed === false` (see §4D).
3. Identical inputs produce identical decisions, excluding explicitly documented timestamps.
4. Insufficient, missing, or contradictory evidence ⇒ `NO_TRADE`. Missing data never fabricates a
   signal.
5. No order placement, no account/position access, no side effects.
6. Every decision carries a human-readable `reason`; every `NO_TRADE` carries explicit rejection
   codes.
7. Comparison operators follow Phase 2: `<=` for tolerance/equality; strict `>` for
   "beyond tolerance".
8. Mandatory qualification gates are independent pass/fail predicates. The confluence score is
   informational only and can never override a failed mandatory gate.

## 3. Input extension — `SignalContext` (APPROVED)

The engine takes a context argument carrying the confirming closed candle. No Phase 2 change is
made.

```ts
interface SignalContext {
  lastClosedCandle: Candle; // must have isClosed !== false
}

evaluate(analysis: SMCAnalysisResult, context: SignalContext): SignalOutput
```

- `entry` reference `E` = `context.lastClosedCandle.close`.
- `signalEpoch` = `context.lastClosedCandle.epoch`; `timestamp = signalEpoch` (deterministic).
- If `context` is missing or `lastClosedCandle.isClosed === false` ⇒ `NO_TRADE`
  (`FORMING_CANDLE`).

## 4. Approved decisions and corrected rules

### 4.0 Resolved decision defaults

| # | Decision | Resolution |
|---|----------|------------|
| 1 | Entry reference | `SignalContext.lastClosedCandle`; do **not** extend `SMCAnalysisResult`. |
| 2 | Higher-timeframe confirmation | **Not required** in initial Phase 3; never fabricate HTF. |
| 3 | Freshness | `SWEEP_MAX_AGE_BARS = 10`; `MAX_ZONE_AGE_BARS = 50` (initial config defaults). |
| 3b | Trigger staleness | `TRIGGER_MAX_AGE_BARS = 50` (added in final review; see §4A5). |
| 4 | Premium/discount | LONG requires `DISCOUNT`; SHORT requires `PREMIUM`; `EQUILIBRIUM` never qualifies. |
| 5 | Risk parameters | `MIN_RISK_REWARD = 2.0`; `STOP_BUFFER_MULT = 1.0`; `MIN_STOP_TOLERANCE_MULT = 2.0`. |
| 6 | Timestamp | `timestamp = signalEpoch` (confirming closed candle's epoch). |
| 7 | Confidence | 0–100 heuristic confluence score with proposed weights; not a probability. |
| 8 | Continuation sweeps | Supporting only; fresh sweep mandatory for `SWEEP_REVERSAL`. |
| 9 | Zone location | Corrected inequalities per §4A (entry inside zone allowed). |

All freshness and risk values are initial configuration defaults, not claims of empirical optimality
or broker validation.

### A. Market bias, structural context, and triggers (correction F)

**A1. Event tiers.**
- **Actionable events** = `BULLISH_BOS`, `BEARISH_BOS`, `BULLISH_CHOCH`, `BEARISH_CHOCH`.
- **Non-actionable** = `INITIAL_BULLISH_BREAK`, `INITIAL_BEARISH_BREAK`.
- `latestActionable` = the actionable event with the greatest `confirmedAtEpoch`; tie-break
  `breakCandleEpoch` desc, then `id` lexicographic asc. `null` if none.

**A2. `INITIAL_*` handling (explicit).** `INITIAL_*` events are excluded from `latestActionable`.
They never establish directional context and never trigger a signal. A more recent `INITIAL_*` does
not override an older actionable event. **Justification:** `INITIAL_*` represents an unconfirmed
first break out of neutral; treating it as actionable would contradict Phase 1's own "unconfirmed
structure" semantics.

**A3. Context and setup from a single event.** Directional context and the setup classification come
from the same `latestActionable` event, so they can never disagree:
- If `latestActionable === null` ⇒ `NO_CONTEXT`.
- If `latestActionable.type` is a `*_CHOCH` ⇒ setup `SWEEP_REVERSAL`, intended direction =
  `latestActionable.direction`. `structuralBias` is **not** required to agree, because a CHoCH by
  construction reverses the prior structure and the swing-based bias may lag. This is the documented
  exception.
- If `latestActionable.type` is a `*_BOS` ⇒ setup `TREND_CONTINUATION`, intended direction =
  `latestActionable.direction`, and `structuralBias` **must equal** the intended direction, else
  `NO_CONTEXT`.

**A4. Higher timeframes (decision 2).** Phase 3 `evaluate` receives a single `(symbol, timeframe)`
analysis and does not require an HTF bias.
- The engine never fabricates, infers, or defaults an HTF bias.
- When HTF confirmation is introduced later, a separate multi-timeframe input will be required.
  Documented future behavior: all provided higher timeframes must agree with the intended direction;
  if any required HTF analysis is unavailable or disagrees ⇒ `NO_TRADE` (`HTF_UNAVAILABLE` /
  `NO_CONTEXT`). `HTF_UNAVAILABLE` is reserved for that future path and is not emitted by the
  initial implementation.

**A5. Trigger freshness / stale triggers (final-review correction 1).**

*Finding from the existing code.* `StructureBreakDetector.analyze`
(`lib/analysis/structure-breaks.ts:78-378`) and `MarketStructureAnalyzer.analyze`
(`lib/analysis/market-structure.ts:212-417`) are stateless per call and recompute `breaks` from the
supplied closed candles; no break carries an expiry. `latestBOS` / `latestCHoCH` and every entry in
`breaks` retain the most recent confirmed event indefinitely as long as those candles remain in
history (`CandleManager` trims only when history exceeds `maxHistory = 1000`,
`candles.ts:239-241`). Consequently `latestActionable` **can remain eligible indefinitely** when no
newer actionable event occurs. This is a genuine gap and is resolved here without changing Phase 1.

*Policy.* Add a deterministic staleness bound measured from the trigger's confirmation to the
signal candle:

```
trigger is fresh  ⇔  (signalEpoch - latestActionable.confirmedAtEpoch) <= TRIGGER_MAX_AGE_BARS * tfSeconds
```

- `TRIGGER_MAX_AGE_BARS = 50` (initial configuration default; equal to `MAX_ZONE_AGE_BARS`).
- A stale `latestActionable` ⇒ `NO_TRADE` (`STALE_TRIGGER`). This is a context-tier gate (§4G).
- `confirmedAtEpoch` is the closed candle that confirmed the break (not `brokenSwingEpoch`).

*Why this default (trade-off).* A stale trigger means the market has produced no actionable BOS/CHoCH
for more than the horizon while still offering a fresh zone near price; that regime is treated as
unconfirmed/range-bound, where a continuation signal would be unreliable. Aligning
`TRIGGER_MAX_AGE_BARS` with `MAX_ZONE_AGE_BARS = 50` keeps the trigger horizon at least as long as
the zone horizon, so a fresh zone cannot be paired with an arbitrarily old trigger. Trade-off:
lowering the value yields fewer, fresher signals but rejects valid pullbacks that occur deeper into a
trend; raising it admits more signals but reintroduces stale-trigger risk. The value is an initial
config default, not claimed to be empirically optimal or broker-validated, and is configurable.

*No Phase 1 change.* The detector's outputs are unchanged; the engine simply applies an additional
age predicate.

### B. Liquidity (correction C)

**B1. Sweep detection is delegated.** A "confirmed sweep" is exactly `level.swept === true` with
`sweptEpoch` set, as produced by Phase 2. The engine does not reinterpret touches or close-throughs.

**B2. Field semantics.**
- `sweptEpoch` = epoch of the closed candle on which the sweep-on-rejection occurred (Phase 2 sets
  it while scanning closed candles `epoch > level.epoch`, `liquidity.ts:124-142`).
- `brokenSwingEpoch` = epoch of the broken swing pivot. **It is not a confirmation timestamp** and
  is never used for freshness.
- `breakCandleEpoch` = epoch of the closed candle that confirmed the break.
- `confirmedAtEpoch` = when the break was confirmed (`=== breakCandleEpoch` in the current
  implementation).
- `signalEpoch` = `context.lastClosedCandle.epoch`.

**B3. Temporal constraints (using `tfSeconds = TIMEFRAME_SECONDS[timeframe]`).** Freshness is
measured relative to `signalEpoch` as "now".
- A sweep shall not occur after the signal candle: `sweptEpoch <= signalEpoch`.
- The setup trigger shall not be confirmed after the signal candle: `confirmedAtEpoch <= signalEpoch`.
- Sweep must fall within the configured freshness window:
  `(signalEpoch - sweptEpoch) <= SWEEP_MAX_AGE_BARS * tfSeconds`.
- `SWEEP_REVERSAL`: the sweep may precede the CHoCH. Required: `sweptEpoch <= confirmedAtEpoch`
  (sweep at or before the reversal confirmation) **and** the freshness window above. A reversal
  without a qualifying fresh sweep ⇒ `NO_TRADE` (`NO_FRESH_SWEEP`).
- `TREND_CONTINUATION`: a sweep is supporting only. If present and fresh it raises the confluence
  score; it can never create a signal by itself. Same temporal constraints
  (`sweptEpoch <= signalEpoch` and within window); if none qualifies, the continuation may still be
  evaluated on its other mandatory gates.
- If the required relationship cannot be established from the available data (e.g. missing
  `sweptEpoch`, `sweptEpoch > signalEpoch`, or `confirmedAtEpoch > signalEpoch`) ⇒ `NO_TRADE`
  rather than guessing.

**B4. Selection.** Among qualifying sweeps, choose the greatest `sweptEpoch`; tie-break `id`
lexicographic asc.

### C. Fair Value Gaps and Order Blocks (corrections A, D)

**C1. Usable zone.**
- Bullish/bearish FVG usable iff `mitigated === false`.
- Bullish/bearish OB usable iff `invalidated === false`.
- A mitigated-but-not-invalidated OB remains usable (its `mitigated` flag records the return/touch,
  which is the standard entry event); once `invalidated` it is retired. A fully-mitigated FVG is
  retired.

**C2. Zone location semantics (correction A).** Let `E = entry`, `tolE =
getSymbolEqualityTolerance(symbol, E)`, interval `[zoneLower, zoneUpper]` (FVG: `bottomPrice`,
`topPrice`; OB: `low`, `high`).
- **LONG eligibility:** `zoneLower <= E + tolE`. The zone may be entirely below `E`, may contain
  `E`, or may sit slightly (within `tolE`) above `E`.
- **SHORT eligibility:** `zoneUpper >= E - tolE`. The zone may be entirely above `E`, may contain
  `E`, or may sit slightly (within `tolE`) below `E`.
- **Exact-boundary behavior (inclusive):** for LONG, `zoneLower == E + tolE` is eligible;
  `zoneLower > E + tolE` is ineligible. For SHORT, `zoneUpper == E - tolE` is eligible;
  `zoneUpper < E - tolE` is ineligible.
- **Entry inside a zone is allowed.**

**C3. Zone-to-entry distance.** `d(zone, E) =`
- `0` if `zoneLower <= E <= zoneUpper` (entry inside the interval, including `E == zoneLower` or
  `E == zoneUpper`);
- `zoneLower - E` if `E < zoneLower`;
- `E - zoneUpper` if `E > zoneUpper`.

  Distance is always `>= 0`.

**C4. Freshness (correction D).**
- FVG: `fvg.epoch` is the confirmation candle, so FVG freshness is exact:
  `(signalEpoch - fvg.epoch) <= MAX_ZONE_AGE_BARS * tfSeconds`.
- **OB (LIMITATION).** `ob.epoch` is the source candle epoch and may predate the structural break
  that establishes the block; the type carries no confirmation epoch and no reliable reference to
  its originating break (the dedupe key is only `${type}:${sourceEpoch}`, and several breaks can map
  to the same source). Therefore Phase 3 **cannot** reliably associate an OB with its confirming
  break.
  - **Smallest safe handling now:** OB freshness is measured from `ob.epoch` and is explicitly
    documented as a **conservative source-age proxy** (a block may be rejected even if its
    confirming break is recent). This is never presented as confirmation age.
  - **Minimum additive data for exactness (future Phase 2 amendment only, not in this task):** add
    `OrderBlock.confirmedAtEpoch: number` (the originating break's confirmation epoch) or
    `OrderBlock.breakId: string`, populated by `OrderBlockAnalyzer`. Phase 3 would then use that
    field instead of `ob.epoch`. No Phase 2 code is modified now.
  - If the proxy window is exceeded, the OB is treated as stale (not eligible).

**C5. Selection among candidates.** Among fresh, eligible zones, choose minimal `d(zone, E)`;
tie-break newest `epoch`, then `id` lexicographic asc. At most one zone is attached to a signal.

**C6. Opposing-zone conflict semantics (final-review correction 2).** `CONFLICTING_ZONES` means the
**selected zone and an opposing zone overlap each other** (inflated by `tolE`); it does **not** mean
an opposing zone is merely near the entry. An opposing zone that is close to `E` but does not overlap
the selected zone is not a conflict.

*Definition.* A candidate opposing zone must be fresh and usable (§4C1, §4C4) and of the opposite
direction to the selected zone. For selected interval `[sL, sU]` and opposing interval `[oL, oU]`,
they conflict iff:

```
sL <= oU + tolE   AND   oL <= sU + tolE
```

Equivalently: the two intervals overlap after expanding each by `tolE` in both directions; a gap of
`<= tolE` between them counts as a conflict, and a gap `> tolE` does not. Boundary is inclusive at
exactly `tolE`.

*Examples* (LONG selected bullish zone `[1.0950, 1.1000]`, `tolE = 0.0005`):
- Overlapping: opposing bearish `[1.0980, 1.1020]` ⇒ `1.0950 <= 1.1020+0.0005` and
  `1.0980 <= 1.1000+0.0005` ⇒ **`CONFLICTING_ZONES`**.
- Touching within tolerance: opposing bearish `[1.1005, 1.1040]` (gap `0.0005 == tolE`) ⇒ conflict.
- Non-overlapping: opposing bearish `[1.1006, 1.1040]` (gap `0.0006 > tolE`) ⇒ no conflict; the
  bullish setup may proceed.
- Near entry but non-overlapping: opposing bearish `[1.1006, 1.1040]` sitting just above `E` ⇒ no
  conflict by itself (only the overlap predicate applies; entry proximity alone is insufficient).
- If multiple opposing zones exist, `CONFLICTING_ZONES` is reported if **any** fresh, usable
  opposing zone satisfies the predicate.

Remaining sub-rules:
- If no fresh usable zone exists at all ⇒ `NO_ELIGIBLE_ZONE`.
- If fresh usable zones exist but all are on the wrong side beyond tolerance ⇒ `ZONE_MISALIGNED`.
- Zones are never merged, resized, or fabricated. Phase 2 zone calculations are unchanged.

### D. Entry confirmation

**D1. Setup classification.** Determined by `latestActionable` per §4A3:
- `SWEEP_REVERSAL` (trigger `*_CHOCH`), or
- `TREND_CONTINUATION` (trigger `*_BOS`).
- `INITIAL_*` never triggers.

**D2. LONG conditions (all mandatory, independent).**
1. Intended direction `BULLISH` (§4A3).
2. `latestActionable` is fresh (§4A5), else `STALE_TRIGGER`.
3. For `TREND_CONTINUATION`: `structuralBias === 'BULLISH'`.
4. For `SWEEP_REVERSAL`: a fresh swept `SELL_SIDE` level (§4B).
5. An eligible, fresh bullish zone satisfying §4C2–C5.
6. Premium/discount passes: `zone === 'DISCOUNT'` (decision 4).
7. Valid stop and target computable with `riskReward >= MIN_RISK_REWARD` (§4E).
8. Not a duplicate (§4F).
Any failure ⇒ `NO_TRADE` with the applicable rejection codes (§4G).

**D3. SHORT conditions.** Symmetric: intended direction `BEARISH`; `latestActionable` fresh;
continuation requires `structuralBias === 'BEARISH'`; reversal requires a fresh swept `BUY_SIDE`;
eligible fresh bearish zone; `zone === 'PREMIUM'`; valid stop/target/R:R; not a duplicate.

**D5. Latest-trigger-only policy (final-review correction 3, no fallback).** The engine evaluates
**only** `latestActionable` as resolved by the deterministic ordering in §4A1
(`confirmedAtEpoch` desc, `breakCandleEpoch` desc, `id` asc). It never scans `breaks` for an older
BOS/CHoCH alternative. If `latestActionable` fails any mandatory gate — context, freshness, trigger
type/direction, zone, sweep, stop, target, R:R, or duplicate — the result is `NO_TRADE` for that
evaluation. The engine must not fall back to an older actionable event, and the setup classification
(`SWEEP_REVERSAL` vs `TREND_CONTINUATION`) is fixed by `latestActionable.type` for that evaluation.

*Consistency with selection behavior.* Intended direction, setup type, trigger-freshness, and the
trigger-freshness window all derive from the same `latestActionable`. Zone selection (§4C), sweep
selection (§4B), and target selection (§4F) all operate under that fixed direction and trigger except
where §4B explicitly permits a reversal sweep before the CHoCH or a supporting continuation sweep.
There is no code path that re-derives direction or setup from an older break, so no silent fallback is
possible.

**D4. Confirmation integrity.**
- Confirmation originates only from closed-candle data: break events (`confirmedAtEpoch`), sweep
  events (`sweptEpoch`), and the supplied `lastClosedCandle` (`isClosed !== false`).
- A signal's `signalEpoch` is the confirming candle epoch; `timestamp = signalEpoch`.

### E. Premium and discount (decision 4)

- Phase 2's zone calculation is **not modified**; only `SMCAnalysisResult.zone` is read.
- LONG requires `zone === 'DISCOUNT'`.
- SHORT requires `zone === 'PREMIUM'`.
- `zone === 'EQUILIBRIUM'` **does not qualify** in the initial configuration.
- `zone === 'WAITING FOR DATA'` ⇒ `NO_TRADE` (`ZONE_UNAVAILABLE`); it never defaults to a direction.

### F. Stop-loss, take-profit, and risk-to-reward (decisions 5)

All computed prices are analysis references only. The spec does **not** assert they are executable
and assumes no broker constraints (spread, slippage, minimum stop distance, etc.). Let
`E = entry`, `tolE = getSymbolEqualityTolerance(symbol, E)`.

**F1. Stop-loss (LONG).**
- Structural invalidation candidates below `E`: `structure.protectedLow?.price`, the selected zone's
  `zoneLower`, and the selected swept level's `price` (if below `E`).
- `rawSL = min(candidates)`; `stopLoss = rawSL - STOP_BUFFER_MULT * tolE`.
- SHORT symmetric: candidates above `E` (`protectedHigh`, `zoneUpper`, swept level);
  `rawSL = max(candidates)`; `stopLoss = rawSL + STOP_BUFFER_MULT * tolE`.

**F2. Invalid / zero-distance stops.**
- No applicable candidate ⇒ `SL_UNRESOLVED`.
- `E - stopLoss <= MIN_STOP_TOLERANCE_MULT * tolE` (LONG) or
  `stopLoss - E <= MIN_STOP_TOLERANCE_MULT * tolE` (SHORT) ⇒ `SL_TOO_TIGHT`.
  `MIN_STOP_TOLERANCE_MULT = 2.0`, `STOP_BUFFER_MULT = 1.0`.

**F3. Take-profit (LONG).**
- Target candidates above `E`, ascending by distance:
  1. unswept `buySideLiquidity` levels (`swept === false`) with `price > E + tolE`;
  2. opposing structural highs: `latestSwingHigh?.price`, `protectedHigh?.price`, and `brokenPrice`
     of bullish breaks, all `> E + tolE`.
- Walk ascending; select the first target with
  `riskReward = (target - E) / (E - stopLoss) >= MIN_RISK_REWARD`.
- SHORT symmetric using unswept `sellSideLiquidity` and opposing structural lows.
- No synthetic/pip-based target is fabricated.

**F4. Minimum R:R.** `MIN_RISK_REWARD = 2.0`. `riskReward` is emitted at full floating-point
precision as reward/risk (UI renders `1:R`).

### G. Rejection codes and deterministic ordering (correction E)

```ts
export type SignalRejectionCode =
  | 'INSUFFICIENT_DATA'
  | 'FORMING_CANDLE'
  | 'HTF_UNAVAILABLE'   // reserved; not emitted by initial implementation
  | 'NO_CONTEXT'
  | 'STALE_TRIGGER'
  | 'ZONE_UNAVAILABLE'
  | 'NO_ELIGIBLE_ZONE'
  | 'ZONE_MISALIGNED'
  | 'CONFLICTING_ZONES'
  | 'NO_FRESH_SWEEP'
  | 'SL_UNRESOLVED'
  | 'SL_TOO_TIGHT'
  | 'NO_TARGET'
  | 'RR_BELOW_MIN'
  | 'DUPLICATE';
```

**G1. Gate tiers (evaluation order).**
1. **Tier 0 — preconditions (single):** `FORMING_CANDLE`, `INSUFFICIENT_DATA`.
2. **Tier 1 — context / trigger (single):** `NO_CONTEXT`, `STALE_TRIGGER`. `NO_CONTEXT` is reported
   first if context cannot be resolved; otherwise `STALE_TRIGGER` may be reported for a resolved but
   stale `latestActionable`.
3. **Tier 2 — zone + sweep (collect all applicable):** `ZONE_UNAVAILABLE`, `NO_ELIGIBLE_ZONE`,
   `ZONE_MISALIGNED`, `CONFLICTING_ZONES`, `NO_FRESH_SWEEP`.
4. **Tier 3 — stop (single):** `SL_UNRESOLVED`, `SL_TOO_TIGHT`.
5. **Tier 4 — target (single, mutually exclusive):** `NO_TARGET`, `RR_BELOW_MIN`.
6. **Tier 5 — duplicate (single):** `DUPLICATE`.

**G2. Collection policy.** The engine reports the codes of the **first blocking tier** and stops;
tiers whose inputs are not evaluable (because an earlier hard gate failed) are omitted. Tier 2 may
contain multiple independently-failing codes and returns all of them in the fixed order above. Tier
0 is a hard stop; Tier 1 is a hard stop.

**G3. `NO_TARGET` vs `RR_BELOW_MIN` (mutually exclusive).**
- `NO_TARGET`: the valid opposing target candidate set is empty.
- `RR_BELOW_MIN`: at least one valid target exists, but none yields
  `riskReward >= MIN_RISK_REWARD`.

**G4. `reason` and primary code.** `reason` names the first code in evaluation order;
`rejectionReasons` lists the collected codes in that order.

### H. Signal output interface

Smallest justified interface changes:

```ts
export type SignalDecision = 'NO_TRADE' | 'LONG' | 'SHORT';

export type SignalSetup =
  | 'SWEEP_REVERSAL'
  | 'TREND_CONTINUATION'
  | 'NONE';

export interface SignalOutput {
  decision: SignalDecision;
  confidence: number | null;      // 0..100 heuristic confluence score (NOT a probability)
  setup: string;                  // SignalSetup value; 'NONE' on NO_TRADE (kept string for UI)
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  reason: string;
  timestamp: number;              // = signalEpoch (deterministic)
  // proposed additive fields:
  signalEpoch?: number;
  triggerId?: string;
  confluenceBreakdown?: string[];
  rejectionReasons?: SignalRejectionCode[];
}
```

**H1. Confidence / confluence (decision 7).** `confidence` is an **integer 0–100 heuristic
confluence score, not a calibrated probability**, documented as such in code and UI. Proposed
additive weights (initial): context agreement 30, trigger quality (CHoCH 25 / BOS 20), fresh sweep
20, eligible unmitigated zone 15, premium/discount alignment 10; sum capped at 100. On `NO_TRADE`,
`confidence = null`. The score never overrides a failed mandatory gate, and a score/reason change
alone never creates a new setup.

**Context-factor clarification (Stage 3).** The 30-point "context agreement" factor refers strictly
to the Stage 2 directional-context gate having **passed** for the selected `latestActionable`
trigger (§4A3) — i.e. `resolveTrigger` succeeded. It is **not** an additional, independent
confirmation of the broader market trend. No new `structuralBias` requirement is introduced:
CHoCH reversals still do not require bias agreement, and BOS continuations still require
`structuralBias === direction` (§4A3, unchanged).

## 5. Duplicate prevention (correction B)

**5.1 Setup identity.** `identity = `${symbol}:${timeframe}:${triggerId}:${selectedZoneId}``.
It is a pure function of inputs and excludes score, reason, `timestamp`, and `analyzedAt`.

**5.2 Policy and mutation timing (final-review correction 4).**
- Maintain per-pair consumed identities: `Map<string, Set<string>>` keyed `symbol:timeframe`.
- **An identity is added to the consumed set only after every mandatory qualification gate has passed
  and a `LONG` or `SHORT` signal is actually emitted.** The mutation happens at the end of a
  successful evaluation, immediately before the `SignalOutput` is returned.
- Candidates rejected by any mandatory gate — context/`NO_CONTEXT`, `STALE_TRIGGER`,
  `ZONE_UNAVAILABLE`, `NO_ELIGIBLE_ZONE`, `ZONE_MISALIGNED`, `CONFLICTING_ZONES`, `NO_FRESH_SWEEP`,
  `SL_UNRESOLVED`, `SL_TOO_TIGHT`, `NO_TARGET`, `RR_BELOW_MIN`, or any precondition — **must not**
  consume an identity and must not mutate engine state.
- A candidate whose identity is already consumed remains `NO_TRADE` with `DUPLICATE` and does not
  mutate state (the identity is already present; no change).
- A new trigger (`triggerId` differs) yields a new identity and may qualify independently.
- A new sweep **alone does not** re-arm an already consumed trigger/zone combination.
- A changed confluence score or updated reason text does **not** create a new identity.
- Different `selectedZoneId` with the same trigger is a new identity and may qualify.

*Evaluation order.* Duplicate check is the last gate (Tier 5). All earlier gates are evaluated on the
candidate regardless of whether its identity is already consumed; the duplicate gate only suppresses
an otherwise fully-qualified signal. Because the duplicate check is last, a rejected candidate never
consumes an identity and a duplicate-rejected candidate leaves state unchanged.

**5.3 State and reset.** Required state per pair: `consumedIdentities: Set<string>`, keyed by
`symbol:timeframe`.
`clear(symbol?, timeframe?)`:
- both given → delete that pair's state;
- only symbol → delete all timeframes for that symbol;
- neither → clear all state.
This mirrors `MarketStructureAnalyzer.clear` (`market-structure.ts:424-433`).

## 6. Determinism and safety

- The engine consumes existing analysis results and never recomputes market structure.
- Only closed candles confirm a setup (Phase 2 outputs are closed-candle-only; `lastClosedCandle` is
  validated).
- Identical `(analysis, context, config, engine-state)` produce an identical `SignalOutput`;
  `timestamp = signalEpoch` is deterministic. No wall-clock value participates.
- Insufficient or contradictory evidence ⇒ `NO_TRADE`. Missing data never creates a signal.
- The engine does not place orders, read balances, mutate accounts, or perform network I/O.
- No `any`, no `@ts-ignore`, no type-check weakening.
- Phase 1 and Phase 2 logic and outputs remain unchanged. The only intended dashboard change
  (implementation phase) is passing the already-available confirming candle.

## 7. Testing plan

All pure-engine tests live in `test/signal-engine.test.ts` and build `SMCAnalysisResult`/`SignalContext`
inputs as literals (mirroring `test/liquidity.test.ts` / `test/order-blocks.test.ts` helpers).
Dashboard integration checks are separate (§7.2).

### 7.1 Pure signal-engine unit tests

- **Bias / context:** valid BULLISH `TREND_CONTINUATION` and BEARISH reversal; `NEUTRAL` ⇒
  `NO_CONTEXT`; `latestActionable === null` ⇒ `NO_CONTEXT`; continuation with
  `structuralBias` contradicting the BOS ⇒ `NO_CONTEXT`; reversal (`*_CHOCH`) with a lagging
  opposite `structuralBias` is allowed; `INITIAL_*`-only ⇒ `NO_CONTEXT`; a recent `INITIAL_*` does
  not override an older actionable event.
- **Valid LONG / SHORT:** full confluence ⇒ correct decision, setup, entry/stop/target/R:R.
- **Missing data:** empty breaks/swings/liquidity/zone ⇒ `NO_TRADE`, no throw, `confidence` null.
- **Forming candle:** `lastClosedCandle.isClosed === false` and missing context ⇒ `FORMING_CANDLE`.
- **Zone location (correction A):** LONG zone below entry; LONG entry inside zone (distance 0);
  LONG zone entirely above beyond tolerance ⇒ ineligible (`ZONE_MISALIGNED`); exact boundary
  `zoneLower == E + tolE` eligible; `zoneLower == E + tolE + ε` ineligible; symmetric SHORT cases;
  deterministic selection tie-breaks (distance, then newest epoch, then id).
- **Sweep association (correction C):** sweep after `signalEpoch` ⇒ `NO_FRESH_SWEEP`; sweep before
  a CHoCH allowed; sweep older than the window ⇒ `NO_FRESH_SWEEP`; missing `sweptEpoch` ⇒
  `NO_FRESH_SWEEP`; continuation with no sweep still evaluates other gates; continuation sweep
  cannot create a signal by itself.
- **Zone eligibility:** mitigated FVG (direction) ⇒ `NO_ELIGIBLE_ZONE`; invalidated OB ⇒
  `NO_ELIGIBLE_ZONE`; OB freshness uses `ob.epoch` proxy (documented conservative) while FVG
  freshness uses confirmation `epoch`.
- **Trigger freshness:** `latestActionable` older than `TRIGGER_MAX_AGE_BARS * tfSeconds` ⇒
  `STALE_TRIGGER`; exactly at the boundary (`== TRIGGER_MAX_AGE_BARS * tfSeconds`) asserted as fresh
  (inclusive); a resolved fresh trigger passes this gate.
- **Opposing-zone conflict semantics:** overlapping intervals ⇒ `CONFLICTING_ZONES`; gap exactly
  `tolE` ⇒ `CONFLICTING_ZONES`; gap `> tolE` ⇒ no conflict; an opposing zone merely near `E` but not
  overlapping the selected zone ⇒ no conflict; multiple opposing zones conflict if any one overlaps;
  a stale/mitigated/invalidated opposing zone does not cause a conflict.
- **Latest-trigger-only / no fallback:** with a stale or failing `latestActionable` and an older
  qualifying BOS present, the engine returns `NO_TRADE` and never falls back to the older event;
  setup classification follows `latestActionable.type` only.
- **Premium/discount:** LONG in `PREMIUM`, SHORT in `DISCOUNT`, both directions in `EQUILIBRIUM` ⇒
  `ZONE_UNAVAILABLE`/no-signal as specified; `WAITING FOR DATA` ⇒ `ZONE_UNAVAILABLE`.
- **Stop/target:** no invalidation candidate ⇒ `SL_UNRESOLVED`; distance `<= MIN_STOP_TOLERANCE_MULT
  * tolE` ⇒ `SL_TOO_TIGHT`; exact boundary distance `== MIN_STOP_TOLERANCE_MULT * tolE` asserted;
  empty target set ⇒ `NO_TARGET`; targets exist but all below `MIN_RISK_REWARD` ⇒ `RR_BELOW_MIN`.
- **Rejection ordering (correction E):** assert the exact returned code set per tier; assert Tier 2
  returns all applicable codes; assert `NO_TARGET` and `RR_BELOW_MIN` are mutually exclusive.
- **Duplicate prevention (correction B):** same trigger+zone emits once then `DUPLICATE`; different
  trigger qualifies; newer sweep with the same consumed trigger does not re-arm; changed
  score/reason does not create a duplicate; `clear` resets suppression at all three levels.
- **Duplicate-state mutation timing (correction 4):** a candidate rejected before emission (any
  mandatory gate, including `STALE_TRIGGER`, `NO_FRESH_SWEEP`, `SL_TOO_TIGHT`, `RR_BELOW_MIN`) leaves
  the consumed set unchanged and can still emit on a later evaluation if the gates then pass; only an
  actual `LONG`/`SHORT` emission adds the identity; a `DUPLICATE` result does not mutate state.
- **Determinism:** two identical calls yield deep-equal output.
- **Isolation:** state and results keyed by `symbol:timeframe`; no leakage across `EURUSD:1m`,
  `EURUSD:5m`, `GBPUSD:1m`.

### 7.2 Dashboard integration (separate, manual/optional)

- Verify `evaluate` is called only on candle close with the confirming candle; verify `SignalPanel`
  renders `confidence`, `setup`, `entry`, `stopLoss`, `takeProfit`, `riskReward`, `reason` (and
  proposed `rejectionReasons`) without regressions.
- No integration test file is proposed until the interface change is authorized.

Validation commands (authorized implementation only):
- `npx tsx test/signal-engine.test.ts`
- `npx tsc --noEmit`
- `npm run build`
- `test/verify-real-deriv-data.ts` is **not** run.

## 8. Staged implementation plan (subsequent phase, after authorization)

- **Stage 1 — Types/config:** `SignalSetup`, `SignalRejectionCode`, revised `SignalOutput`,
  `SignalContext`, `SignalEngineConfig`, immutable defaults (`SWEEP_MAX_AGE_BARS=10`,
  `MAX_ZONE_AGE_BARS=50`, `TRIGGER_MAX_AGE_BARS=50`, `MIN_RISK_REWARD=2.0`,
  `STOP_BUFFER_MULT=1.0`, `MIN_STOP_TOLERANCE_MULT=2.0`). No logic.
- **Stage 2 — Pure helpers:** context/`latestActionable` resolution with trigger-freshness
  (`STALE_TRIGGER`), fresh-sweep selector with the §4B temporal constraints, zone selector with §4C
  location/distance/freshness and the §4C6 opposing-overlap predicate, premium/discount filter,
  SL/TP/RR calculator, confluence scorer. Unit-test each.
- **Stage 3 — Orchestrator:** `evaluate(analysis, context)` composing helpers, tiered rejection
  collection, per-pair duplicate state, `clear`. Complete `test/signal-engine.test.ts`.
- **Stage 4 — Integration:** pass the confirming candle from `app/dashboard/page.tsx`; update
  `SignalPanel` only for approved additive fields.
- **Stage 5 — Validation:** `npx tsx test/signal-engine.test.ts`, `npx tsc --noEmit`,
  `npm run build`.

Each stage stops for review. No stage may alter Phase 1/Phase 2 modules.

## 9. Remaining blockers and known limitations

- **No decision remains that blocks implementation.** All nine decisions plus the four final-review
  corrections (trigger freshness, conflict semantics, latest-trigger-only, duplicate-state mutation)
  are resolved above.
- **Config default, not a claim:** `TRIGGER_MAX_AGE_BARS = 50` is an initial configuration default
  chosen to match `MAX_ZONE_AGE_BARS`; its effect and trade-off are documented in §4A5. It is not
  empirically optimized.
- **LIMITATION — OB confirmation age:** Order Blocks expose only the source-candle `epoch`, with no
  reliable association to their originating break. Phase 3 v1 uses `ob.epoch` as a documented
  conservative source-age proxy. Exact OB freshness requires a future, separately authorized Phase 2
  amendment adding `OrderBlock.confirmedAtEpoch` (or `breakId`). Phase 2 is not modified now.
- **LIMITATION — HTF:** higher-timeframe confirmation is deferred; the engine must never fabricate
  HTF data. `HTF_UNAVAILABLE` is reserved for a future multi-timeframe input path.
- **Not a claim:** freshness and risk constants are initial configuration defaults, not empirically
  optimized or broker-validated values.

## 10. Deliverable summary

1. **Nine decisions and defaults:** `SignalContext.lastClosedCandle` (1); HTF not required (2);
   `SWEEP_MAX_AGE_BARS=10`, `MAX_ZONE_AGE_BARS=50`, `TRIGGER_MAX_AGE_BARS=50` (3, 3b);
   LONG=`DISCOUNT`, SHORT=`PREMIUM`, `EQUILIBRIUM` never qualifies (4); `MIN_RISK_REWARD=2.0`,
   `STOP_BUFFER_MULT=1.0`, `MIN_STOP_TOLERANCE_MULT=2.0` (5); `timestamp=signalEpoch` (6); 0–100
   heuristic score (7); continuation sweeps supporting-only (8); corrected zone location (9).
2. **Corrected inequalities/boundaries:** LONG `zoneLower <= E + tolE`; SHORT
   `zoneUpper >= E - tolE`; distance `0` inside the interval, else nearest boundary; inclusive
   exact boundaries (§4C2–C3).
3. **Sweep association/freshness:** semantics of all epochs, `sweptEpoch <= signalEpoch`, sweep
   before a CHoCH allowed, window `<= SWEEP_MAX_AGE_BARS * tfSeconds`, rewound to
   `signalEpoch` (§4B).
4. **OB freshness:** source-age proxy documented; exact handling requires an additive Phase 2 field;
   no Phase 2 change now (§4C4, §9).
5. **Duplicate policy:** identity `symbol:timeframe:triggerId:zoneId`; suppress repeats; new trigger
   may qualify; new sweep alone does not re-arm; score/reason do not affect identity; `clear`
   three-level reset (§5).
6. **Rejection behavior:** fixed tier order, first blocking tier reported, Tier 2 may return
   multiple codes, `NO_TARGET` xor `RR_BELOW_MIN` (§4G).
7. **Final-review resolutions:** (1) trigger freshness `TRIGGER_MAX_AGE_BARS=50` + `STALE_TRIGGER`
   (§4A5); (2) `CONFLICTING_ZONES` = selected/opposing zone interval overlap inflated by `tolE`, not
   mere entry proximity, with inclusive `tolE` boundary and examples (§4C6); (3) latest-trigger-only,
   no fallback to older BOS/CHoCH (§4D5); (4) duplicate identity added only on actual `LONG`/`SHORT`
   emission; rejected candidates never consume, duplicate stays `NO_TRADE` (§5.2).
8. **Unresolved blockers:** none; two documented limitations (OB confirmation age, deferred HTF).
