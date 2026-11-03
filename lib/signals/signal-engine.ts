import { Candle, Timeframe, TIMEFRAME_SECONDS } from '../deriv/candles';
import { SMCAnalysisResult, PremiumDiscountZone } from '../analysis/smc';
import { StructuralBias, getSymbolEqualityTolerance } from '../analysis/market-structure';
import { BreakType, StructureBreak } from '../analysis/structure-breaks';
import { FVGState } from '../analysis/fvg';
import { OrderBlockState } from '../analysis/order-blocks';
import { LiquidityLevel } from '../analysis/liquidity';

export type SignalDecision = 'NO_TRADE' | 'LONG' | 'SHORT';

/** Intended trade direction derived from the latest actionable structure event. */
export type SignalDirection = 'BULLISH' | 'BEARISH';

/**
 * Setup classification produced by the Phase 3 signal engine.
 * - SWEEP_REVERSAL: confirmed by a Change of Character (CHoCH) plus a fresh opposing sweep.
 * - TREND_CONTINUATION: confirmed by a Break of Structure (BOS); sweeps are supporting only.
 * - NONE: no setup (used when the decision is NO_TRADE).
 */
export type SignalSetup = 'SWEEP_REVERSAL' | 'TREND_CONTINUATION' | 'NONE';

/**
 * Deterministic NO_TRADE rejection codes. Reported from the first blocking gate tier
 * in the ordering defined in docs/PHASE3_SIGNAL_SPEC.md §4G.
 */
export type SignalRejectionCode =
  | 'INSUFFICIENT_DATA'
  | 'FORMING_CANDLE'
  | 'HTF_UNAVAILABLE'
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

export interface SignalOutput {
  decision: SignalDecision;
  /**
   * Heuristic confluence score on an integer 0-100 scale.
   * This is NOT a calibrated probability and must never be presented as one.
   * `null` whenever the decision is NO_TRADE.
   */
  confidence: number | null;
  /** SignalSetup value; `'NONE'` on NO_TRADE. Declared as string for UI compatibility. */
  setup: string;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  reason: string;
  /** Deterministic signal timestamp: the confirming closed candle's epoch (signalEpoch). */
  timestamp: number;
  /** Additive Phase 3 fields, populated by later stages. */
  signalEpoch?: number;
  triggerId?: string;
  /**
   * Engine-authoritative signal identity, exactly
   * `${symbol}:${timeframe}:${triggerId}:${selectedZoneId}`.
   *
   * Present only on a genuine LONG/SHORT emission and constructed from the exact same
   * string the engine records in `consumedIdentities` (spec §5.1). Consumers (e.g.
   * notification delivery) must use this value rather than reconstruct an equivalent one.
   */
  signalId?: string;
  confluenceBreakdown?: string[];
  rejectionReasons?: SignalRejectionCode[];
}

/**
 * Input context for the signal engine (approved specification §3).
 * Carries the confirming candle; the entry reference is `lastClosedCandle.close`.
 */
export interface SignalContext {
  lastClosedCandle: Candle;
}

/**
 * Configurable analysis defaults (approved specification §4.0).
 * All values are initial configuration defaults, not empirically optimal or broker-validated.
 */
export interface SignalEngineConfig {
  SWEEP_MAX_AGE_BARS: number;
  MAX_ZONE_AGE_BARS: number;
  TRIGGER_MAX_AGE_BARS: number;
  MIN_RISK_REWARD: number;
  STOP_BUFFER_MULT: number;
  MIN_STOP_TOLERANCE_MULT: number;
}

export const DEFAULT_SIGNAL_ENGINE_CONFIG: Readonly<SignalEngineConfig> = Object.freeze({
  SWEEP_MAX_AGE_BARS: 10,
  MAX_ZONE_AGE_BARS: 50,
  TRIGGER_MAX_AGE_BARS: 50,
  MIN_RISK_REWARD: 2.0,
  STOP_BUFFER_MULT: 1.0,
  MIN_STOP_TOLERANCE_MULT: 2.0,
});

// --- Stage 2: trigger selection, context, freshness, confluence -------------------------------

/**
 * Actionable structure events (spec §4A1). `INITIAL_*` events are deliberately excluded:
 * they never establish context and never trigger a signal (spec §4A2).
 */
const ACTIONABLE_BREAK_TYPES: ReadonlySet<BreakType> = new Set<BreakType>([
  'BULLISH_BOS',
  'BEARISH_BOS',
  'BULLISH_CHOCH',
  'BEARISH_CHOCH',
]);

/** True for actionable BOS/CHoCH events; false for `INITIAL_*` events. */
export function isActionableBreak(type: BreakType): boolean {
  return ACTIONABLE_BREAK_TYPES.has(type);
}

/**
 * Deterministic selection of `latestActionable` (spec §4A1):
 * greatest `confirmedAtEpoch`; tie-break `breakCandleEpoch` descending, then `id` ascending.
 * Returns `null` when no actionable event exists. This is the ONLY trigger source — the engine
 * never scans for an older alternative (latest-trigger-only, spec §4D5).
 */
export function selectLatestActionableBreak(
  breaks: readonly StructureBreak[]
): StructureBreak | null {
  const actionable = breaks.filter((b) => ACTIONABLE_BREAK_TYPES.has(b.type));
  if (actionable.length === 0) {
    return null;
  }
  const sorted = [...actionable].sort((a, b) => {
    if (b.confirmedAtEpoch !== a.confirmedAtEpoch) {
      return b.confirmedAtEpoch - a.confirmedAtEpoch;
    }
    if (b.breakCandleEpoch !== a.breakCandleEpoch) {
      return b.breakCandleEpoch - a.breakCandleEpoch;
    }
    if (a.id === b.id) {
      return 0;
    }
    return a.id < b.id ? -1 : 1;
  });
  return sorted[0];
}

/** True when the trigger is a CHoCH (reversal); false when it is a BOS (continuation). */
export function getTriggerKind(trigger: StructureBreak): 'CHOCH' | 'BOS' {
  return trigger.type === 'BULLISH_CHOCH' || trigger.type === 'BEARISH_CHOCH' ? 'CHOCH' : 'BOS';
}

