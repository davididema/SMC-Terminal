/**
 * Bounded chunked recovery (D5).
 *
 * The provider delivers at most `MAX_RECOVERY_HISTORY_COUNT` candles per
 * history request. A recovery gap that is wider than that can therefore never
 * be bridged by a single response: the oldest required period is simply never
 * returned, the completeness check (D3) refuses the pair, and the pair stays
 * blocked until its bounded budget is spent.
 *
 * This module bridges such a gap with a BOUNDED number of bounded requests:
 *
 * - the required interval is split into windows of at most
 *   `MAX_RECOVERY_HISTORY_COUNT` candles, so every request stays inside the
 *   provider limit;
 * - each window is requested with an explicit end epoch, and the next window
 *   ends at the OLDEST period the previous windows actually delivered. The
 *   windows therefore overlap by (at least) one period, so no required period
 *   can be skipped between two of them, and the chain does not depend on one
 *   specific interpretation of the provider's end marker;
 * - nothing is admitted into the trusted history before the whole cycle is
 *   complete. The combined history is validated with the D4 rules, and the D3
 *   completeness rules are applied to the COMBINED history, so an invalid entry
 *   can neither be admitted nor stand in for a required period;
 * - the pair is released only when the combined history covers the complete
 *   required interval AND the interrupted candle has been re-derived. The
 *   requirement is re-read from the manager before the release, so a live tick
 *   that advanced the recovery edge while the windows were being fetched keeps
 *   the pair blocked;
 * - the work is bounded: at most `MAX_RECOVERY_CHUNKS` requests per cycle, at
 *   most `MAX_RECOVERY_CHUNKS * MAX_RECOVERY_HISTORY_COUNT` candles in memory,
 *   and the pair's ordinary bounded retry budget still governs how often a
 *   cycle may be started.
 *
 * The state is isolated per `${symbol}:${timeframe}` pair, and every cycle
 * carries its own identity: a response that belongs to a superseded cycle is
 * ignored, so a stale response can neither complete a newer cycle nor
 * overwrite newer trusted state.
 */

import {
  MAX_HISTORY_REJECTIONS_REPORTED,
  MAX_RECOVERY_CHUNKS,
  MAX_RECOVERY_HISTORY_COUNT,
  findMissingRequiredPeriods,
  isRecoveryCovered,
  validateHistoryCandles,
  type CandleManager,
  type HistoryRejection,
  type RecoveryRequirement,
  type Timeframe,
} from './candles';
import { historyKey } from './history-init';
import type { HistoryRecoveryController } from './history-recovery';
import type { HistoryCandleData, HistoryRequestOutcome } from './history-requests';

export { MAX_RECOVERY_CHUNKS };

/**
 * How a recovery gap has to be served.
 *
 * - `single-request`: the whole gap fits into one bounded request. The
 *   ordinary recovery path serves it; no chunking is involved.
 * - `chunked`: the gap is wider than one request but still inside the bounded
 *   chunk budget. It is served by several bounded requests.
 * - `oversized`: the gap is wider than the bounded chunk budget. It can never
 *   be bridged by this architecture: the pair stays blocked and the gap is
 *   classified explicitly.
 */
export type RecoveryGapSize = 'single-request' | 'chunked' | 'oversized';

/** The bounded plan for a pair's recovery gap. */
export interface RecoveryChunkPlan {
  /** The oldest required period boundary. */
  from: number;
  /** The newest required period boundary (the period before the live edge). */
  to: number;
  /** The number of required periods between `from` and `to`. */
  requiredCount: number;
  /** The timeframe period in seconds. */
  periodSeconds: number;
  /** The number of bounded requests the plan may issue. */
  maxChunks: number;
  /** The number of periods the bounded budget can cover at best. */
  capacity: number;
  /** How the gap has to be served. */
  size: RecoveryGapSize;
}

/**
 * Plan the bounded recovery of a gap.
 *
 * The plan is derived from the requirement alone: the oldest required period
 * (the gap anchor) and the newest required period (the period before the live
 * edge), both snapped onto the timeframe grid of the requirement.
 */
