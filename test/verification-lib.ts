/**
 * Offline, network-free verification helpers for the live verification phase.
 *
 * Everything in this module is pure and deterministic: it operates on candle
 * arrays and already-produced analysis results. It performs NO network access,
 * fabricates NO candles, and mutates NO inputs. `test/verify-real-deriv-data.ts`
 * uses these helpers against real Deriv data; `test/verification-lib.test.ts`
 * exercises them deterministically.
 */

import { Candle, Timeframe } from '../lib/deriv/candles';
import { InstrumentCategory } from '../lib/deriv/symbols';
import {
  utcDayOfWeek,
  utcHour,
  isWeekendClosureBoundary,
  isDailyMaintenanceBoundary,
  isContinuousCategory,
} from '../lib/deriv/session-closures';
import {
  MarketStructureState,
  SwingPoint,
  getSymbolEqualityTolerance,
} from '../lib/analysis/market-structure';
import { StructureBreakState } from '../lib/analysis/structure-breaks';
import { LiquidityState, LiquidityLevel } from '../lib/analysis/liquidity';
import { FVGState, FairValueGap } from '../lib/analysis/fvg';
import { OrderBlockState, OrderBlock } from '../lib/analysis/order-blocks';
import { PremiumDiscountZone } from '../lib/analysis/smc';
import { PairEvaluation } from '../lib/signals/signal-eval';

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'PENDING';

export interface CheckOutcome {
  status: CheckStatus;
  failures: string[];
  notes: string[];
  /** True when the component produced at least one instance whose invariants were actually checked. */
  exercised: boolean;
}

function outcome(failures: string[], exercised: boolean, notes: string[] = []): CheckOutcome {
  const status: CheckStatus = failures.length > 0 ? 'FAIL' : exercised ? 'PASS' : 'SKIPPED';
  return { status, failures, notes, exercised };
}

// ---------------------------------------------------------------------------
// Stage 1: history thresholds derived from the configured swing parameters
// ---------------------------------------------------------------------------

export interface SwingParameters {
  leftBars: number;
  rightBars: number;
}

/**
 * Hard minimum number of closed candles required before the pivot fractal
 * detector can confirm even a single swing: a candidate pivot needs `leftBars`
 * bars on its left and `rightBars` bars on its right, plus the pivot itself.
 */
export function minimumSwingConfirmationBars(params: SwingParameters): number {
  return params.leftBars + params.rightBars + 1;
}

/**
 * Additional reasonable minimum closed-candle history below which the swing
 * loop, swing classification and structure-break scan cannot be meaningfully
 * exercised. Chosen so multiple candidate pivots and at least one confirmable
 * break window are available. This is a floor, not a success requirement on
 * market outcome.
 */
export const MIN_ANALYSIS_HISTORY = 30;

// ---------------------------------------------------------------------------
// Stage 2: candle integrity
// ---------------------------------------------------------------------------

export type GapClassification =
  | 'weekend_closure'
  | 'maintenance_closure'
  | 'possible_holiday'
  | 'unexpected';

export interface GapFinding {
  fromEpoch: number;
  toEpoch: number;
  missingPeriods: number;
  durationSeconds: number;
  classification: GapClassification;
}

export interface CandleIntegrityReport {
  ok: boolean;
  failures: string[];
  notes: string[];
  gaps: GapFinding[];
  unexpectedGapCount: number;
  leadingUnaligned: boolean;
}

export interface CandleIntegrityOptions {
  timeframe: Timeframe;
  periodSeconds: number;
  category: InstrumentCategory;
  /** When true (closed history), any candle with `isClosed === false` is a failure. */
  expectClosed: boolean;
}

/**
 * The closure model lives in `lib/deriv/session-closures.ts`, so the offline
 * verification helpers and the live recovery coverage check agree on which
 * periods legitimately have no candle. They are re-exported here to keep this
 * module's public API unchanged.
 */
export {
  utcDayOfWeek,
  utcHour,
  isWeekendClosureBoundary,
  isDailyMaintenanceBoundary,
};