/** Directional context resolved from a single actionable event (spec §4A3). */
export interface DirectionalContext {
  valid: boolean;
  setup: SignalSetup;
  direction: SignalDirection | null;
}

/**
 * Resolves direction and setup from `latestActionable` alone (spec §4A3):
 * - `null` ⇒ invalid (`NO_CONTEXT`).
 * - `*_CHOCH` ⇒ `SWEEP_REVERSAL`; `structuralBias` is NOT required to agree (documented exception).
 * - `*_BOS` ⇒ `TREND_CONTINUATION`; requires `structuralBias === direction`, else invalid.
 */
export function resolveDirectionalContext(
  latestActionable: StructureBreak | null,
  structuralBias: StructuralBias
): DirectionalContext {
  if (!latestActionable) {
    return { valid: false, setup: 'NONE', direction: null };
  }

  const direction: SignalDirection = latestActionable.direction;

  if (getTriggerKind(latestActionable) === 'CHOCH') {
    return { valid: true, setup: 'SWEEP_REVERSAL', direction };
  }

  if (structuralBias === direction) {
    return { valid: true, setup: 'TREND_CONTINUATION', direction };
  }

  return { valid: false, setup: 'NONE', direction: null };
}

/**
 * Trigger freshness (spec §4A5): the trigger is fresh iff it was confirmed at or before the
 * signal candle and its age does not exceed `TRIGGER_MAX_AGE_BARS` bars of the analysis timeframe.
 * Boundary is inclusive. `confirmedAtEpoch` (not `brokenSwingEpoch`) is the confirmation time.
 */
export function isTriggerFresh(
  trigger: StructureBreak,
  signalEpoch: number,
  timeframe: Timeframe,
  config: Readonly<SignalEngineConfig> = DEFAULT_SIGNAL_ENGINE_CONFIG
): boolean {
  if (trigger.confirmedAtEpoch > signalEpoch) {
    return false;
  }
  const windowSeconds = config.TRIGGER_MAX_AGE_BARS * TIMEFRAME_SECONDS[timeframe];
  return signalEpoch - trigger.confirmedAtEpoch <= windowSeconds;
}

/** Result of the Stage 2 trigger resolution. */
export interface TriggerResolution {
  ok: boolean;
  /** `'NO_CONTEXT'` or `'STALE_TRIGGER'` when `ok` is false; otherwise `null`. */
  rejection: SignalRejectionCode | null;
  trigger: StructureBreak | null;
  setup: SignalSetup;
  direction: SignalDirection | null;
}

/**
 * Composes the Stage 2 trigger gates in the approved tier order (spec §4G):
 * context first (`NO_CONTEXT`), then freshness (`STALE_TRIGGER`). Evaluates only
 * `latestActionable`; never falls back to an older event (spec §4D5).
 */
export function resolveTrigger(
  breaks: readonly StructureBreak[],
  structuralBias: StructuralBias,
  signalEpoch: number,
  timeframe: Timeframe,
  config: Readonly<SignalEngineConfig> = DEFAULT_SIGNAL_ENGINE_CONFIG
): TriggerResolution {
  const trigger = selectLatestActionableBreak(breaks);
  const context = resolveDirectionalContext(trigger, structuralBias);

  if (!context.valid || !trigger) {
    return {
      ok: false,
      rejection: 'NO_CONTEXT',
      trigger: null,
      setup: 'NONE',
      direction: null,
    };
  }

  if (!isTriggerFresh(trigger, signalEpoch, timeframe, config)) {
    return {
      ok: false,
      rejection: 'STALE_TRIGGER',
      trigger,
      setup: context.setup,
      direction: context.direction,
    };
  }

  return {
    ok: true,
    rejection: null,
    trigger,
    setup: context.setup,
    direction: context.direction,
  };
}

/**
 * Input factors for the heuristic confluence score (spec §4H1). All are supplied by the
 * caller so mandatory gates (Stage 3) are evaluated independently of the score.
 */
export interface ConfluenceFactors {
  /**
   * The directional-context gate passed for the selected trigger (spec §4A3). This is NOT an
   * additional, independent confirmation of the broader trend, and it adds no new bias requirement.
   */
  contextResolved: boolean;
  /** Trigger kind; `CHOCH` scores higher than `BOS`. */
  triggerType: 'CHOCH' | 'BOS';
  /** A fresh qualifying opposing-liquidity sweep is present. */
  freshSweep: boolean;
  /** An eligible, fresh zone is present. */
  eligibleZone: boolean;
  /** Premium/discount aligns with the intended direction. */
  premiumDiscountAligned: boolean;
}

/**
 * Heuristic confluence score on an integer 0-100 scale (spec §4H1):
 * context 30 + trigger quality (CHoCH 25 / BOS 20) + fresh sweep 20 + eligible zone 15 +
 * premium/discount 10, capped at 100. This is NOT a probability and can never override a
 * failed mandatory gate.
 */
export function computeConfluenceScore(factors: ConfluenceFactors): number {
  let score = 0;
  if (factors.contextResolved) {
    score += 30;
  }
  score += factors.triggerType === 'CHOCH' ? 25 : 20;
  if (factors.freshSweep) {
    score += 20;
  }
  if (factors.eligibleZone) {
    score += 15;
  }
  if (factors.premiumDiscountAligned) {
    score += 10;
  }
  return Math.min(100, score);
}

// --- Stage 3: zone selection, premium/discount, sweeps, conflict, SL, TP, R:R -------------------

/**
 * Normalized, engine-facing view of a zone candidate (spec §4C). FVG and OB eligibility differ:
 * - FVG usable iff `mitigated === false`.
 * - OB usable iff `invalidated === false` (a mitigated-but-not-invalidated OB stays usable).
 */
export interface ZoneCandidate {
  id: string;
  kind: 'FVG' | 'OB';
  direction: 'BULLISH' | 'BEARISH';
  zoneLower: number;
  zoneUpper: number;
  /**
   * Freshness reference epoch (spec §4C4):
   * - FVG: the confirmation candle epoch (exact).
   * - OB: the source candle epoch — documented CONSERVATIVE source-age proxy (LIMITATION); the OB
   *   type carries no confirmation epoch and Phase 2 is not modified.
   */
  epoch: number;
  usable: boolean;
}