export function planRecoveryChunks(
  requirement: RecoveryRequirement,
  maxChunks: number = MAX_RECOVERY_CHUNKS
): RecoveryChunkPlan {
  const period = requirement.periodSeconds;
  const chunks = Math.max(1, Math.floor(maxChunks));

  if (!Number.isFinite(period) || period <= 0) {
    return {
      from: requirement.recoveryEpoch,
      to: requirement.liveEpoch,
      requiredCount: 0,
      periodSeconds: period,
      maxChunks: chunks,
      capacity: 0,
      size: 'single-request',
    };
  }

  const from = Math.floor(requirement.recoveryEpoch / period) * period;
  const to = Math.floor((requirement.liveEpoch - period) / period) * period;
  const requiredCount = to < from ? 0 : Math.floor((to - from) / period) + 1;

  // Every window repeats one boundary period of the window before it, and the
  // newest window spends one of its candles on the live (still forming)
  // candle, so the bounded budget covers `chunks * (MAX - 1)` distinct
  // required periods at best.
  const capacity = chunks * (MAX_RECOVERY_HISTORY_COUNT - 1);

  const size: RecoveryGapSize =
    requiredCount <= MAX_RECOVERY_HISTORY_COUNT
      ? 'single-request'
      : requiredCount <= capacity
        ? 'chunked'
        : 'oversized';

  return { from, to, requiredCount, periodSeconds: period, maxChunks: chunks, capacity, size };
}

/**
 * The transport the coordinator uses to request a bounded window of history.
 *
 * `end` is null for the newest window (the provider's "latest"), and an epoch
 * for every following window.
 */
export interface RecoveryChunkTransport {
  fetchHistoryWindow(
    symbol: string,
    timeframe: Timeframe,
    count: number,
    end: number | null,
    callback: (candles: HistoryCandleData[], outcome: HistoryRequestOutcome) => void
  ): void;
}

/** What a finished recovery cycle did to the pair and to its retry budget. */
export interface RecoveryCycleResult {
  symbol: string;
  timeframe: Timeframe;
  /** The outcome that drove the pair's retry budget. */
  outcome: HistoryRequestOutcome;
  /** True when the combined history covered the complete required interval. */
  recoveryComplete: boolean;
  /** The number of bounded requests the cycle issued. */
  requestCount: number;
  /** The number of candles the cycle delivered. */
  candleCount: number;
  /** The number of entries the cycle delivered that were admitted. */
  admittedCandleCount: number;
  /** The number of invalid entries the cycle delivered. */
  rejectedCandleCount: number;
  /** The rejection details (bounded). */
  rejectedCandles: HistoryRejection[];
  /**
   * True when the gap is wider than the bounded chunk budget: no request can
   * bridge it and the pair stays blocked until its history is reloaded.
   */
  oversized: boolean;
  /** True while the pair still has an open history gap. */
  recoveryPending: boolean;
  /** The number of required periods of the gap. */
  requiredCount: number;
  /** The number of bounded requests the cycle was allowed to issue. */
  maxChunks: number;
}

/** What a call to `RecoveryChunkCoordinator.start` decided. */
export type RecoveryChunkStart =
  | { kind: 'no-recovery' }
  | { kind: 'single-request' }
  | { kind: 'chunked'; plan: RecoveryChunkPlan }
  | { kind: 'oversized'; plan: RecoveryChunkPlan };

interface RecoveryCycle {
  /** The identity of this cycle. A response of a superseded cycle is ignored. */
  id: number;
  plan: RecoveryChunkPlan;
  /** The raw entries every window delivered so far (deduplicated by epoch). */
  entries: HistoryCandleData[];
  /** The epochs that were already collected (the windows overlap by design). */
  seenEpochs: Set<number>;
  /** The number of requests the cycle issued. */
  requests: number;
  /**
   * The oldest GRID-ALIGNED epoch the cycle received. It is the end marker of
   * the next window, so the windows overlap by one period and no required
   * period can be skipped between two of them.
   */
  boundary: number | null;
  /**
   * The newest epoch the cycle received.
   */
  newestEpoch: number | null;
  /**
   * The end marker of the window that is currently outstanding. It is null for
   * the newest window (the provider's "latest").
   */
  issuedBoundary: number | null;
  /** The number of invalid entries the cycle received. */
  rejected: number;
  /** The rejection details (bounded). */
  rejections: HistoryRejection[];
}

/**
 * Read the epoch of a delivered entry, if it can be read at all.
 *
 * The delivered data is untrusted, so an unusable epoch is simply ignored
 * here: the entry is still validated (and rejected) by the D4 rules before
 * anything is admitted.
 */
function usableEpoch(candle: HistoryCandleData | undefined): number | null {
  if (!candle || typeof candle !== 'object') return null;
  const epoch = Number((candle as { epoch?: unknown }).epoch);
  if (!Number.isFinite(epoch) || !Number.isInteger(epoch) || epoch < 0) return null;
  return epoch;
}