/**
 * Classifies the interval between two adjacent candles.
 *
 * - `weekend_closure`: every missing period falls in a weekly closure window.
 * - `maintenance_closure`: every missing period falls in a daily intraday halt
 *   (e.g. the gold daily session break). Benign; reported, never a failure.
 * - `possible_holiday`: a long (>= 24h) gap not explained by a closure above.
 *   Reported, never treated as an automatic failure (holidays cannot be
 *   exhaustively enumerated).
 * - `unexpected`: a short (< 24h) gap that is not a known closure. This is a
 *   genuine intraday data gap and is treated as an integrity failure.
 */
export function classifyGap(
  fromEpoch: number,
  toEpoch: number,
  periodSeconds: number,
  category: InstrumentCategory
): GapFinding | null {
  const duration = toEpoch - fromEpoch;
  const missingPeriods = Math.max(0, Math.round(duration / periodSeconds) - 1);
  if (missingPeriods <= 0) {
    return null;
  }

  if (isContinuousCategory(category)) {
    return { fromEpoch, toEpoch, missingPeriods, durationSeconds: duration, classification: 'unexpected' };
  }

  let allClosure = true;
  let allWeekend = true;
  for (let p = fromEpoch + periodSeconds; p < toEpoch; p += periodSeconds) {
    const weekend = isWeekendClosureBoundary(p, category);
    const maintenance = isDailyMaintenanceBoundary(p, category);
    if (!weekend) allWeekend = false;
    if (!weekend && !maintenance) {
      allClosure = false;
      break;
    }
  }
  if (allClosure) {
    return {
      fromEpoch,
      toEpoch,
      missingPeriods,
      durationSeconds: duration,
      classification: allWeekend ? 'weekend_closure' : 'maintenance_closure',
    };
  }
  if (duration >= 24 * 3600) {
    return { fromEpoch, toEpoch, missingPeriods, durationSeconds: duration, classification: 'possible_holiday' };
  }
  return { fromEpoch, toEpoch, missingPeriods, durationSeconds: duration, classification: 'unexpected' };
}

/**
 * Validates a candle sequence (raw Deriv history or processing-app history).
 *
 * Checks: unique epochs, strictly increasing epochs, timeframe boundary
 * alignment (a single unaligned leading candle is tolerated because the app
 * requests history with `adjust_start_time: 1`, which yields one partial
 * leading candle), finite and internally consistent OHLC, closed-only input
 * when required, and session-aware gap detection.
 */
