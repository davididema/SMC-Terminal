import { getSymbolConfig, type InstrumentCategory } from './symbols';
import { isClosurePeriod } from './session-closures';
import { historyKey } from './history-init';

export interface TickData {
  symbol: string; // Internal symbol ID (e.g. "EURUSD")
  derivSymbol: string;
  price: number;
  epoch: number; // Unix timestamp in seconds
  pipSize?: number;
  bid?: number;
  ask?: number;
}

export interface Candle {
  epoch: number; // Start epoch of candle period in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // Number of ticks in candle
  isClosed: boolean;
}

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1H' | '4H' | '1D';

export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1H', '4H', '1D'];

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1H': 3600,
  '4H': 14400,
  '1D': 86400,
};

export function assertCandleInvariants(candle: Candle): boolean {
  return (
    candle.high >= candle.low &&
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close) &&
    candle.volume >= 0 &&
    !isNaN(candle.open) &&
    !isNaN(candle.high) &&
    !isNaN(candle.low) &&
    !isNaN(candle.close)
  );
}

export function sanitizeCandle(candle: Candle): Candle {
  const high = Math.max(candle.high, candle.open, candle.close);
  const low = Math.min(candle.low, candle.open, candle.close);
  return {
    ...candle,
    high,
    low,
  };
}

// ---------------------------------------------------------------------------
// Historical candle validation
// ---------------------------------------------------------------------------

/**
 * A historical candle entry as it arrives from the provider.
 *
 * The provider delivers raw JSON, so the shape of an entry is only known once
 * it has been validated. This interface describes what a VALID entry looks
 * like; the validation below decides whether a delivered entry has that shape.
 */
export interface HistoryCandleInput {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Why a delivered historical candle was rejected.
 *
 * - `invalid-epoch`: the epoch is missing, not a finite integer, or negative.
 * - `non-finite-value`: a price (or the volume) is NaN, Infinity, or not a
 *   number at all.
 * - `invalid-ohlc`: the prices break the candle invariants of this project
 *   (the high is below the open/close, the low is above the open/close, ...).
 * - `misaligned-epoch`: the epoch does not sit on the timeframe grid.
 */
export type HistoryRejectionReason =
  | 'invalid-epoch'
  | 'non-finite-value'
  | 'invalid-ohlc'
  | 'misaligned-epoch';

/** The detail of a single rejected historical entry. */
export interface HistoryRejection {
  /** Why the entry was rejected. */
  reason: HistoryRejectionReason;
  /** The epoch of the rejected entry, when it could be read. */
  epoch: number | null;
}

/**
 * The maximum number of rejection details that are reported for one response.
 * A response can carry thousands of entries; the report stays bounded.
 */
export const MAX_HISTORY_REJECTIONS_REPORTED = 5;

/** What a history response contributed to a pair's trusted history. */
export interface HistoryAdmissionSummary {
  /** The number of entries that passed validation. */
  valid: number;
  /** The number of entries that were applied to the trusted history. */
  admitted: number;
  /** The number of entries that were rejected as invalid. */
  rejected: number;
  /** The rejection details (bounded by `MAX_HISTORY_REJECTIONS_REPORTED`). */
  rejections: HistoryRejection[];
}

/** The result of validating a delivered history response. */
export interface HistoryValidationResult {
  /** The entries that may be admitted into the trusted history. */
  valid: HistoryCandleInput[];
  /** The entries that were rejected. */
  rejections: HistoryRejection[];
}

/**
 * Read a delivered value as a finite number.
 *
 * The provider sends JSON, so a price may arrive as a number or as a numeric
 * string. Everything else (null, undefined, booleans, empty strings, objects)
 * is not a number and is refused instead of being coerced into one.
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

type HistoryCandleCheck =
  | { ok: true; candle: HistoryCandleInput }
  | { ok: false; rejection: HistoryRejection };

/**
 * Validate a single delivered history entry.
 *
 * The rules are deliberately strict and never repair a value:
 * - the epoch must be a finite, non-negative integer;
 * - every price must be a finite number;
 * - the prices must satisfy the candle invariants of this project;
 * - the epoch must sit on the timeframe grid.
 *
 * An invalid entry is DROPPED, never "fixed": widening the high or lowering
 * the low of a broken candle would invent prices the provider never sent, and
 * an invented candle in the trusted history is exactly what the analysis must
 * never see.
 */
function checkHistoryCandle(
  raw: unknown,
  periodSeconds: number,
  leadingEpoch: number | null
): HistoryCandleCheck {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, rejection: { reason: 'invalid-epoch', epoch: null } };
  }
  const entry = raw as Record<string, unknown>;

  const epoch = toFiniteNumber(entry.epoch);
  if (epoch === null || !Number.isInteger(epoch) || epoch < 0) {
    return { ok: false, rejection: { reason: 'invalid-epoch', epoch } };
  }

  const open = toFiniteNumber(entry.open);
  const high = toFiniteNumber(entry.high);
  const low = toFiniteNumber(entry.low);
  const close = toFiniteNumber(entry.close);
  if (open === null || high === null || low === null || close === null) {
    return { ok: false, rejection: { reason: 'non-finite-value', epoch } };
  }

  // The volume is optional (the provider sends none) but must be a finite,
  // non-negative number when it is present.
  if (entry.volume !== undefined && entry.volume !== null) {
    const volume = toFiniteNumber(entry.volume);
    if (volume === null || volume < 0) {
      return { ok: false, rejection: { reason: 'non-finite-value', epoch } };
    }
  }

  // The candle invariants of this project decide whether the prices describe a
  // possible candle at all.
  const candidate: Candle = {
    epoch,
    open,
    high,
    low,
    close,
    volume: 1,
    isClosed: true,
  };
  if (!assertCandleInvariants(candidate)) {
    return { ok: false, rejection: { reason: 'invalid-ohlc', epoch } };
  }

  // The epoch must sit on the timeframe grid. Only the OLDEST entry of the
  // response may be off-grid: the provider adjusts the start of the first
  // candle to the requested window (adjust_start_time=1), so that entry is a
  // partial candle whose epoch need not be aligned. Every other entry must be
  // aligned, otherwise it describes a period the timeframe does not have - and
  // such an entry can never satisfy a recovery requirement.
  if (periodSeconds > 0 && epoch % periodSeconds !== 0 && epoch !== leadingEpoch) {
    return { ok: false, rejection: { reason: 'misaligned-epoch', epoch } };
  }

  return { ok: true, candle: { epoch, open, high, low, close } };
}