/** Flattens FVG and order-block state into normalized ZoneCandidates (spec §4C1). */
export function collectZones(fvg: FVGState, orderBlocks: OrderBlockState): ZoneCandidate[] {
  const zones: ZoneCandidate[] = [];

  const pushZone = (
    id: string,
    kind: 'FVG' | 'OB',
    direction: 'BULLISH' | 'BEARISH',
    zoneLower: number,
    zoneUpper: number,
    epoch: number,
    usable: boolean
  ): void => {
    zones.push({ id, kind, direction, zoneLower, zoneUpper, epoch, usable });
  };

  for (const f of fvg.bullishFVGs) {
    pushZone(f.id, 'FVG', 'BULLISH', f.bottomPrice, f.topPrice, f.epoch, !f.mitigated);
  }
  for (const f of fvg.bearishFVGs) {
    pushZone(f.id, 'FVG', 'BEARISH', f.bottomPrice, f.topPrice, f.epoch, !f.mitigated);
  }
  for (const ob of orderBlocks.bullishOrderBlocks) {
    pushZone(ob.id, 'OB', 'BULLISH', ob.low, ob.high, ob.epoch, !ob.invalidated);
  }
  for (const ob of orderBlocks.bearishOrderBlocks) {
    pushZone(ob.id, 'OB', 'BEARISH', ob.low, ob.high, ob.epoch, !ob.invalidated);
  }

  return zones;
}

/**
 * Zone-to-entry distance d(zone, E) (spec §4C3): `0` when the entry is inside the interval
 * (including on either edge), else the gap to the nearer boundary. Always `>= 0`.
 */
export function zoneDistance(zoneLower: number, zoneUpper: number, entry: number): number {
  if (entry < zoneLower) {
    return zoneLower - entry;
  }
  if (entry > zoneUpper) {
    return entry - zoneUpper;
  }
  return 0;
}

/**
 * Zone location eligibility (spec §4C2, decision 9). LONG allows any zone with
 * `zoneLower <= E + tolE`; SHORT allows any zone with `zoneUpper >= E - tolE`. Entry inside the
 * zone is permitted. Boundaries are inclusive at exactly `tolE`.
 */
export function zoneIsLocationEligible(
  direction: SignalDirection,
  zoneLower: number,
  zoneUpper: number,
  entry: number,
  tolE: number
): boolean {
  if (direction === 'BULLISH') {
    return zoneLower <= entry + tolE;
  }
  return zoneUpper >= entry - tolE;
}

/**
 * Zone freshness (spec §4C4): the zone's reference epoch must not be in the future and its age must
 * not exceed `MAX_ZONE_AGE_BARS` bars of the analysis timeframe. Boundary is inclusive.
 */
export function isZoneFresh(
  epoch: number,
  signalEpoch: number,
  timeframe: Timeframe,
  config: Readonly<SignalEngineConfig> = DEFAULT_SIGNAL_ENGINE_CONFIG
): boolean {
  if (epoch > signalEpoch) {
    return false;
  }
  const windowSeconds = config.MAX_ZONE_AGE_BARS * TIMEFRAME_SECONDS[timeframe];
  return signalEpoch - epoch <= windowSeconds;
}

export interface ZoneSelectionResult {
  zone: ZoneCandidate | null;
  /** True when no fresh, usable zone of the intended direction exists (⇒ NO_ELIGIBLE_ZONE). */
  noFreshUsableZone: boolean;
  /** True when fresh usable same-direction zones exist but none is location-eligible (⇒ ZONE_MISALIGNED). */
  allLocationMisaligned: boolean;
}

/**
 * Zone selection (spec §4C2–C5). Filters same-direction zones to fresh + usable, then picks the
 * minimal-distance zone; tie-break newest `epoch`, then `id` lexicographic asc. At most one zone is
 * returned. Supplies the flags needed to discriminate `NO_ELIGIBLE_ZONE` from `ZONE_MISALIGNED`.
 */
export function selectEligibleZone(
  candidates: readonly ZoneCandidate[],
  direction: SignalDirection,
  entry: number,
  tolE: number,
  signalEpoch: number,
  timeframe: Timeframe,
  config: Readonly<SignalEngineConfig> = DEFAULT_SIGNAL_ENGINE_CONFIG
): ZoneSelectionResult {
  const freshUsable = candidates.filter(
    (z) =>
      z.direction === direction &&
      z.usable &&
      isZoneFresh(z.epoch, signalEpoch, timeframe, config)
  );

  if (freshUsable.length === 0) {
    return { zone: null, noFreshUsableZone: true, allLocationMisaligned: false };
  }

  const eligible = freshUsable.filter((z) =>
    zoneIsLocationEligible(direction, z.zoneLower, z.zoneUpper, entry, tolE)
  );
  if (eligible.length === 0) {
    return { zone: null, noFreshUsableZone: false, allLocationMisaligned: true };
  }

  const sorted = [...eligible].sort((a, b) => {
    const da = zoneDistance(a.zoneLower, a.zoneUpper, entry);
    const db = zoneDistance(b.zoneLower, b.zoneUpper, entry);
    if (da !== db) {
      return da - db;
    }
    if (b.epoch !== a.epoch) {
      return b.epoch - a.epoch;
    }
    if (a.id === b.id) {
      return 0;
    }
    return a.id < b.id ? -1 : 1;
  });

  return { zone: sorted[0], noFreshUsableZone: false, allLocationMisaligned: false };
}

/**
 * Premium/discount region gate (spec §4E, decision 4). LONG requires `DISCOUNT`; SHORT requires
 * `PREMIUM`; `EQUILIBRIUM` and `'WAITING FOR DATA'` never qualify (no direction is fabricated).
 * Rejection mapping (the spec names no code per case; documented interpretation):
 * `'WAITING FOR DATA'` ⇒ `ZONE_UNAVAILABLE` (spec §4E), `EQUILIBRIUM` ⇒ `ZONE_UNAVAILABLE`
 * (spec §7.1 test plan), the opposite region (LONG+PREMIUM / SHORT+DISCOUNT) ⇒ `ZONE_MISALIGNED`.
 */