export function checkCandleIntegrity(
  candles: Candle[],
  options: CandleIntegrityOptions
): CandleIntegrityReport {
  const failures: string[] = [];
  const notes: string[] = [];
  const gaps: GapFinding[] = [];
  let leadingUnaligned = false;

  if (candles.length === 0) {
    return { ok: true, failures, notes: ['no candles'], gaps, unexpectedGapCount: 0, leadingUnaligned };
  }

  const seen = new Set<number>();
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    if (seen.has(c.epoch)) {
      failures.push(`duplicate candle epoch ${c.epoch}`);
    }
    seen.add(c.epoch);

    if (i > 0 && c.epoch <= candles[i - 1].epoch) {
      failures.push(`candles not strictly increasing at epoch ${c.epoch}`);
    }

    const finite =
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close);
    if (!finite) {
      failures.push(`non-finite OHLC at epoch ${c.epoch}`);
    } else {
      if (c.high < Math.max(c.open, c.close)) {
        failures.push(`high below open/close at epoch ${c.epoch}`);
      }
      if (c.low > Math.min(c.open, c.close)) {
        failures.push(`low above open/close at epoch ${c.epoch}`);
      }
      if (c.high < c.low) {
        failures.push(`high below low at epoch ${c.epoch}`);
      }
    }

    if (options.expectClosed && c.isClosed === false) {
      failures.push(`unclosed candle present at epoch ${c.epoch}`);
    }

    const aligned = c.epoch % options.periodSeconds === 0;
    if (!aligned) {
      if (i === 0) {
        leadingUnaligned = true;
        notes.push(
          `leading partial candle at epoch ${c.epoch} (adjust_start_time=1 convention); treated as expected`
        );
      } else {
        failures.push(
          `epoch ${c.epoch} not aligned to ${options.timeframe} boundary (period ${options.periodSeconds}s)`
        );
      }
    }
  }

  const unexpected: GapFinding[] = [];
  for (let i = 1; i < candles.length; i++) {
    const gap = classifyGap(
      candles[i - 1].epoch,
      candles[i].epoch,
      options.periodSeconds,
      options.category
    );
    if (gap) {
      gaps.push(gap);
      if (gap.classification === 'unexpected') {
        unexpected.push(gap);
        failures.push(
          `unexpected ${options.timeframe} gap: ${gap.missingPeriods} missing period(s) between ${gap.fromEpoch} and ${gap.toEpoch}`
        );
      } else {
        notes.push(
          `${gap.classification} gap: ${gap.missingPeriods} period(s) between ${gap.fromEpoch} and ${gap.toEpoch}`
        );
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    notes,
    gaps,
    unexpectedGapCount: unexpected.length,
    leadingUnaligned,
  };
}

// ---------------------------------------------------------------------------
// Stage 3: component invariants
// ---------------------------------------------------------------------------

const VALID_STRUCTURE_TYPES = new Set(['HH', 'HL', 'LH', 'LL', 'EQH', 'EQL']);
const BREAK_DIRECTIONS: Record<string, 'BULLISH' | 'BEARISH'> = {
  BULLISH_BOS: 'BULLISH',
  BULLISH_CHOCH: 'BULLISH',
  INITIAL_BULLISH_BREAK: 'BULLISH',
  BEARISH_BOS: 'BEARISH',
  BEARISH_CHOCH: 'BEARISH',
  INITIAL_BEARISH_BREAK: 'BEARISH',
};

function findCandle(candles: Candle[], epoch: number): Candle | undefined {
  return candles.find((c) => c.epoch === epoch);
}

export function checkMarketStructure(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  state: MarketStructureState
): CheckOutcome {
  const failures: string[] = [];
  const notes: string[] = [];

  if (state.symbol !== symbol) failures.push(`structure symbol ${state.symbol} != ${symbol}`);
  if (state.timeframe !== timeframe) failures.push(`structure timeframe ${state.timeframe} != ${timeframe}`);

  const ids = new Set<string>();
  let prevEpoch = -Infinity;
  for (const s of state.swings) {
    if (ids.has(s.id)) failures.push(`duplicate swing id ${s.id}`);
    ids.add(s.id);

    if (s.candleEpoch < prevEpoch) failures.push(`swings not chronological at ${s.id}`);
    prevEpoch = s.candleEpoch;

    // Causality / no look-ahead: a pivot is only known once rightBars later.
    if (s.confirmedAtEpoch <= s.candleEpoch) {
      failures.push(`look-ahead swing ${s.id}: confirmedAtEpoch <= candleEpoch`);
    }
    if (s.swingCandleEpoch !== s.candleEpoch) {
      failures.push(`swing ${s.id} swingCandleEpoch != candleEpoch`);
    }
    if (s.type !== 'HIGH' && s.type !== 'LOW') {
      failures.push(`invalid swing type at ${s.id}`);
    }
    if (!VALID_STRUCTURE_TYPES.has(s.structureType)) {
      failures.push(`invalid structureType ${s.structureType} at ${s.id}`);
    }

    const candle = findCandle(candles, s.candleEpoch);
    if (!candle) {
      failures.push(`swing ${s.id} references an epoch absent from the analysis input`);
      continue;
    }
    const expected = s.type === 'HIGH' ? candle.high : candle.low;
    if (s.price !== expected) {
      failures.push(`swing ${s.id} price ${s.price} != candle ${s.type} ${expected}`);
    }
  }

  const last = candles[candles.length - 1];
  if (last && state.lastAnalyzedEpoch !== last.epoch) {
    failures.push(`lastAnalyzedEpoch ${state.lastAnalyzedEpoch} != last closed candle ${last.epoch}`);
  }

  if (state.swings.length === 0) {
    notes.push('no confirmed swings (valid empty result; not treated as a failure)');
  }
  return outcome(failures, state.swings.length > 0, notes);
}

export function checkStructureBreaks(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  swings: SwingPoint[],
  state: StructureBreakState
): CheckOutcome {
  const failures: string[] = [];
  const notes: string[] = [];

  if (state.symbol !== symbol) failures.push(`breaks symbol ${state.symbol} != ${symbol}`);
  if (state.timeframe !== timeframe) failures.push(`breaks timeframe ${state.timeframe} != ${timeframe}`);

  const swingEpochs = new Set(swings.map((s) => `${s.type}:${s.candleEpoch}`));
  const ids = new Set<string>();
  let prevEpoch = -Infinity;
  for (const b of state.breaks) {
    if (ids.has(b.id)) failures.push(`duplicate break id ${b.id}`);
    ids.add(b.id);

    if (b.breakCandleEpoch < prevEpoch) failures.push(`breaks not chronological at ${b.id}`);
    prevEpoch = b.breakCandleEpoch;

    if (b.breakCandleEpoch <= b.brokenSwingEpoch) {
      failures.push(`break ${b.id} does not occur after the broken swing`);
    }
    if (b.confirmedAtEpoch !== b.breakCandleEpoch) {
      failures.push(`break ${b.id} confirmedAtEpoch != breakCandleEpoch`);
    }

    const expectedDir = BREAK_DIRECTIONS[b.type];
    if (expectedDir === undefined) {
      failures.push(`unknown break type ${b.type} at ${b.id}`);
    } else if (b.direction !== expectedDir) {
      failures.push(`break ${b.id} direction ${b.direction} != ${expectedDir} for ${b.type}`);
    }

    if (b.direction === 'BULLISH' && !(b.confirmationPrice > b.brokenPrice)) {
      failures.push(`bullish break ${b.id} confirmationPrice not above brokenPrice`);
    }
    if (b.direction === 'BEARISH' && !(b.confirmationPrice < b.brokenPrice)) {
      failures.push(`bearish break ${b.id} confirmationPrice not below brokenPrice`);
    }

    const breakCandle = findCandle(candles, b.breakCandleEpoch);
    if (!breakCandle) {
      failures.push(`break ${b.id} references a break candle absent from the analysis input`);
    } else if (breakCandle.close !== b.confirmationPrice) {
      failures.push(`break ${b.id} confirmationPrice != break candle close`);
    }

    const matchesSwing = swingEpochs.has(
      `${b.direction === 'BULLISH' ? 'HIGH' : 'LOW'}:${b.brokenSwingEpoch}`
    );
    if (swings.length > 0 && !matchesSwing) {
      notes.push(`break ${b.id} broken level not matched to a same-type swing epoch`);
    }
  }

  if (state.breaks.length === 0) {
    notes.push('no structure breaks (valid empty result; not treated as a failure)');
  }
  return outcome(failures, state.breaks.length > 0, notes);
}

function sweepQualifyingEpoch(
  symbol: string,
  level: LiquidityLevel,
  candles: Candle[]
): number | null {
  const tolerance = getSymbolEqualityTolerance(symbol, level.price);
  for (const candle of candles) {
    if (candle.epoch <= level.epoch) continue;
    if (level.type === 'BUY_SIDE') {
      if (candle.high - level.price > tolerance && candle.close < level.price) return candle.epoch;
    } else {
      if (level.price - candle.low > tolerance && candle.close > level.price) return candle.epoch;
    }
  }
  return null;
}

export function checkLiquidity(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  structure: MarketStructureState,
  state: LiquidityState
): CheckOutcome {
  const failures: string[] = [];
  const notes: string[] = [];

  if (state.symbol !== symbol) failures.push(`liquidity symbol ${state.symbol} != ${symbol}`);
  if (state.timeframe !== timeframe) failures.push(`liquidity timeframe ${state.timeframe} != ${timeframe}`);

  const highs = structure.swings.filter((s) => s.type === 'HIGH');
  const lows = structure.swings.filter((s) => s.type === 'LOW');
  if (state.buySideLiquidity.length !== highs.length) {
    failures.push(`buy-side levels ${state.buySideLiquidity.length} != swing highs ${highs.length}`);
  }
  if (state.sellSideLiquidity.length !== lows.length) {
    failures.push(`sell-side levels ${state.sellSideLiquidity.length} != swing lows ${lows.length}`);
  }

  const checkLevel = (level: LiquidityLevel, swing: SwingPoint | undefined): void => {
    if (!swing) {
      failures.push(`liquidity level ${level.id} has no matching swing`);
      return;
    }
    if (level.price !== swing.price) {
      failures.push(`liquidity level ${level.id} price != swing price`);
    }
    if (level.epoch !== swing.swingCandleEpoch) {
      failures.push(`liquidity level ${level.id} epoch != swing epoch`);
    }
    const first = sweepQualifyingEpoch(symbol, level, candles);
    if (level.swept) {
      if (level.sweptEpoch === undefined) {
        failures.push(`liquidity level ${level.id} swept without sweptEpoch`);
      } else {
        if (level.sweptEpoch <= level.epoch) {
          failures.push(`liquidity level ${level.id} sweptEpoch not after level epoch`);
        }
        if (first !== level.sweptEpoch) {
          failures.push(`liquidity level ${level.id} sweptEpoch ${level.sweptEpoch} != first qualifying ${first}`);
        }
      }
    } else if (first !== null) {
      failures.push(`liquidity level ${level.id} not marked swept but a sweep candle exists at ${first}`);
    }
  };

  for (const level of state.buySideLiquidity) {
    checkLevel(level, highs.find((s) => s.swingCandleEpoch === level.epoch));
  }
  for (const level of state.sellSideLiquidity) {
    checkLevel(level, lows.find((s) => s.swingCandleEpoch === level.epoch));
  }

  for (const cluster of state.equalHighs) {
    if (cluster.type !== 'EQH') failures.push(`equalHighs cluster ${cluster.id} has type ${cluster.type}`);
    if (cluster.count < 2) failures.push(`equalHighs cluster ${cluster.id} count ${cluster.count} < 2`);
  }
  for (const cluster of state.equalLows) {
    if (cluster.type !== 'EQL') failures.push(`equalLows cluster ${cluster.id} has type ${cluster.type}`);
    if (cluster.count < 2) failures.push(`equalLows cluster ${cluster.id} count ${cluster.count} < 2`);
  }

  const exercised = state.buySideLiquidity.length + state.sellSideLiquidity.length > 0;
  if (!exercised) notes.push('no liquidity levels (valid empty result; not treated as a failure)');
  return outcome(failures, exercised, notes);
}

function firstMitigationEpoch(
  fvg: FairValueGap,
  candles: Candle[],
  creationIndex: number
): number | null {
  for (let j = creationIndex + 1; j < candles.length; j++) {
    const candle = candles[j];
    if (fvg.type === 'BULLISH' && candle.low <= fvg.bottomPrice) return candle.epoch;
    if (fvg.type === 'BEARISH' && candle.high >= fvg.topPrice) return candle.epoch;
  }
  return null;
}

function checkFvgOne(fvg: FairValueGap, candles: Candle[], failures: string[]): boolean {
  const index = candles.findIndex((c) => c.epoch === fvg.epoch);
  if (index < 2) {
    failures.push(`FVG ${fvg.id} creation epoch ${fvg.epoch} is not preceded by two closed candles`);
    return false;
  }
  const a = candles[index - 2];
  const c = candles[index];
  if (fvg.type === 'BULLISH') {
    if (fvg.bottomPrice !== a.high) failures.push(`bullish FVG ${fvg.id} bottomPrice != two-back high`);
    if (fvg.topPrice !== c.low) failures.push(`bullish FVG ${fvg.id} topPrice != creation low`);
  } else {
    if (fvg.topPrice !== a.low) failures.push(`bearish FVG ${fvg.id} topPrice != two-back low`);
    if (fvg.bottomPrice !== c.high) failures.push(`bearish FVG ${fvg.id} bottomPrice != creation high`);
  }
  if (!(fvg.topPrice > fvg.bottomPrice)) {
    failures.push(`FVG ${fvg.id} topPrice not above bottomPrice`);
  }
  const first = firstMitigationEpoch(fvg, candles, index);
  if (fvg.mitigated) {
    if (fvg.mitigationEpoch === undefined) {
      failures.push(`FVG ${fvg.id} mitigated without mitigationEpoch`);
    } else if (fvg.mitigationEpoch !== first) {
      failures.push(`FVG ${fvg.id} mitigationEpoch ${fvg.mitigationEpoch} != first fill ${first}`);
    }
  } else if (first !== null) {
    failures.push(`FVG ${fvg.id} not marked mitigated but a fill candle exists at ${first}`);
  }
  return true;
}

export function checkFvg(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  state: FVGState
): CheckOutcome {
  const failures: string[] = [];
  const notes: string[] = [];
  if (state.symbol !== symbol) failures.push(`fvg symbol ${state.symbol} != ${symbol}`);
  if (state.timeframe !== timeframe) failures.push(`fvg timeframe ${state.timeframe} != ${timeframe}`);

  for (const fvg of state.bullishFVGs) checkFvgOne(fvg, candles, failures);
  for (const fvg of state.bearishFVGs) checkFvgOne(fvg, candles, failures);

  const count = state.bullishFVGs.length + state.bearishFVGs.length;
  const unmitigated =
    state.bullishFVGs.filter((f) => !f.mitigated).length +
    state.bearishFVGs.filter((f) => !f.mitigated).length;
  if (state.unmitigatedCount !== unmitigated) {
    failures.push(`fvg unmitigatedCount ${state.unmitigatedCount} != recomputed ${unmitigated}`);
  }
  if (candles.length < 3 && state.status !== 'WAITING FOR DATA') {
    failures.push('fvg status ACTIVE with fewer than 3 closed candles');
  }
  if (count === 0) notes.push('no fair value gaps (valid empty result; not treated as a failure)');
  return outcome(failures, count > 0, notes);
}

function checkObOne(ob: OrderBlock, candles: Candle[], failures: string[]): void {
  if (ob.invalidated && !ob.mitigated) {
    failures.push(`order block ${ob.id} invalidated without mitigated`);
  }
  if (ob.high < ob.low) failures.push(`order block ${ob.id} high below low`);

  const source = findCandle(candles, ob.epoch);
  if (!source) {
    failures.push(`order block ${ob.id} source candle absent from analysis input`);
    return;
  }
  if (ob.high !== source.high || ob.low !== source.low) {
    failures.push(`order block ${ob.id} bounds != source candle bounds`);
  }
  if (ob.type === 'BULLISH' && !(source.close < source.open)) {
    failures.push(`bullish order block ${ob.id} source candle is not bearish`);
  }
  if (ob.type === 'BEARISH' && !(source.close > source.open)) {
    failures.push(`bearish order block ${ob.id} source candle is not bullish`);
  }

  if (ob.mitigated) {
    if (ob.mitigationEpoch === undefined || ob.mitigationEpoch <= ob.epoch) {
      failures.push(`order block ${ob.id} mitigated without a later mitigationEpoch`);
    }
  }
  if (ob.invalidated) {
    if (ob.invalidatedEpoch === undefined || ob.invalidatedEpoch <= ob.epoch) {
      failures.push(`order block ${ob.id} invalidated without a later invalidatedEpoch`);
    }
  }
}

export function checkOrderBlocks(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  state: OrderBlockState
): CheckOutcome {
  const failures: string[] = [];
  const notes: string[] = [];
  if (state.symbol !== symbol) failures.push(`orderBlocks symbol ${state.symbol} != ${symbol}`);
  if (state.timeframe !== timeframe) failures.push(`orderBlocks timeframe ${state.timeframe} != ${timeframe}`);

  for (const ob of state.bullishOrderBlocks) {
    if (ob.type !== 'BULLISH') failures.push(`bullishOrderBlocks contains ${ob.type} block ${ob.id}`);
    checkObOne(ob, candles, failures);
  }
  for (const ob of state.bearishOrderBlocks) {
    if (ob.type !== 'BEARISH') failures.push(`bearishOrderBlocks contains ${ob.type} block ${ob.id}`);
    checkObOne(ob, candles, failures);
  }

  const count = state.bullishOrderBlocks.length + state.bearishOrderBlocks.length;
  if (count === 0) notes.push('no order blocks (valid empty result; not treated as a failure)');
  return outcome(failures, count > 0, notes);
}

/**
 * Recomputes the premium/discount zone using the same documented rule as
 * `SMCEngine.computePremiumDiscountZone` and compares it to the reported value.
 */
export function expectedPremiumDiscountZone(
  structure: MarketStructureState,
  candles: Candle[]
): PremiumDiscountZone {
  const latestHigh = structure.latestSwingHigh;
  const latestLow = structure.latestSwingLow;
  if (!latestHigh || !latestLow) return 'WAITING FOR DATA';

  const rangeHigh = Math.max(latestHigh.price, latestLow.price);
  const rangeLow = Math.min(latestHigh.price, latestLow.price);
  const range = rangeHigh - rangeLow;
  if (!(range > 0)) return 'WAITING FOR DATA';

  let lastClosed: Candle | null = null;
  for (const candle of candles) {
    if (candle.isClosed === false) continue;
    if (!lastClosed || candle.epoch > lastClosed.epoch) lastClosed = candle;
  }
  if (!lastClosed) return 'WAITING FOR DATA';

  const equilibrium = (rangeHigh + rangeLow) / 2;
  const band = 0.05 * range;
  const price = lastClosed.close;
  if (price > equilibrium + band) return 'PREMIUM';
  if (price < equilibrium - band) return 'DISCOUNT';
  return 'EQUILIBRIUM';
}

export function checkPremiumDiscount(
  structure: MarketStructureState,
  candles: Candle[],
  zone: PremiumDiscountZone
): CheckOutcome {
  const failures: string[] = [];
  const notes: string[] = [];
  const expected = expectedPremiumDiscountZone(structure, candles);
  if (zone !== expected) {
    failures.push(`premium/discount zone ${zone} != recomputed ${expected}`);
  }
  const exercised = zone !== 'WAITING FOR DATA';
  if (!exercised) notes.push('premium/discount unavailable (valid empty result; not treated as a failure)');
  return outcome(failures, exercised, notes);
}

/**
 * Verifies the dashboard evaluation entry point against the engine's own
 * resolver and the structural/risk invariants of any emitted signal.
 */
export function checkSignalEvaluation(evaluation: PairEvaluation): CheckOutcome {
  const failures: string[] = [];
  const notes: string[] = [];
  const { signal, closedCandleCount } = evaluation;

  if (closedCandleCount === 0) {
    if (signal !== null) failures.push('evaluation produced a signal for an empty history');
    return outcome(failures, false, ['no closed candles; evaluation correctly cleared']);
  }

  if (signal === null) {
    failures.push('evaluation returned null signal with a non-empty history');
    return outcome(failures, false, notes);
  }

  if (signal.decision === 'NO_TRADE') {
    if (signal.confidence !== null) failures.push('NO_TRADE carried a non-null confidence');
    if (signal.setup !== 'NONE') failures.push(`NO_TRADE setup ${signal.setup} != NONE`);
    if (!signal.rejectionReasons || signal.rejectionReasons.length === 0) {
      failures.push('NO_TRADE without a rejection reason');
    }
    return outcome(failures, true, notes);
  }

  // LONG / SHORT
  const { decision, entry, stopLoss, takeProfit, riskReward, confidence } = signal;
  if (entry === null || stopLoss === null || takeProfit === null || riskReward === null) {
    failures.push(`${decision} signal missing entry/stop/target/R:R`);
    return outcome(failures, true, notes);
  }
  if (confidence === null || confidence < 0 || confidence > 100) {
    failures.push(`${decision} signal confidence out of [0,100]`);
  }
  if (decision === 'LONG') {
    if (!(stopLoss < entry && entry < takeProfit)) {
      failures.push(`LONG geometry invalid: stop ${stopLoss}, entry ${entry}, target ${takeProfit}`);
    }
  } else if (decision === 'SHORT') {
    if (!(takeProfit < entry && entry < stopLoss)) {
      failures.push(`SHORT geometry invalid: target ${takeProfit}, entry ${entry}, stop ${stopLoss}`);
    }
  } else {
    failures.push(`unknown decision ${decision}`);
  }
  if (riskReward < 2.0) {
    failures.push(`emitted signal R:R ${riskReward} below minimum 2.0`);
  }
  return outcome(failures, true, notes);
}