/**
 * Validate a delivered history response.
 *
 * The valid entries are returned separately from the rejections, so the caller
 * can admit the former and report the latter. A response that mixes valid and
 * invalid entries is therefore usable: the valid part is admitted, the invalid
 * part is rejected and reported.
 */
export function validateHistoryCandles(
  candles: readonly unknown[],
  periodSeconds: number
): HistoryValidationResult {
  const valid: HistoryCandleInput[] = [];
  const rejections: HistoryRejection[] = [];

  // The oldest entry of the response may be the leading partial candle, so its
  // epoch is exempt from the alignment rule. It is found by VALUE (not by
  // position), so a response in any order is treated the same way. An entry
  // with an unusable epoch never grants the exemption.
  let leadingEpoch: number | null = null;
  for (const raw of candles) {
    if (!raw || typeof raw !== 'object') continue;
    const epoch = toFiniteNumber((raw as Record<string, unknown>).epoch);
    if (epoch === null || !Number.isInteger(epoch) || epoch < 0) continue;
    if (leadingEpoch === null || epoch < leadingEpoch) leadingEpoch = epoch;
  }

  for (const raw of candles) {
    const check = checkHistoryCandle(raw, periodSeconds, leadingEpoch);
    if (check.ok) {
      valid.push(check.candle);
    } else {
      rejections.push(check.rejection);
    }
  }

  return { valid, rejections };
}

/**
 * Describe rejected entries for a log line. The description is bounded: a
 * response can carry thousands of invalid entries, the report does not.
 */
export function describeHistoryRejections(
  rejections: readonly HistoryRejection[]
): string {
  if (rejections.length === 0) return '';
  const shown = rejections
    .slice(0, MAX_HISTORY_REJECTIONS_REPORTED)
    .map((r) => (r.epoch === null ? r.reason : `${r.reason}@${r.epoch}`))
    .join(', ');
  const hidden = rejections.length - Math.min(rejections.length, MAX_HISTORY_REJECTIONS_REPORTED);
  return hidden > 0 ? `${shown} (+${hidden} more)` : shown;
}

export type CandleCloseListener = (
  symbol: string,
  timeframe: Timeframe,
  candle: Candle
) => void;

export type CandleUpdateListener = (
  symbol: string,
  timeframe: Timeframe,
  currentCandle: Candle
) => void;

export interface TimeframeCandleState {
  symbol: string;
  timeframe: Timeframe;
  periodSeconds: number;
  currentCandle: Candle | null;
  history: Candle[];
  /**
   * Epoch of the candle that spans a known connection discontinuity.
   * Such a candle can never be finalized as a valid closed candle: the ticks
   * that would have completed it were never observed.
   *
   * It stays marked until a history recovery re-derives that exact period.
   * Dropping the incomplete candle (when a later period starts) does NOT
   * restore its integrity: the period is still missing from the closed
   * history and must be re-derived from authoritative data.
   */
  interruptedEpoch: number | null;
  /**
   * The oldest period that a history recovery must re-derive for this pair.
   * It is the anchor of the gap created by the interruption(s), advanced past
   * any documented closure: a closure period can never be re-derived.
   */
  recoveryEpoch: number | null;
  /**
   * True while the pair must recover its history before any evaluation may
   * resume. It is cleared only by a verified recovery.
   */
  recoveryRequired: boolean;
  /**
   * How many recovery attempts for this pair did not bridge the gap. Each
   * attempt widens the next request, so a response that was too short to reach
   * the interrupted period is retried with a larger window.
   */
  recoveryAttempts: number;
}

/**
 * The largest number of candles a recovery request may ask for. Deriv's
 * `ticks_history` accepts at most 5000 candles per request, so a gap wider
 * than that cannot be bridged by a single recovery request.
 */
export const MAX_RECOVERY_HISTORY_COUNT = 5000;

/**
 * The largest number of bounded history requests a single chunked recovery
 * cycle may issue. A chunked cycle is therefore bounded to
 * `MAX_RECOVERY_CHUNKS * MAX_RECOVERY_HISTORY_COUNT` requested candles and to
 * the same number of candles held in memory.
 */
export const MAX_RECOVERY_CHUNKS = 4;

/**
 * The largest number of periods a bounded recovery can cover: the number of
 * candles the bounded chunk budget may deliver.
 *
 * The completeness check scans the required periods of a gap, so its bound has
 * to match what a bounded recovery can actually deliver. A bound of a single
 * request would let a COMBINED history hide a hole in the periods beyond it.
 */