/**
 * Drives the bounded chunked recovery of a pair whose gap is wider than a
 * single history request.
 */
export class RecoveryChunkCoordinator {
  private readonly manager: CandleManager;
  private readonly transport: RecoveryChunkTransport;
  private readonly controller: HistoryRecoveryController | null;
  private readonly onCycleEnd: ((result: RecoveryCycleResult) => void) | undefined;

  /** The running cycle per pair, keyed by `${symbol}:${timeframe}`. */
  private readonly cycles = new Map<string, RecoveryCycle>();
  private nextCycleId = 1;

  constructor(options: {
    manager: CandleManager;
    transport: RecoveryChunkTransport;
    controller?: HistoryRecoveryController | null;
    onCycleEnd?: (result: RecoveryCycleResult) => void;
  }) {
    this.manager = options.manager;
    this.transport = options.transport;
    this.controller = options.controller ?? null;
    this.onCycleEnd = options.onCycleEnd;
  }

  /** True while a chunked recovery cycle is running for the pair. */
  public isActive(symbol: string, timeframe: Timeframe): boolean {
    return this.cycles.has(historyKey(symbol, timeframe));
  }

  /**
   * Start the recovery of a pair.
   *
   * - A pair without an open gap needs nothing.
   * - A gap that fits into one bounded request is served by the ordinary
   *   recovery path; the caller keeps using it.
   * - A wider gap starts a bounded chunk cycle.
   * - A gap that is wider than the bounded chunk budget is classified
   *   explicitly: no request is issued, the pair stays blocked, and the pair's
   *   bounded budget is consumed (never reset), so the impossible window is
   *   never requested again and again.
   */
  public start(symbol: string, timeframe: Timeframe): RecoveryChunkStart {
    const requirement = this.manager.getRecoveryRequirement(symbol, timeframe);
    if (!requirement) return { kind: 'no-recovery' };

    const key = historyKey(symbol, timeframe);

    // A cycle that is already running owns the pair: a retry that arrives
    // while it is running must not start a second chain, and the ordinary
    // recovery path must not deliver a partial history next to it.
    if (this.cycles.has(key)) {
      return { kind: 'chunked', plan: planRecoveryChunks(requirement) };
    }

    const plan = planRecoveryChunks(requirement);
    if (plan.size === 'single-request') return { kind: 'single-request' };

    if (plan.size === 'oversized') {
      this.reportOversized(symbol, timeframe, plan);
      return { kind: 'oversized', plan };
    }

    const cycle: RecoveryCycle = {
      id: this.nextCycleId,
      plan,
      entries: [],
      seenEpochs: new Set<number>(),
      requests: 0,
      boundary: null,
      newestEpoch: null,
      issuedBoundary: null,
      rejected: 0,
      rejections: [],
    };
    this.nextCycleId += 1;

    // A new cycle supersedes the previous one: a response of the previous
    // cycle can no longer complete this one.
    this.cycles.set(key, cycle);

    // The newest window asks for the provider's latest candles. Every following
    // window ends at the oldest period the previous ones delivered.
    this.issue(symbol, timeframe, cycle, null);
    return { kind: 'chunked', plan };
  }

  /** Abandon the running cycle of a pair (its budget is left untouched). */
  public cancel(symbol: string, timeframe: Timeframe): void {
    this.cycles.delete(historyKey(symbol, timeframe));
  }

  /** Abandon every running cycle. */
  public cancelAll(): void {
    this.cycles.clear();
  }

  /**
   * Report a gap that is wider than the bounded chunk budget.
   *
   * The gap can never be bridged by this architecture: no request is issued,
   * the pair stays blocked, and the pair's bounded budget is consumed (never
   * reset) so the retry policy stays bounded.
   */
  private reportOversized(
    symbol: string,
    timeframe: Timeframe,
    plan: RecoveryChunkPlan
  ): void {
    this.controller?.handleOutcome(symbol, timeframe, 'failure');
    this.onCycleEnd?.({
      symbol,
      timeframe,
      outcome: 'failure',
      recoveryComplete: false,
      requestCount: 0,
      candleCount: 0,
      admittedCandleCount: 0,
      rejectedCandleCount: 0,
      rejectedCandles: [],
      oversized: true,
      recoveryPending: this.manager.isRecoveryRequired(symbol, timeframe),
      requiredCount: plan.requiredCount,
      maxChunks: plan.maxChunks,
    });
  }