export function resolvePremiumDiscountGate(
  direction: SignalDirection,
  zone: PremiumDiscountZone
): PremiumDiscountGateResult {
  if (zone === 'WAITING FOR DATA' || zone === 'EQUILIBRIUM') {
    return { aligned: false, rejection: 'ZONE_UNAVAILABLE' };
  }
  const aligned =
    (direction === 'BULLISH' && zone === 'DISCOUNT') ||
    (direction === 'BEARISH' && zone === 'PREMIUM');
  return aligned
    ? { aligned: true, rejection: null }
    : { aligned: false, rejection: 'ZONE_MISALIGNED' };
}

export interface PremiumDiscountGateResult {
  aligned: boolean;
  /** `'ZONE_UNAVAILABLE'` or `'ZONE_MISALIGNED'` when not aligned; otherwise `null`. */
  rejection: SignalRejectionCode | null;
}

/**
 * Sweep quality predicate (spec §4B3). A level qualifies iff it is swept on a closed candle whose
 * epoch is at or before `signalEpoch` and within `SWEEP_MAX_AGE_BARS` bars of it. Boundary inclusive.
 * Missing `sweptEpoch` never qualifies (spec §4B3: no guessing).
 */
export function isSweepInFreshnessWindow(
  level: LiquidityLevel,
  signalEpoch: number,
  timeframe: Timeframe,
  config: Readonly<SignalEngineConfig> = DEFAULT_SIGNAL_ENGINE_CONFIG
): boolean {
  if (!level.swept || level.sweptEpoch === undefined) {
    return false;
  }
  if (level.sweptEpoch > signalEpoch) {
    return false;
  }
  const windowSeconds = config.SWEEP_MAX_AGE_BARS * TIMEFRAME_SECONDS[timeframe];
  return signalEpoch - level.sweptEpoch <= windowSeconds;
}

export interface SweepSelectionResult {
  sweep: LiquidityLevel | null;
  /** True when at least one sweep satisfies the freshness window (supporting confluence). */
  hasFreshSweep: boolean;
}

/**
 * Sweep selection (spec §4B3–B4). Filters to fresh swept levels and picks the greatest `sweptEpoch`;
 * tie-break `id` lexicographic asc. For `SWEEP_REVERSAL`, pass `requireSweptOnOrBeforeEpoch` (the
 * trigger's `confirmedAtEpoch`) so the reversal sweep may precede the CHoCH but never follow it. For
 * `TREND_CONTINUATION` omit it — continuation sweeps are supporting confluence only.
 */
export function selectActionableSweep(
  levels: readonly LiquidityLevel[],
  signalEpoch: number,
  timeframe: Timeframe,
  config: Readonly<SignalEngineConfig> = DEFAULT_SIGNAL_ENGINE_CONFIG,
  requireSweptOnOrBeforeEpoch?: number
): SweepSelectionResult {
  const candidates = levels.filter(
    (l) =>
      isSweepInFreshnessWindow(l, signalEpoch, timeframe, config) &&
      (requireSweptOnOrBeforeEpoch === undefined ||
        (l.sweptEpoch !== undefined && l.sweptEpoch <= requireSweptOnOrBeforeEpoch))
  );

  if (candidates.length === 0) {
    return { sweep: null, hasFreshSweep: false };
  }

  const sorted = [...candidates].sort((a, b) => {
    const ea = a.sweptEpoch ?? 0;
    const eb = b.sweptEpoch ?? 0;
    if (eb !== ea) {
      return eb - ea;
    }
    if (a.id === b.id) {
      return 0;
    }
    return a.id < b.id ? -1 : 1;
  });

  return { sweep: sorted[0], hasFreshSweep: true };
}

/**
 * Opposing liquidity for an intended direction (spec §4D2/D3): a BULLISH reversal needs a fresh
 * swept `SELL_SIDE` level; a BEARISH reversal needs a fresh swept `BUY_SIDE` level.
 */
export function opposingLiquidityLevels(
  analysis: SMCAnalysisResult,
  direction: SignalDirection
): readonly LiquidityLevel[] {
  return direction === 'BULLISH'
    ? analysis.liquidity.sellSideLiquidity
    : analysis.liquidity.buySideLiquidity;
}

/**
 * Opposing-zone conflict predicate (spec §4C6, final-review correction 2): the intervals conflict iff
 * `sL <= oU + tolE && oL <= sU + tolE`, i.e. they overlap after expansion by `tolE` in both
 * directions. A gap `<= tolE` is a conflict; a gap `> tolE` is not. Boundary inclusive. Mere entry
 * proximity is irrelevant — the intervals themselves must conflict.
 */
export function zonesOverlap(
  selectedLower: number,
  selectedUpper: number,
  opposingLower: number,
  opposingUpper: number,
  tolE: number
): boolean {
  return selectedLower <= opposingUpper + tolE && opposingLower <= selectedUpper + tolE;
}

/**
 * True when ANY fresh, usable opposing-direction zone overlaps the selected zone per `zonesOverlap`
 * (spec §4C6). Stale or unusable opposing zones never cause a conflict.
 */
export function hasConflictingOpposingZone(
  selected: ZoneCandidate,
  candidates: readonly ZoneCandidate[],
  tolE: number,
  signalEpoch: number,
  timeframe: Timeframe,
  config: Readonly<SignalEngineConfig> = DEFAULT_SIGNAL_ENGINE_CONFIG
): boolean {
  const opposing: 'BULLISH' | 'BEARISH' = selected.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH';

  for (const z of candidates) {
    if (z.direction !== opposing) continue;
    if (!z.usable) continue;
    if (!isZoneFresh(z.epoch, signalEpoch, timeframe, config)) continue;
    if (zonesOverlap(selected.zoneLower, selected.zoneUpper, z.zoneLower, z.zoneUpper, tolE)) {
      return true;
    }
  }
  return false;
}

export interface StopLossResult {
  stopLoss: number | null;
  /** `'SL_UNRESOLVED'` or `'SL_TOO_TIGHT'` when the stop is invalid; otherwise `null`. */
  rejection: 'SL_UNRESOLVED' | 'SL_TOO_TIGHT' | null;
}

export interface StopLossInput {
  direction: SignalDirection;
  entry: number;
  tolE: number;
  config: Readonly<SignalEngineConfig>;
  /** `protectedLow.price` for LONG / `protectedHigh.price` for SHORT (may be `null`). */
  structuralInvalidation?: number | null;
  selectedZone?: ZoneCandidate | null;
  /** `price` of the selected swept level; used only when it sits on the correct side of E. */
  selectedSweepPrice?: number | null;
}