export const MAX_RECOVERY_COVERED_PERIODS =
  MAX_RECOVERY_CHUNKS * MAX_RECOVERY_HISTORY_COUNT;

/**
 * A generous upper bound on the length of a documented closure window.
 *
 * The longest documented closure (the weekend gap) is under three days, so the
 * gap anchor can be advanced past a closure with a loop that is still bounded.
 * It only bounds the search: the predicates themselves decide what is skipped.
 */
const MAX_CLOSURE_SKIP_SECONDS = 7 * 24 * 60 * 60;

/**
 * What a pair needs from a recovery request before it may leave the
 * "recovery required" state.
 */
export interface RecoveryRequirement {
  /**
   * The oldest period the recovery must re-derive from history.
   *
   * It is always a period that can actually have a candle: when the period
   * right after the known data falls inside a documented market closure, the
   * anchor is advanced past the closure. A closure period itself is never a
   * mandatory anchor, because no history response could ever contain it.
   */
  recoveryEpoch: number;
  /**
   * The period of the candle that spans the CURRENT interruption, or null
   * when no candle is currently marked as interrupted.
   *
   * That candle is incomplete: the ticks that would have completed it were
   * never observed. It can only be restored by authoritative history, so a
   * recovery is not complete until the response re-derives this period too.
   * It is independent of `recoveryEpoch` (the oldest gap anchor): after a
   * second disconnect the anchor is still the oldest gap, while the candle
   * that must be re-derived is the one currently interrupted.
   */
  interruptedEpoch: number | null;
  /** The newest period the pair knows about; a recovery must reach it. */
  liveEpoch: number;
  /** The timeframe period in seconds. */
  periodSeconds: number;
  /** The number of candles a recovery request must fetch to span the gap. */
  requiredCount: number;
  /**
   * The instrument category of the pair, when it is known.
   *
   * It decides which periods may legitimately have no candle: a market that
   * was closed never produces one. A missing period is only excused when it
   * falls inside a documented closure window of this category.
   *
   * When the category is unknown, no period is excused: a missing period is
   * then treated as a genuine gap (fail safe).
   */
  category?: InstrumentCategory;
}

/**
 * The required periods a recovery response does not contain.
 *
 * The required periods are the ones between the oldest gap anchor and the
 * live edge of the pair (the live edge itself is observed live, so it is not
 * required from history): `recoveryEpoch .. liveEpoch - periodSeconds`.
 *
 * A required period is NOT missing when the response carries it, or when the
 * period falls inside a documented closure window of the instrument's
 * category (the market was closed, so it legitimately has no candle).
 * Every other absent period is a genuine gap in the recovered history.
 *
 * The scan is bounded by what a bounded recovery can actually deliver: at
 * most `MAX_RECOVERY_COVERED_PERIODS` periods are inspected. A requirement
 * that spans more periods than that can never be satisfied (the live-edge
 * check in `isRecoveryCovered` refuses it, and a chunked recovery classifies
 * it as oversized), so the bound does not weaken the check.
 *
 * The bound covers the COMBINED history of a chunked recovery, so a hole that
 * sits in the periods beyond a single response's capacity is still found.
 *
 * The check compares epochs only: it never inspects price data.
 */
export function findMissingRequiredPeriods(
  requirement: RecoveryRequirement,
  recoveredEpochs: readonly number[]
): number[] {
  const { recoveryEpoch, liveEpoch, periodSeconds, category } = requirement;
  if (!Number.isFinite(periodSeconds) || periodSeconds <= 0) return [];

  const first = Math.floor(recoveryEpoch / periodSeconds) * periodSeconds;
  const last = Math.floor((liveEpoch - periodSeconds) / periodSeconds) * periodSeconds;
  if (last < first) return [];

  const total = Math.floor((last - first) / periodSeconds) + 1;
  const inspected = Math.min(total, MAX_RECOVERY_COVERED_PERIODS);

  const recovered = new Set(recoveredEpochs);
  const missing: number[] = [];
  for (let i = 0; i < inspected; i++) {
    const period = first + i * periodSeconds;
    if (recovered.has(period)) continue;
    // A period in which the market was closed legitimately has no candle.
    if (category !== undefined && isClosurePeriod(period, category)) continue;
    missing.push(period);
  }
  return missing;
}

/**
 * True when a recovered history covers the interruption: it re-derives the
 * oldest required period (unless that period is itself a documented closure,
 * which legitimately has no candle), re-derives the candle that is CURRENTLY
 * interrupted (so a second disconnect cannot be recovered with a history that
 * still misses it), reaches the live edge of the pair (so the merged history is
 * not stale), and contains EVERY required period between the gap anchor and the
 * live edge (so a response that skips periods in the middle of the gap cannot
 * be mistaken for a complete history).
 *
 * The check never inspects price data: it compares epochs only.
 */