  /** Issue the next bounded window of a cycle. */
  private issue(
    symbol: string,
    timeframe: Timeframe,
    cycle: RecoveryCycle,
    end: number | null
  ): void {
    if (cycle.requests >= cycle.plan.maxChunks) {
      // The bounded chunk budget is spent: the gap stays open and the pair
      // keeps its bounded retry budget.
      this.finish(symbol, timeframe, cycle, 'failure');
      return;
    }

    const count = end === null ? this.firstWindowCount(cycle) : this.nextWindowCount(cycle);
    cycle.requests += 1;
    cycle.issuedBoundary = end;

    this.transport.fetchHistoryWindow(symbol, timeframe, count, end, (candles, outcome) => {
      this.handleWindow(symbol, timeframe, cycle, candles, outcome);
    });
  }

  /**
   * The number of candles the newest window asks for: the required periods of
   * the gap, plus the live candle that completes the interrupted period.
   */
  private firstWindowCount(cycle: RecoveryCycle): number {
    return Math.min(
      MAX_RECOVERY_HISTORY_COUNT,
      Math.max(1, cycle.plan.requiredCount + 1)
    );
  }

  /**
   * The number of candles the next window asks for: the periods from the gap
   * anchor up to the boundary the cycle has reached, plus one period of
   * overlap.
   *
   * The extra period makes the chain independent of the provider's end marker:
   * a provider that ends a window ON the requested epoch and a provider that
   * ends it BEFORE the requested epoch both deliver a contiguous range that
   * reaches the anchor. Without the overlap, the second interpretation would
   * leave a single period uncovered.
   */
  private nextWindowCount(cycle: RecoveryCycle): number {
    const boundary = cycle.boundary;
    if (boundary === null) return MAX_RECOVERY_HISTORY_COUNT;
    const span =
      Math.floor((boundary - cycle.plan.from) / cycle.plan.periodSeconds) + 1;
    return Math.min(MAX_RECOVERY_HISTORY_COUNT, Math.max(1, span + 1));
  }

  /** Consume the response of one bounded window. */
  private handleWindow(
    symbol: string,
    timeframe: Timeframe,
    cycle: RecoveryCycle,
    candles: HistoryCandleData[],
    outcome: HistoryRequestOutcome
  ): void {
    const key = historyKey(symbol, timeframe);

    // A response of a superseded cycle is ignored: it must never complete a
    // newer cycle and must never overwrite newer trusted state.
    if (this.cycles.get(key) !== cycle) return;

    if (outcome === 'abandoned') {
      // The connection is gone: the reconnect path re-requests the pair. No
      // budget is consumed here (a dropped connection is not a failure of the
      // recovery itself).
      this.cycles.delete(key);
      this.controller?.handleOutcome(symbol, timeframe, 'abandoned');
      this.emit(symbol, timeframe, cycle, 'abandoned', false, 0);
      return;
    }

    if (outcome !== 'success' || !Array.isArray(candles) || candles.length === 0) {
      // A failed or empty window leaves the gap open. The budget is consumed
      // (never reset), so the cycle cannot be repeated without end.
      this.finish(symbol, timeframe, cycle, 'failure');
      return;
    }

    this.accumulate(cycle, candles);

    // The window must have EXTENDED the covered range. If the provider ignored
    // the end marker and delivered the same data again, the cycle would repeat
    // the very same window until the chunk budget is spent.
    const issuedBoundary = cycle.issuedBoundary;
    if (issuedBoundary !== null && (cycle.boundary === null || cycle.boundary >= issuedBoundary)) {
      this.finish(symbol, timeframe, cycle, 'failure');
      return;
    }

    const requirement = this.manager.getRecoveryRequirement(symbol, timeframe);
    if (!requirement) {
      // The pair needs no recovery any more: the cycle has nothing to bridge.
      this.cycles.delete(key);
      this.controller?.handleOutcome(symbol, timeframe, 'success');
      this.emit(symbol, timeframe, cycle, 'success', true, 0);
      return;
    }

    // The combined history is validated with the D4 rules before any period
    // may count as covered: an invalid entry can never stand in for a required
    // period.
    const validation = validateHistoryCandles(cycle.entries, requirement.periodSeconds);
    cycle.rejected = validation.rejections.length;
    cycle.rejections = validation.rejections.slice(0, MAX_HISTORY_REJECTIONS_REPORTED);

    if (isRecoveryCovered(requirement, validation.valid.map((c) => c.epoch))) {
      // The whole required interval is present. The pair may be released.
      this.finish(symbol, timeframe, cycle, 'success');
      return;
    }

    const missing = findMissingRequiredPeriods(
      requirement,
      validation.valid.map((c) => c.epoch)
    );
    if (missing.length === 0) {
      // Every required period is present, yet the coverage refuses: the
      // interrupted period or the live edge is missing. Older windows cannot
      // deliver it, so the gap stays open.
      this.finish(symbol, timeframe, cycle, 'failure');
      return;
    }

    const oldestMissing = missing[0];
    const newestMissing = missing[missing.length - 1];
    const newestDelivered = cycle.newestEpoch;
    const oldestDelivered = cycle.boundary;

    if (newestDelivered !== null && newestMissing > newestDelivered) {
      // The live edge moved past the delivered range while the cycle was
      // running: the newest window has to be requested again, because the
      // missing periods are the NEWEST ones.
      this.issue(symbol, timeframe, cycle, null);
      return;
    }

    if (oldestDelivered === null || oldestMissing >= oldestDelivered) {
      // The provider skipped periods inside the delivered range: a hole in the
      // middle of the history can never be bridged by another window.
      this.finish(symbol, timeframe, cycle, 'failure');
      return;
    }

    if (oldestDelivered <= cycle.plan.from) {
      // The cycle already reached the anchor of the gap and the gap is still
      // open: the provider does not deliver the missing periods. Requesting
      // another window would ask for the very same data again.
      this.finish(symbol, timeframe, cycle, 'failure');
      return;
    }

    this.issue(symbol, timeframe, cycle, oldestDelivered);
  }