/**
 * Stop-loss construction (spec §4F1–F2).
 * LONG candidates below E: `protectedLow`, selected zone `zoneLower`, selected swept level price
 * (only when below E). `rawSL = min`; `stopLoss = rawSL - STOP_BUFFER_MULT * tolE`.
 * SHORT is symmetric (`max` + buffer). Minimum-stop tolerance check is inclusive
 * (`E - stopLoss <= MIN_STOP_TOLERANCE_MULT * tolE` ⇒ `SL_TOO_TIGHT`, spec §4F2 / design principle 7).
 */
export function constructStopLoss(input: StopLossInput): StopLossResult {
  const { direction, entry, tolE, config } = input;

  const candidates: number[] = [];
  if (input.structuralInvalidation !== null && input.structuralInvalidation !== undefined) {
    candidates.push(input.structuralInvalidation);
  }
  if (input.selectedZone) {
    candidates.push(
      direction === 'BULLISH' ? input.selectedZone.zoneLower : input.selectedZone.zoneUpper
    );
  }
  if (input.selectedSweepPrice !== null && input.selectedSweepPrice !== undefined) {
    if (direction === 'BULLISH' && input.selectedSweepPrice < entry) {
      candidates.push(input.selectedSweepPrice);
    }
    if (direction === 'BEARISH' && input.selectedSweepPrice > entry) {
      candidates.push(input.selectedSweepPrice);
    }
  }

  if (candidates.length === 0) {
    return { stopLoss: null, rejection: 'SL_UNRESOLVED' };
  }

  const rawStop = direction === 'BULLISH' ? Math.min(...candidates) : Math.max(...candidates);
  const stopLoss =
    direction === 'BULLISH' ? rawStop - config.STOP_BUFFER_MULT * tolE : rawStop + config.STOP_BUFFER_MULT * tolE;

  const distance = direction === 'BULLISH' ? entry - stopLoss : stopLoss - entry;
  if (distance <= config.MIN_STOP_TOLERANCE_MULT * tolE) {
    return { stopLoss, rejection: 'SL_TOO_TIGHT' };
  }

  return { stopLoss, rejection: null };
}

export interface TargetCandidate {
  id: string;
  price: number;
}

/**
 * Opposing target candidate set (spec §4F3). LONG: unswept `BUY_SIDE` liquidity plus opposing
 * structural highs (`latestSwingHigh`, `protectedHigh`, `brokenPrice` of BULLISH breaks), all
 * strictly above `E + tolE`. SHORT is symmetric (unswept `SELL_SIDE`, structural lows, BEARISH
 * breaks, strictly below `E - tolE`). No synthetic or pip-based target is fabricated.
 */
export function buildTargetCandidates(
  analysis: SMCAnalysisResult,
  direction: SignalDirection,
  entry: number,
  tolE: number
): TargetCandidate[] {
  const candidates: TargetCandidate[] = [];

  if (direction === 'BULLISH') {
    for (const l of analysis.liquidity.buySideLiquidity) {
      if (!l.swept && l.price > entry + tolE) {
        candidates.push({ id: l.id, price: l.price });
      }
    }
    const highs = [
      analysis.marketStructure.latestSwingHigh?.price,
      analysis.marketStructure.protectedHigh?.price,
    ];
    for (const price of highs) {
      if (price !== null && price !== undefined && price > entry + tolE) {
        candidates.push({ id: `structural:${price}`, price });
      }
    }
    for (const b of analysis.marketStructure.breaks) {
      if (b.direction === 'BULLISH' && b.brokenPrice > entry + tolE) {
        candidates.push({ id: `break:${b.id}`, price: b.brokenPrice });
      }
    }
    return candidates;
  }

  for (const l of analysis.liquidity.sellSideLiquidity) {
    if (!l.swept && l.price < entry - tolE) {
      candidates.push({ id: l.id, price: l.price });
    }
  }
  const lows = [
    analysis.marketStructure.latestSwingLow?.price,
    analysis.marketStructure.protectedLow?.price,
  ];
  for (const price of lows) {
    if (price !== null && price !== undefined && price < entry - tolE) {
      candidates.push({ id: `structural:${price}`, price });
    }
  }
  for (const b of analysis.marketStructure.breaks) {
    if (b.direction === 'BEARISH' && b.brokenPrice < entry - tolE) {
      candidates.push({ id: `break:${b.id}`, price: b.brokenPrice });
    }
  }
  return candidates;
}

/**
 * Reward/risk ratio at full floating-point precision (spec §4F3–F4). Returns `null` when risk or
 * reward is not strictly positive (invalid stop/target geometry).
 */
export function computeRiskReward(
  direction: SignalDirection,
  entry: number,
  stopLoss: number,
  target: number
): number | null {
  const risk = direction === 'BULLISH' ? entry - stopLoss : stopLoss - entry;
  const reward = direction === 'BULLISH' ? target - entry : entry - target;
  if (!(risk > 0) || !(reward > 0)) {
    return null;
  }
  return reward / risk;
}

/** Minimum R:R gate (spec §4F4, decision 5): `riskReward >= MIN_RISK_REWARD`, inclusive. */
export function isRiskRewardAdequate(
  riskReward: number,
  config: Readonly<SignalEngineConfig> = DEFAULT_SIGNAL_ENGINE_CONFIG
): boolean {
  return riskReward >= config.MIN_RISK_REWARD;
}

export interface TakeProfitResult {
  takeProfit: number | null;
  riskReward: number | null;
  /** `NO_TARGET` (empty candidate set) or `RR_BELOW_MIN` (candidates exist, none adequate). */
  rejection: 'NO_TARGET' | 'RR_BELOW_MIN' | null;
}

/**
 * One candidate from the EXISTING target-selection loop, carrying only values that loop already
 * produced (the exact `computeRiskReward` result and `isRiskRewardAdequate` verdict). Purely
 * observational: it is never read back and can never influence selection. No price or ratio here is
 * recomputed or fabricated.
 */