export function isRecoveryCovered(
  requirement: RecoveryRequirement,
  recoveredEpochs: readonly number[]
): boolean {
  if (recoveredEpochs.length === 0) return false;
  // The oldest required period is normally mandatory: re-deriving it is what
  // proves the gap was bridged. A documented closure period, however, can never
  // appear in a response (the market did not trade), so demanding that exact
  // epoch would make the requirement impossible and the pair could never be
  // released. It is exempt for exactly the reason the interior scan exempts it.
  // The interrupted candle and every TRADING period of the gap are still
  // required, so a closure never excuses missing trading data.
  const anchorIsClosure =
    requirement.category !== undefined &&
    isClosurePeriod(requirement.recoveryEpoch, requirement.category);
  if (!anchorIsClosure && !recoveredEpochs.includes(requirement.recoveryEpoch)) {
    return false;
  }
  // The candle that spans the current interruption must be re-derived as well.
  // Recovering the oldest gap anchor alone leaves that candle incomplete, and
  // it would later be finalized as if it were a valid close.
  if (
    requirement.interruptedEpoch !== null &&
    !recoveredEpochs.includes(requirement.interruptedEpoch)
  ) {
    return false;
  }
  let newest = recoveredEpochs[0];
  for (const epoch of recoveredEpochs) {
    if (epoch > newest) newest = epoch;
  }
  if (newest < requirement.liveEpoch - requirement.periodSeconds) return false;
  // The response may not skip periods inside the gap: a history with a hole in
  // the middle is not a recovered history.
  return findMissingRequiredPeriods(requirement, recoveredEpochs).length === 0;
}

export interface SymbolCandleState {
  symbol: string;
  timeframes: Map<Timeframe, TimeframeCandleState>;
  /**
   * The event time of the newest ACCEPTED market event of this symbol.
   *
   * This is the symbol's live edge: the recovery coverage is measured against
   * it and the history merge uses it as its reference time. It therefore only
   * ever advances - an out-of-order tick never moves it backwards.
   */
  lastTickTime: number | null;
  /**
   * The price of the newest accepted market event. It belongs to the same
   * event as `lastTickTime`, so the two are always updated together.
   */
  lastPrice: number | null;
  tickCount: number;
}

export class CandleManager {
  private states = new Map<string, SymbolCandleState>();
  private closeListeners: Set<CandleCloseListener> = new Set();
  private updateListeners: Set<CandleUpdateListener> = new Set();
  private maxHistory: number;
  /**
   * The most recent admission outcome per pair, so a rejected history entry
   * can be reported instead of disappearing silently.
   */
  private historyAdmissions = new Map<string, HistoryAdmissionSummary>();

  constructor(maxHistory = 1000) {
    this.maxHistory = maxHistory;
  }

  public getOrCreateSymbolState(symbol: string): SymbolCandleState {
    let state = this.states.get(symbol);
    if (!state) {
      const tfMap = new Map<Timeframe, TimeframeCandleState>();
      for (const tf of TIMEFRAMES) {
        tfMap.set(tf, {
          symbol,
          timeframe: tf,
          periodSeconds: TIMEFRAME_SECONDS[tf],
          currentCandle: null,
          history: [],
          interruptedEpoch: null,
          recoveryEpoch: null,
          recoveryRequired: false,
          recoveryAttempts: 0,
        });
      }

      state = {
        symbol,
        timeframes: tfMap,
        lastTickTime: null,
        lastPrice: null,
        tickCount: 0,
      };
      this.states.set(symbol, state);
    }
    return state;
  }

  /** The symbols this manager currently holds candle state for. */
  public getTrackedSymbols(): string[] {
    return Array.from(this.states.keys());
  }

  public getState(symbol: string): SymbolCandleState | undefined {
    return this.states.get(symbol);
  }

  public getTimeframeState(symbol: string, timeframe: Timeframe): TimeframeCandleState | undefined {
    const symState = this.states.get(symbol);
    return symState?.timeframes.get(timeframe);
  }

  public getHistory(symbol: string, timeframe: Timeframe): Candle[] {
    const tfState = this.getTimeframeState(symbol, timeframe);
    return tfState ? [...tfState.history] : [];
  }

  public getCurrentCandle(symbol: string, timeframe: Timeframe): Candle | null {
    const tfState = this.getTimeframeState(symbol, timeframe);
    return tfState?.currentCandle ? { ...tfState.currentCandle } : null;
  }

  public getAllCandles(symbol: string, timeframe: Timeframe): Candle[] {
    const tfState = this.getTimeframeState(symbol, timeframe);
    if (!tfState) return [];
    const list = [...tfState.history];
    if (tfState.currentCandle) {
      const idx = list.findIndex((c) => c.epoch === tfState.currentCandle!.epoch);
      if (idx >= 0) {
        list[idx] = { ...tfState.currentCandle };
      } else {
        list.push({ ...tfState.currentCandle });
      }
    }
    return list;
  }