  /** Collect the delivered entries of a window. */
  private accumulate(cycle: RecoveryCycle, candles: readonly HistoryCandleData[]): void {
    const period = cycle.plan.periodSeconds;
    for (const entry of candles) {
      const epoch = usableEpoch(entry);
      if (epoch !== null) {
        // The windows overlap by one period on purpose: the same candle can be
        // delivered twice. It is collected once.
        if (cycle.seenEpochs.has(epoch)) continue;
        cycle.seenEpochs.add(epoch);
        if (cycle.newestEpoch === null || epoch > cycle.newestEpoch) {
          cycle.newestEpoch = epoch;
        }
        if (period > 0 && epoch % period === 0) {
          if (cycle.boundary === null || epoch < cycle.boundary) cycle.boundary = epoch;
        }
      }
      cycle.entries.push(entry);
    }
  }

  /**
   * Finish a cycle.
   *
   * A successful cycle applies the combined history as the authoritative
   * recovery of the pair (the manager re-checks the completeness rules
   * against its own current requirement, so a live tick that advanced the
   * recovery edge keeps the pair blocked). A failed cycle admits nothing at
   * all.
   */
  private finish(
    symbol: string,
    timeframe: Timeframe,
    cycle: RecoveryCycle,
    outcome: HistoryRequestOutcome
  ): void {
    const key = historyKey(symbol, timeframe);
    this.cycles.delete(key);

    let finalOutcome: HistoryRequestOutcome = outcome;
    let recoveryComplete = false;
    let admitted = 0;

    if (outcome === 'success') {
      recoveryComplete = this.manager.recoverFromHistory(symbol, timeframe, cycle.entries);
      if (!recoveryComplete) {
        // The manager refused the combined history (its requirement moved on
        // while the windows were fetched): the pair stays blocked.
        finalOutcome = 'failure';
      } else {
        const admission = this.manager.getLastHistoryAdmission(symbol, timeframe);
        admitted = admission ? admission.admitted : 0;
        if (admitted === 0) finalOutcome = 'failure';
      }
    }

    this.controller?.handleOutcome(symbol, timeframe, finalOutcome);
    this.emit(symbol, timeframe, cycle, finalOutcome, recoveryComplete, admitted);
  }

  private emit(
    symbol: string,
    timeframe: Timeframe,
    cycle: RecoveryCycle,
    outcome: HistoryRequestOutcome,
    recoveryComplete: boolean,
    admitted: number
  ): void {
    this.onCycleEnd?.({
      symbol,
      timeframe,
      outcome,
      recoveryComplete,
      requestCount: cycle.requests,
      candleCount: cycle.entries.length,
      admittedCandleCount: admitted,
      rejectedCandleCount: cycle.rejected,
      rejectedCandles: cycle.rejections,
      oversized: false,
      recoveryPending: this.manager.isRecoveryRequired(symbol, timeframe),
      requiredCount: cycle.plan.requiredCount,
      maxChunks: cycle.plan.maxChunks,
    });
  }
}