export interface CandidateRiskReward {
  direction: SignalDirection;
  entry: number;
  stopLoss: number;
  /** The candidate take-profit price the existing loop evaluated. */
  target: number;
  /** The exact value `computeRiskReward` returned (`null` = non-positive risk and/or reward). */
  riskReward: number | null;
  /** `MIN_RISK_REWARD` taken from the config this selection actually used. */
  minimum: number;
  /** The exact `isRiskRewardAdequate` verdict for this candidate. */
  meetsMinimum: boolean;
  /** True only for the candidate the existing loop selected. */
  selected: boolean;
  /** Final R:R-gate rejection for this selection (`RR_BELOW_MIN`), or `null` when one was selected. */
  rejection: 'NO_TARGET' | 'RR_BELOW_MIN' | null;
}

/** A candidate observation enriched with the pair it belongs to. */
export interface RiskRewardObservation extends CandidateRiskReward {
  symbol: string;
  timeframe: Timeframe;
}

/**
 * Optional, strictly observational sink for the R:R values the existing selection already computed.
 * It must never feed back into any decision; see how `SignalEngine` accepts it. A thrown observer is
 * swallowed so evaluation is never interrupted.
 */
export type RiskRewardObserver = (observation: RiskRewardObservation) => void;

/**
 * Emits the already-computed candidate observations (no recalculation) with the final rejection and
 * selection flag attached. Guarded so a throwing observer can never change target selection.
 */
function emitRiskRewardObservations(
  observations: readonly CandidateRiskReward[] | null,
  selectedIndex: number,
  rejection: 'NO_TARGET' | 'RR_BELOW_MIN' | null,
  observer: ((observation: CandidateRiskReward) => void) | undefined
): void {
  if (observations === null || observer === undefined) {
    return;
  }
  for (let i = 0; i < observations.length; i += 1) {
    try {
      observer({ ...observations[i], selected: i === selectedIndex, rejection });
    } catch {
      // A diagnostic observer must never alter target selection or interrupt evaluation.
    }
  }
}

/**
 * Take-profit selection (spec §4F3–F4). Walks opposing targets ascending by distance and returns the
 * first whose R:R reaches `MIN_RISK_REWARD`. Preserves the `NO_TARGET` xor `RR_BELOW_MIN` distinction
 * (spec §4G3): an empty valid target set is `NO_TARGET`; any valid target but none reaching the
 * minimum is `RR_BELOW_MIN`.
 *
 * The optional `onCandidate` sink observes the exact `rr` values computed below; it is invoked only
 * after selection is decided and its result is ignored, so it cannot affect the returned selection.
 */
export function selectTakeProfit(params: {
  direction: SignalDirection;
  entry: number;
  stopLoss: number;
  tolE: number;
  config: Readonly<SignalEngineConfig>;
  candidates: readonly TargetCandidate[];
  onCandidate?: (observation: CandidateRiskReward) => void;
}): TakeProfitResult {
  if (params.stopLoss === params.entry) {
    return { takeProfit: null, riskReward: null, rejection: 'NO_TARGET' };
  }

  const valid = params.candidates.filter((c) =>
    params.direction === 'BULLISH'
      ? c.price > params.entry + params.tolE
      : c.price < params.entry - params.tolE
  );
  if (valid.length === 0) {
    return { takeProfit: null, riskReward: null, rejection: 'NO_TARGET' };
  }

  const sorted = [...valid].sort((a, b) => {
    const da = Math.abs(a.price - params.entry);
    const db = Math.abs(b.price - params.entry);
    if (da !== db) {
      return da - db;
    }
    if (a.price !== b.price) {
      return a.price - b.price;
    }
    if (a.id === b.id) {
      return 0;
    }
    return a.id < b.id ? -1 : 1;
  });

  // Observations are accumulated ONLY when a sink is present; absent ⇒ behaviour is unchanged.
  const observations: CandidateRiskReward[] | null = params.onCandidate ? [] : null;

  for (const c of sorted) {
    const rr = computeRiskReward(params.direction, params.entry, params.stopLoss, c.price);
    if (rr !== null && isRiskRewardAdequate(rr, params.config)) {
      observations?.push({
        direction: params.direction,
        entry: params.entry,
        stopLoss: params.stopLoss,
        target: c.price,
        riskReward: rr,
        minimum: params.config.MIN_RISK_REWARD,
        meetsMinimum: true,
        selected: false,
        rejection: null,
      });
      const result: TakeProfitResult = { takeProfit: c.price, riskReward: rr, rejection: null };
      emitRiskRewardObservations(
        observations,
        observations === null ? -1 : observations.length - 1,
        null,
        params.onCandidate
      );
      return result;
    }
    observations?.push({
      direction: params.direction,
      entry: params.entry,
      stopLoss: params.stopLoss,
      target: c.price,
      riskReward: rr,
      minimum: params.config.MIN_RISK_REWARD,
      meetsMinimum: false,
      selected: false,
      rejection: null,
    });
  }

  emitRiskRewardObservations(observations, -1, 'RR_BELOW_MIN', params.onCandidate);
  return { takeProfit: null, riskReward: null, rejection: 'RR_BELOW_MIN' };
}

/**
 * SMC Signal Engine — Phase 3 orchestrator (spec §4D, §4G, §5).
 *
 * `evaluate(analysis, context)` composes the Stage 2/3 pure helpers in the approved rejection-tier
 * order (spec §4G1): Tier 0 preconditions, Tier 1 context/trigger (latest-trigger-only, no fallback),
 * Tier 2 zone + sweep (all applicable codes collected in fixed order), Tier 3 stop-loss, Tier 4
 * target/R:R (`NO_TARGET` xor `RR_BELOW_MIN`), Tier 5 duplicate. The confluence score is computed
 * only for an emitted signal and can never override a failed mandatory gate. Mandatory gates and
 * confidence never fabricate targets, candle data, or HTF context.
 *
 * Duplicate identity (`symbol:timeframe:triggerId:zoneId`, spec §5.1) is recorded ONLY immediately
 * before a `LONG`/`SHORT` is returned (spec §5.2); every rejected or duplicate outcome leaves the
 * per-pair consumed-identity state unchanged.
 *
 * `timestamp = signalEpoch` (the confirming closed candle's epoch). No wall-clock value participates.
 * The engine is analysis-only and never places orders.
 */