  public onCandleClose(listener: CandleCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  public onCandleUpdate(listener: CandleUpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  /**
   * Process an incoming tick for a symbol and update all supported timeframes.
   *
   * The tracked event time is the time of the newest ACCEPTED market event of
   * the symbol. It is the pair's live edge: the recovery coverage is measured
   * against it and the history merge uses it as its reference time, so it must
   * never move backwards. A tick whose event time is older than the tracked one
   * is out of order: it must neither overwrite the live edge nor be applied to
   * a forming candle, because the newest accepted event already determines that
   * candle's state. A tick whose event time cannot be interpreted at all is
   * dropped: it must neither move the live edge nor produce a candle on an
   * unusable period.
   */
  public processTick(tick: TickData): void {
    const symState = this.getOrCreateSymbolState(tick.symbol);
    symState.tickCount += 1;

    // An event time that cannot be interpreted is rejected, exactly like the
    // historical validation rejects one: it must be a finite number that is
    // not negative. (The raw payload parser is stricter - it rejects a
    // non-positive epoch - but the candle manager also receives ticks from
    // other sources, and epoch 0 is a valid period there.)
    const epoch = tick.epoch;
    const usable = Number.isFinite(epoch) && epoch >= 0;
    const outOfOrder =
      usable && symState.lastTickTime !== null && epoch < symState.lastTickTime;

    if (usable && !outOfOrder) {
      // The newest accepted market event: its time and its price belong
      // together, so an out-of-order tick replaces neither of them.
      symState.lastTickTime = epoch;
      symState.lastPrice = tick.price;
    }

    if (!usable) {
      return;
    }

    // Process tick across all configured timeframes
    for (const tf of TIMEFRAMES) {
      const tfState = symState.timeframes.get(tf);
      if (tfState) {
        this.updateTimeframeCandle(tfState, tick, outOfOrder);
      }
    }
  }

  private updateTimeframeCandle(
    tfState: TimeframeCandleState,
    tick: TickData,
    outOfOrder: boolean
  ): void {
    // A tick older than the newest accepted event can only belong to the
    // current or an earlier period. Applying it to the current forming candle
    // would regress that candle's accepted close/high/low and volume even
    // though the symbol-level live edge correctly refuses to move. Reject it
    // here, at the candle boundary, so accepted state stays monotonic within
    // every timeframe. Equal timestamps are not out of order, so a duplicate
    // tick at the same epoch still updates the candle as before.
    if (outOfOrder) return;

    const periodSeconds = tfState.periodSeconds;
    const candlePeriod = Math.floor(tick.epoch / periodSeconds) * periodSeconds;

    if (!tfState.currentCandle) {
      // Check if last historical candle matches this ongoing period
      if (tfState.history.length > 0) {
        const lastHist = tfState.history[tfState.history.length - 1];
        if (lastHist.epoch === candlePeriod) {
          // Promote historical candle to active forming candle and update with live tick
          tfState.history.pop();
          tfState.currentCandle = {
            ...lastHist,
            high: Math.max(lastHist.high, tick.price),
            low: Math.min(lastHist.low, tick.price),
            close: tick.price,
            volume: (lastHist.volume || 1) + 1,
            isClosed: false,
          };
          this.emitUpdate(tfState.symbol, tfState.timeframe, tfState.currentCandle);
          return;
        } else if (lastHist.epoch > candlePeriod) {
          // Out-of-order tick older than history; skip
          return;
        }
      }

      // Start initial forming candle
      const newCandle: Candle = {
        epoch: candlePeriod,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: 1,
        isClosed: false,
      };
      tfState.currentCandle = newCandle;
      this.emitUpdate(tfState.symbol, tfState.timeframe, newCandle);
      return;
    }

    if (candlePeriod === tfState.currentCandle.epoch) {
      // Update ongoing candle
      const c = tfState.currentCandle;
      c.high = Math.max(c.high, tick.price);
      c.low = Math.min(c.low, tick.price);
      c.close = tick.price;
      c.volume += 1;
      this.emitUpdate(tfState.symbol, tfState.timeframe, c);
    } else if (candlePeriod > tfState.currentCandle.epoch) {
      const interrupted =
        tfState.interruptedEpoch !== null &&
        tfState.interruptedEpoch === tfState.currentCandle.epoch;

      if (interrupted) {
        // The forming candle spans a known connection discontinuity: the ticks
        // that would have completed it were never observed, so it must NEVER be
        // finalized as a valid closed candle. It is dropped (not closed, not
        // pushed to history) and re-derived by the history recovery instead.
        //
        // Dropping it does NOT restore its integrity: the interrupted period
        // stays marked until a recovery re-derives it, so the recovery
        // requirement survives the rollover.
        tfState.currentCandle = null;
      } else {
        // Finalize previous candle
        tfState.currentCandle.isClosed = true;
        const finalized = sanitizeCandle(tfState.currentCandle);
        tfState.history.push(finalized);
        if (tfState.history.length > this.maxHistory) {
          tfState.history.shift();
        }

        this.emitClose(tfState.symbol, tfState.timeframe, finalized);
      }

      // Start new candle for new timeframe period
      const newCandle: Candle = {
        epoch: candlePeriod,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: 1,
        isClosed: false,
      };
      tfState.currentCandle = newCandle;
      this.emitUpdate(tfState.symbol, tfState.timeframe, newCandle);
    }
  }

  /**
   * Seed completed candles from Deriv history endpoint.
   * Seamlessly transitions into live candle formation without duplicates or gaps.
   *
   * The response is validated BEFORE anything is admitted: an invalid entry
   * never enters the trusted history, and the rejected entries are reported
   * through the returned admission summary (and `getLastHistoryAdmission`).
   */
  public seedHistory(
    symbol: string,
    timeframe: Timeframe,
    candles: readonly HistoryCandleInput[]
  ): HistoryAdmissionSummary {
    const symState = this.getOrCreateSymbolState(symbol);
    const tfState = symState.timeframes.get(timeframe);
    if (!tfState) {
      return { valid: 0, admitted: 0, rejected: 0, rejections: [] };
    }

    const validation = validateHistoryCandles(candles, tfState.periodSeconds);
    const summary = this.recordAdmission(symbol, timeframe, validation);
    if (validation.valid.length === 0) {
      // Nothing admissible: the trusted history is left untouched.
      return summary;
    }

    this.applySeededHistory(symState, tfState, validation.valid);
    summary.admitted = validation.valid.length;
    return summary;
  }

  /**
   * The most recent admission outcome of a pair, or null when the pair never
   * received a history response.
   */
  public getLastHistoryAdmission(
    symbol: string,
    timeframe: Timeframe
  ): HistoryAdmissionSummary | null {
    return this.historyAdmissions.get(historyKey(symbol, timeframe)) ?? null;
  }

  /** Remember what a validated response contributed to the pair. */
  private recordAdmission(
    symbol: string,
    timeframe: Timeframe,
    validation: HistoryValidationResult
  ): HistoryAdmissionSummary {
    const summary: HistoryAdmissionSummary = {
      valid: validation.valid.length,
      admitted: 0,
      rejected: validation.rejections.length,
      rejections: validation.rejections.slice(0, MAX_HISTORY_REJECTIONS_REPORTED),
    };
    this.historyAdmissions.set(historyKey(symbol, timeframe), summary);
    return summary;
  }

  /**
   * Merge validated historical candles into the pair's closed history.
   *
   * The entries are already known to be valid, so this step only performs the
   * merge: the existing history, the live forming candle and the incoming
   * candles are combined by epoch, without duplicates.
   */
  private applySeededHistory(
    symState: SymbolCandleState,
    tfState: TimeframeCandleState,
    candles: readonly HistoryCandleInput[]
  ): void {
    const periodSeconds = tfState.periodSeconds;
    // Reference time used to decide whether the newest candle is still forming.
    // Prefer the most recent live tick (the newest reliable time we actually
    // observed); only fall back to wall-clock time when no tick has ever been
    // seen for this symbol. A stale tick must never be treated as "now".
    const referenceTime = symState.lastTickTime ?? Math.floor(Date.now() / 1000);
    const currentPeriodBoundary = Math.floor(referenceTime / periodSeconds) * periodSeconds;
    // Format and sanitize incoming candles
    const formatted: Candle[] = candles.map((c) => {
      const high = Math.max(c.high, c.open, c.close);
      const low = Math.min(c.low, c.open, c.close);
      return {
        epoch: c.epoch,
        open: c.open,
        high,
        low,
        close: c.close,
        volume: 1,
        isClosed: true,
      };
    });

    // Merge existing history, existing current candle, and incoming formatted candles by epoch
    const epochMap = new Map<number, Candle>();
    for (const c of tfState.history) {
      epochMap.set(c.epoch, c);
    }
    if (tfState.currentCandle) {
      epochMap.set(tfState.currentCandle.epoch, tfState.currentCandle);
    }
    for (const c of formatted) {
      const existing = epochMap.get(c.epoch);
      if (existing && existing.volume > 1) {
        // Keep accumulated live volume and quote extremes
        epochMap.set(c.epoch, {
          ...c,
          high: Math.max(c.high, existing.high),
          low: Math.min(c.low, existing.low),
          close: existing.close,
          volume: existing.volume,
          isClosed: existing.isClosed,
        });
      } else {
        epochMap.set(c.epoch, c);
      }
    }

    const sorted = Array.from(epochMap.values()).sort((a, b) => a.epoch - b.epoch);
    if (sorted.length === 0) return;

    // Decide whether the newest candle is the ongoing (still-forming) period.
    // It qualifies only when the live reference time actually falls inside that
    // candle's period [epoch, epoch + period). A stale tick must NOT promote a
    // completed candle merely because it is the newest element of the array.
    const latest = sorted[sorted.length - 1];
    const latestIsForming =
      latest.epoch <= referenceTime && referenceTime < latest.epoch + periodSeconds;
    if (latestIsForming) {
      // The newest candle contains the live reference time: it is still forming
      // and must be kept out of the closed history.
      sorted.pop();
      latest.isClosed = false;
      tfState.currentCandle = latest;
    } else {
      // Every candle in the sequence is closed. Drop any live forming candle
      // that no longer belongs to the current period, or that history has
      // superseded (a stale live tick), so no phantom candle can linger.
      if (
        tfState.currentCandle &&
        (tfState.currentCandle.epoch !== currentPeriodBoundary ||
          tfState.currentCandle.epoch <= latest.epoch)
      ) {
        tfState.currentCandle = null;
      }
    }

    // Assign sanitized closed history
    if (sorted.length > this.maxHistory) {
      sorted.splice(0, sorted.length - this.maxHistory);
    }
    tfState.history = sorted;
  }

  /**
   * Record a connection discontinuity for a symbol.
   *
   * A discontinuity means the ticks of an unknown stretch of time were never
   * observed. The forming candle that spans it is incomplete, and the periods
   * after it are missing entirely. The symbol is therefore marked as requiring
   * a history recovery before any evaluation may run on it again.
   *
   * This is idempotent: repeated calls keep the OLDEST gap anchor (the
   * earliest period that still has to be re-derived) while the interrupted
   * candle refers to the candle that spans the discontinuity - the one that is
   * currently forming, or the one that was already dropped but has not been
   * re-derived by a recovery yet.
   */
  public markDiscontinuity(symbol: string): void {
    const symState = this.states.get(symbol);
    if (!symState) return; // Nothing observed for this symbol yet: no gap to mark.

    for (const tf of TIMEFRAMES) {
      const tfState = symState.timeframes.get(tf);
      if (!tfState) continue;

      const anchor = this.computeGapAnchor(symState, tfState);
      if (anchor === null) continue;

      // The candle that is currently forming spans the discontinuity.
      if (tfState.currentCandle) {
        tfState.interruptedEpoch = tfState.currentCandle.epoch;
      }

      tfState.recoveryEpoch =
        tfState.recoveryEpoch === null ? anchor : Math.min(tfState.recoveryEpoch, anchor);
      tfState.recoveryRequired = true;
    }
  }

  /** True while the pair must recover its history before it may be evaluated. */
  public isRecoveryRequired(symbol: string, timeframe: Timeframe): boolean {
    return this.getTimeframeState(symbol, timeframe)?.recoveryRequired === true;
  }

  /**
   * What the pair needs from a recovery request, or null when no recovery is
   * pending.
   */
  public getRecoveryRequirement(
    symbol: string,
    timeframe: Timeframe
  ): RecoveryRequirement | null {
    const symState = this.states.get(symbol);
    const tfState = symState?.timeframes.get(timeframe);
    if (!symState || !tfState || !tfState.recoveryRequired) return null;

    const recoveryEpoch = tfState.recoveryEpoch;
    if (recoveryEpoch === null) return null;

    const periodSeconds = tfState.periodSeconds;
    const newestKnown =
      tfState.history.length > 0 ? tfState.history[tfState.history.length - 1].epoch : null;
    let liveEpoch = this.liveEdgeEpoch(symState, tfState) ?? newestKnown ?? recoveryEpoch;
    if (liveEpoch < recoveryEpoch) liveEpoch = recoveryEpoch;

    const requiredCount = Math.floor((liveEpoch - recoveryEpoch) / periodSeconds) + 1;
    return {
      recoveryEpoch,
      interruptedEpoch: tfState.interruptedEpoch,
      liveEpoch,
      periodSeconds,
      requiredCount,
      // The category decides which periods may legitimately have no candle
      // (a closed market produces none). An unknown symbol has no documented
      // closure, so none of its periods is excused.
      category: getSymbolConfig(symbol)?.category,
    };
  }

  /**
   * The number of candles a recovery request must ask for: enough to span the
   * gap, but never fewer than the pair's normal backfill size and never more
   * than the provider's maximum. Every failed attempt doubles that lower
   * bound, so a retry asks for a wider window than the attempt before it.
   */
  public getRecoveryHistoryCount(
    symbol: string,
    timeframe: Timeframe,
    fallback: number
  ): number {
    const requirement = this.getRecoveryRequirement(symbol, timeframe);
    if (!requirement) return fallback;
    const attempts = this.getTimeframeState(symbol, timeframe)?.recoveryAttempts ?? 0;
    const lowerBound = Math.min(
      fallback * Math.pow(2, Math.max(0, attempts)),
      MAX_RECOVERY_HISTORY_COUNT
    );
    const count = Math.max(requirement.requiredCount, lowerBound);
    return Math.min(count, MAX_RECOVERY_HISTORY_COUNT);
  }

  /**
   * Apply a history response as a RECOVERY for an interrupted pair.
   *
   * Returns true only when the response actually covers the interruption: it
   * re-derives the oldest interrupted period, re-derives the candle that is
   * currently interrupted, and reaches the live edge. An insufficient response
   * leaves the pair in the recovery-required state, so nothing can be
   * evaluated on a history with a known gap.
   *
   * The response is validated FIRST: an invalid entry can neither enter the
   * trusted history nor stand in for a required period. The coverage is
   * therefore computed from the valid entries only, so a garbled entry can
   * never satisfy a recovery requirement.
   *
   * A re-derived period is authoritative: it replaces the incomplete live
   * candle and is never finalized later as a live close event.
   */
  public recoverFromHistory(
    symbol: string,
    timeframe: Timeframe,
    candles: readonly HistoryCandleInput[]
  ): boolean {
    const symState = this.getOrCreateSymbolState(symbol);
    const tfState = symState.timeframes.get(timeframe);
    if (!tfState || candles.length === 0) return false;

    const validation = validateHistoryCandles(candles, tfState.periodSeconds);
    const summary = this.recordAdmission(symbol, timeframe, validation);
    const valid = validation.valid;

    if (!tfState.recoveryRequired) {
      // No interruption is pending: the response is an ordinary backfill.
      tfState.recoveryAttempts = 0;
      if (valid.length > 0) {
        this.applySeededHistory(symState, tfState, valid);
        summary.admitted = valid.length;
      }
      return true;
    }

    const requirement = this.getRecoveryRequirement(symbol, timeframe);
    if (!requirement) {
      tfState.recoveryAttempts += 1;
      return false;
    }

    if (valid.length === 0) {
      // Nothing admissible: the gap stays open and the next attempt asks for a
      // wider window.
      tfState.recoveryAttempts += 1;
      return false;
    }

    // The coverage is computed from the VALID entries only: an invalid entry
    // can never stand in for a required period.
    const epochs = valid.map((c) => c.epoch);
    if (!isRecoveryCovered(requirement, epochs)) {
      // The response did not bridge the gap: the next attempt asks for a wider
      // window.
      tfState.recoveryAttempts += 1;
      return false;
    }

    // The candle that spans the current interruption must have been re-derived
    // by this very response. Recovering the oldest gap anchor alone is not
    // enough: it would release the pair while that candle is still
    // incomplete, and the pair would then finalize it as a valid close.
    if (tfState.interruptedEpoch !== null && !epochs.includes(tfState.interruptedEpoch)) {
      tfState.recoveryAttempts += 1;
      return false;
    }

    this.applyAuthoritativeHistory(symState, tfState, valid);
    summary.admitted = valid.length;
    tfState.interruptedEpoch = null;
    tfState.recoveryEpoch = null;
    tfState.recoveryRequired = false;
    tfState.recoveryAttempts = 0;
    return true;
  }

  /**
   * The oldest period a recovery must re-derive for this pair, or null when
   * the pair's data is complete.
   *
   * The anchor is always a period that can actually have a candle. When the
   * first period after the known data falls inside a documented market closure
   * (a weekend or a Metals daily halt), that period can never be re-derived by
   * any response, so the anchor is advanced to the first period after the
   * closure instead. Only the documented closures of a KNOWN category are
   * skipped: an unknown category excuses nothing (fail safe).
   */
  private computeGapAnchor(
    symState: SymbolCandleState,
    tfState: TimeframeCandleState
  ): number | null {
    const periodSeconds = tfState.periodSeconds;

    // The forming candle spans the discontinuity: it is incomplete and has to
    // be re-derived from history.
    if (tfState.currentCandle) return tfState.currentCandle.epoch;

    // Otherwise the gap starts right after the newest period the pair holds.
    const newestHistory =
      tfState.history.length > 0 ? tfState.history[tfState.history.length - 1].epoch : null;
    const liveEdge = this.liveEdgeEpoch(symState, tfState);
    const covered = [newestHistory, liveEdge].filter((e): e is number => e !== null);
    if (covered.length === 0) return null;

    const through = Math.max(...covered);
    let anchor = Math.floor(through / periodSeconds) * periodSeconds + periodSeconds;

    const category = getSymbolConfig(symState.symbol)?.category;
    if (category !== undefined) {
      const maxPeriodsToSkip = Math.ceil(MAX_CLOSURE_SKIP_SECONDS / periodSeconds) + 1;
      for (let i = 0; i < maxPeriodsToSkip && isClosurePeriod(anchor, category); i++) {
        anchor += periodSeconds;
      }
    }
    return anchor;
  }

  /** The period boundary of the newest live tick observed for a symbol. */
  private liveEdgeEpoch(
    symState: SymbolCandleState,
    tfState: TimeframeCandleState
  ): number | null {
    if (symState.lastTickTime === null) return null;
    return (
      Math.floor(symState.lastTickTime / tfState.periodSeconds) * tfState.periodSeconds
    );
  }

  /**
   * Merge an authoritative (recovered) history into the pair's state.
   *
   * The recovered candles win over the incomplete live data they replace. The
   * live forming candle is kept only when its period was not re-derived, so a
   * re-derived period can never be finalized later as a live close event.
   */
  private applyAuthoritativeHistory(
    symState: SymbolCandleState,
    tfState: TimeframeCandleState,
    candles: readonly HistoryCandleInput[]
  ): void {
    const periodSeconds = tfState.periodSeconds;
    const referenceTime = symState.lastTickTime ?? Math.floor(Date.now() / 1000);
    const interruptedEpoch = tfState.interruptedEpoch;

    const epochMap = new Map<number, Candle>();
    for (const c of tfState.history) {
      epochMap.set(c.epoch, c);
    }
    const forming = tfState.currentCandle;

    for (const c of candles) {
      const high = Math.max(c.high, c.open, c.close);
      const low = Math.min(c.low, c.open, c.close);
      const authoritative: Candle = {
        epoch: c.epoch,
        open: c.open,
        high,
        low,
        close: c.close,
        volume: 1,
        isClosed: true,
      };
      const existing = epochMap.get(c.epoch);
      if (existing && c.epoch !== interruptedEpoch) {
        // Keep the live accumulation, but take the authoritative extremes.
        epochMap.set(c.epoch, {
          ...authoritative,
          high: Math.max(high, existing.high),
          low: Math.min(low, existing.low),
          close: existing.close,
          volume: existing.volume,
          isClosed: existing.isClosed,
        });
      } else {
        epochMap.set(c.epoch, authoritative);
      }
    }

    const sorted = Array.from(epochMap.values()).sort((a, b) => a.epoch - b.epoch);
    if (sorted.length === 0) return;

    let nextForming: Candle | null = forming;
    if (forming) {
      const rederived = candles.some((c) => c.epoch === forming.epoch);
      if (rederived) {
        const authoritative = sorted.find((c) => c.epoch === forming.epoch);
        const periodHoldsReference =
          referenceTime >= forming.epoch && referenceTime < forming.epoch + periodSeconds;
        if (authoritative && periodHoldsReference && forming.epoch !== interruptedEpoch) {
          // The period is still running: keep the live candle, enriched with
          // the authoritative extremes.
          nextForming = {
            ...authoritative,
            close: forming.close,
            volume: forming.volume,
            isClosed: false,
          };
        } else {
          // The re-derived candle is authoritative and complete: the live
          // candle is dropped and can never be closed as a live event.
          nextForming = null;
        }
      }
    }

    if (nextForming) {
      const idx = sorted.findIndex((c) => c.epoch === nextForming!.epoch);
      if (idx >= 0) sorted.splice(idx, 1);
    }
    if (sorted.length > this.maxHistory) {
      sorted.splice(0, sorted.length - this.maxHistory);
    }
    tfState.history = sorted;
    tfState.currentCandle = nextForming;
  }

  private emitClose(symbol: string, timeframe: Timeframe, candle: Candle): void {
    for (const listener of this.closeListeners) {
      try {
        listener(symbol, timeframe, candle);
      } catch (err) {
        console.error('[CandleManager] Error in close listener:', err);
      }
    }
  }

  private emitUpdate(symbol: string, timeframe: Timeframe, candle: Candle): void {
    for (const listener of this.updateListeners) {
      try {
        listener(symbol, timeframe, candle);
      } catch (err) {
        console.error('[CandleManager] Error in update listener:', err);
      }
    }
  }

  public clear(): void {
    this.states.clear();
    this.historyAdmissions.clear();
  }
}