export class SignalEngine {
  private consumedIdentities = new Map<string, Set<string>>();
  /**
   * Optional, strictly observational R:R sink. `undefined` (the default everywhere except the manual
   * live diagnostic) keeps the engine completely inert: no observer is ever invoked.
   */
  private readonly riskRewardObserver: RiskRewardObserver | undefined;

  constructor(options: { riskRewardObserver?: RiskRewardObserver } = {}) {
    this.riskRewardObserver = options.riskRewardObserver;
  }

  /**
   * Reset duplicate-suppression state (spec §5.3), mirroring `MarketStructureAnalyzer.clear`:
   * both args → that pair; only symbol → all its timeframes; neither → everything.
   */
  public clear(symbol?: string, timeframe?: Timeframe): void {
    if (symbol !== undefined && timeframe !== undefined) {
      this.consumedIdentities.delete(this.pairKey(symbol, timeframe));
    } else if (symbol !== undefined) {
      const prefix = `${symbol}:`;
      for (const key of this.consumedIdentities.keys()) {
        if (key.startsWith(prefix)) {
          this.consumedIdentities.delete(key);
        }
      }
    } else {
      this.consumedIdentities.clear();
    }
  }

  private pairKey(symbol: string, timeframe: Timeframe): string {
    return `${symbol}:${timeframe}`;
  }

  /** Deterministic NO_TRADE output with the reported rejection codes. */
  private noTrade(
    codes: SignalRejectionCode[],
    reason: string,
    signalEpoch: number | undefined,
    timestamp: number,
    triggerId: string | null
  ): SignalOutput {
    return {
      decision: 'NO_TRADE',
      confidence: null,
      setup: 'NONE',
      entry: null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      reason,
      timestamp,
      ...(signalEpoch !== undefined ? { signalEpoch } : {}),
      ...(triggerId !== null ? { triggerId } : {}),
      rejectionReasons: codes,
    };
  }

  private describeRejection(code: SignalRejectionCode, detail?: string): string {
    switch (code) {
      case 'ZONE_UNAVAILABLE':
        return detail !== undefined
          ? `Signal rejected: ${detail} (ZONE_UNAVAILABLE)`
          : 'Signal rejected: premium/discount zone is unavailable (ZONE_UNAVAILABLE)';
      case 'NO_ELIGIBLE_ZONE':
        return 'Signal rejected: no fresh usable zone of the intended direction (NO_ELIGIBLE_ZONE)';
      case 'ZONE_MISALIGNED':
        return 'Signal rejected: zone is not aligned with the intended direction (ZONE_MISALIGNED)';
      case 'CONFLICTING_ZONES':
        return 'Signal rejected: selected zone conflicts with an overlapping opposing zone (CONFLICTING_ZONES)';
      case 'NO_FRESH_SWEEP':
        return 'Signal rejected: SWEEP_REVERSAL requires a qualifying fresh opposing sweep (NO_FRESH_SWEEP)';
      case 'SL_UNRESOLVED':
        return 'Signal rejected: no structural invalidation candidate for a stop-loss (SL_UNRESOLVED)';
      case 'SL_TOO_TIGHT':
        return 'Signal rejected: stop-loss distance is within the minimum tolerance (SL_TOO_TIGHT)';
      case 'NO_TARGET':
        return 'Signal rejected: no valid opposing take-profit target (NO_TARGET)';
      case 'RR_BELOW_MIN':
        return 'Signal rejected: take-profit targets are below the minimum risk/reward (RR_BELOW_MIN)';
      case 'DUPLICATE':
        return 'Signal rejected: identical signal identity was already consumed (DUPLICATE)';
      default:
        return `Signal rejected: ${code}`;
    }
  }

  /**
   * Evaluate one (symbol, timeframe) analysis on a confirming closed candle.
   * `context` is optional only to honor spec §3: a missing context yields `FORMING_CANDLE`.
   */
  public evaluate(analysis: SMCAnalysisResult, context?: SignalContext): SignalOutput {
    const candle = context?.lastClosedCandle;

    // Tier 0 — preconditions (single).
    if (context === undefined || candle === undefined || candle.isClosed !== true) {
      const signalEpoch = candle !== undefined ? candle.epoch : undefined;
      const timestamp = signalEpoch ?? 0;
      return this.noTrade(
        ['FORMING_CANDLE'],
        'Signal rejected: confirming candle is not closed or context is missing (FORMING_CANDLE)',
        signalEpoch,
        timestamp,
        null
      );
    }
    const signalEpoch = candle.epoch;
    const timestamp = signalEpoch;
    if (analysis.marketStructure.swings.length === 0) {
      return this.noTrade(
        ['INSUFFICIENT_DATA'],
        'Signal rejected: no confirmed swings to build market-structure context (INSUFFICIENT_DATA)',
        signalEpoch,
        timestamp,
        null
      );
    }

    const entry = candle.close;
    const timeframe = analysis.timeframe;
    const config = DEFAULT_SIGNAL_ENGINE_CONFIG;
    const tolE = getSymbolEqualityTolerance(analysis.symbol, entry);

    // Tier 1 — context / trigger (single; latest-trigger-only, spec §4D5).
    const triggerRes = resolveTrigger(
      analysis.marketStructure.breaks,
      analysis.marketStructure.structuralBias,
      signalEpoch,
      timeframe,
      config
    ); // signalEpoch is guaranteed defined after Tier 0
    if (triggerRes.ok === false || triggerRes.trigger === null || triggerRes.direction === null) {
      const code = triggerRes.ok === false && triggerRes.rejection !== null ? triggerRes.rejection : 'NO_CONTEXT';
      return this.noTrade(
        [code],
        code === 'STALE_TRIGGER'
          ? `Signal rejected: latest trigger ${triggerRes.trigger?.id ?? ''} is stale (STALE_TRIGGER)`
          : 'Signal rejected: no directional context from the latest actionable event (NO_CONTEXT)',
        signalEpoch,
        timestamp,
        triggerRes.trigger !== null ? triggerRes.trigger.id : null
      );
    }
    const trigger = triggerRes.trigger;
    const direction = triggerRes.direction;
    const setup = triggerRes.setup;

    // Tier 2 — zone + sweep (collect ALL applicable codes in fixed order, spec §4G2).
    const zones = collectZones(analysis.fvg, analysis.orderBlocks);
    const zoneRes = selectEligibleZone(zones, direction, entry, tolE, signalEpoch, timeframe, config);
    const pdGate = resolvePremiumDiscountGate(direction, analysis.zone);

    const sweeping = opposingLiquidityLevels(analysis, direction);
    const sweepRes =
      setup === 'SWEEP_REVERSAL'
        ? selectActionableSweep(sweeping, signalEpoch, timeframe, config, trigger.confirmedAtEpoch)
        : selectActionableSweep(sweeping, signalEpoch, timeframe, config);

    const hasConflict =
      zoneRes.zone !== null &&
      hasConflictingOpposingZone(zoneRes.zone, zones, tolE, signalEpoch, timeframe, config);

    const tier2Codes: SignalRejectionCode[] = [];
    if (pdGate.rejection === 'ZONE_UNAVAILABLE') tier2Codes.push('ZONE_UNAVAILABLE');
    if (zoneRes.noFreshUsableZone) tier2Codes.push('NO_ELIGIBLE_ZONE');
    if (zoneRes.allLocationMisaligned || pdGate.rejection === 'ZONE_MISALIGNED') {
      tier2Codes.push('ZONE_MISALIGNED');
    }
    if (hasConflict) tier2Codes.push('CONFLICTING_ZONES');
    if (setup === 'SWEEP_REVERSAL' && !sweepRes.hasFreshSweep) tier2Codes.push('NO_FRESH_SWEEP');

    if (tier2Codes.length > 0) {
      const detail =
        tier2Codes[0] === 'ZONE_UNAVAILABLE'
          ? analysis.zone === 'EQUILIBRIUM'
            ? 'price is at EQUILIBRIUM (no qualifying premium/discount region)'
            : 'premium/discount zone is unavailable (waiting for data)'
          : undefined;
      return this.noTrade(tier2Codes, this.describeRejection(tier2Codes[0], detail), signalEpoch, timestamp, trigger.id);
    }

    // Tier 3 — stop-loss (single).
    const structuralInvalidation =
      direction === 'BULLISH'
        ? analysis.marketStructure.protectedLow?.price ?? null
        : analysis.marketStructure.protectedHigh?.price ?? null;
    const sl = constructStopLoss({
      direction,
      entry,
      tolE,
      config,
      structuralInvalidation,
      selectedZone: zoneRes.zone,
      selectedSweepPrice: sweepRes.sweep !== null ? sweepRes.sweep.price : null,
    });
    if (sl.rejection !== null || sl.stopLoss === null) {
      const code = sl.rejection !== null ? sl.rejection : 'SL_UNRESOLVED';
      return this.noTrade([code], this.describeRejection(code), signalEpoch, timestamp, trigger.id);
    }
    const stopLoss = sl.stopLoss;

    // Tier 4 — target / minimum R:R (mutually exclusive, spec §4G3).
    // The observer is purely observational; it is enriched with the pair and never consulted here.
    const riskRewardObserver = this.riskRewardObserver;
    const observeCandidate = riskRewardObserver
      ? (observation: CandidateRiskReward): void => {
          riskRewardObserver({ symbol: analysis.symbol, timeframe, ...observation });
        }
      : undefined;
    const tp = selectTakeProfit({
      direction,
      entry,
      stopLoss,
      tolE,
      config,
      candidates: buildTargetCandidates(analysis, direction, entry, tolE),
      onCandidate: observeCandidate,
    });
    if (tp.rejection !== null || tp.takeProfit === null || tp.riskReward === null) {
      const code = tp.rejection !== null ? tp.rejection : 'NO_TARGET';
      return this.noTrade([code], this.describeRejection(code), signalEpoch, timestamp, trigger.id);
    }

    // Tier 5 — duplicate (last gate, spec §4G). Identity is consumed ONLY on emission (§5.2).
    if (zoneRes.zone === null) {
      return this.noTrade(['NO_ELIGIBLE_ZONE'], this.describeRejection('NO_ELIGIBLE_ZONE'), signalEpoch, timestamp, trigger.id);
    }
    const identity = `${this.pairKey(analysis.symbol, timeframe)}:${trigger.id}:${zoneRes.zone.id}`;
    const pairKey = this.pairKey(analysis.symbol, timeframe);
    let consumed = this.consumedIdentities.get(pairKey);
    if (consumed === undefined) {
      consumed = new Set<string>();
      this.consumedIdentities.set(pairKey, consumed);
    }
    if (consumed.has(identity)) {
      return this.noTrade(['DUPLICATE'], this.describeRejection('DUPLICATE'), signalEpoch, timestamp, trigger.id);
    }

    // Emit LONG/SHORT; mutation of duplicate state happens now and only now.
    consumed.add(identity);

    const decision: SignalDecision = direction === 'BULLISH' ? 'LONG' : 'SHORT';
    const confidence = computeConfluenceScore({
      contextResolved: true,
      triggerType: getTriggerKind(trigger),
      freshSweep: sweepRes.hasFreshSweep,
      eligibleZone: true,
      premiumDiscountAligned: pdGate.aligned,
    });
    const triggerKind = getTriggerKind(trigger);
    const breakdown = [
      'Context: directional context gate passed',
      `Trigger: ${trigger.type} (${triggerKind} quality ${triggerKind === 'CHOCH' ? '25' : '20'})`,
      sweepRes.hasFreshSweep
        ? 'Sweep: fresh opposing sweep present'
        : 'Sweep: no qualifying sweep (supporting for TREND_CONTINUATION only)',
      `Zone: eligible fresh ${zoneRes.zone.kind} zone`,
      'Region: premium/discount aligned',
    ];

    return {
      decision,
      confidence,
      setup,
      entry,
      stopLoss,
      takeProfit: tp.takeProfit,
      riskReward: tp.riskReward,
      reason: `${decision} signal: ${setup} on ${trigger.type} trigger with eligible ${zoneRes.zone.kind} zone (confidence ${confidence}/100)`,
      timestamp: signalEpoch,
      signalEpoch,
      triggerId: trigger.id,
      signalId: identity,
      confluenceBreakdown: breakdown,
    };
  }
}
