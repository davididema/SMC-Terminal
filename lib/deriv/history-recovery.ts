/**
 * Bounded, connection-scoped recovery for failed or empty historical candle
 * requests.
 *
 * The request registry (see `history-requests.ts`) retires an unanswered or
 * malformed request so its pair is no longer stuck "in flight"; this controller
 * consumes that outcome and re-issues the request a bounded number of times
 * while the WebSocket stays connected. It never fabricates data: a retry only
 * re-sends the same request, and the delivered response flows through the exact
 * same callback path as the original.
 *
 * Recovery state is isolated per `${symbol}:${timeframe}` pair and is only ever
 * driven by explicit history outcomes. Live feed transitions (LIVE/STALE) can
 * never schedule a retry, so an unstable tick feed cannot cause a retry storm.
 * A connection loss is delivered as `abandoned` and is never recovered here —
 * the reconnect path re-requests the active pair from scratch.
 *
 * This module also owns the rule that connects a delivered response to the
 * pair's retry budget: the transport outcome describes the REQUEST (did a
 * response arrive, was it malformed, was the connection lost), while the
 * pair's recovery state describes whether the response actually bridged an
 * open gap. The two are distinct, and a response that carries candles but does
 * NOT cover the gap is never a successful recovery — it consumes the budget
 * instead of resetting it.
 */

import { CandleManager, Timeframe, type HistoryRejection } from './candles';
import { historyKey } from './history-init';
import type { HistoryCandleData, HistoryRequestOutcome } from './history-requests';

export interface HistoryRecoveryPolicy {
  /** Maximum number of automatic retries per pair. */
  maxAttempts: number;
  /** Delay in milliseconds before a scheduled retry is attempted. */
  delayMs: number;
}

export const DEFAULT_HISTORY_RECOVERY_POLICY: HistoryRecoveryPolicy = {
  maxAttempts: 3,
  delayMs: 3000,
};

export interface HistoryRecoveryControllerOptions {
  policy?: Partial<HistoryRecoveryPolicy>;
  /**
   * Whether a retry is currently permitted for the pair. Checked both when a
   * retry is scheduled and again immediately before it fires, so a retry can
   * never run for a pair that is no longer selected, no longer connected, or
   * whose market feed is closed/unavailable.
   */
  canRetry: (symbol: string, timeframe: Timeframe) => boolean;
  /** Re-issue the history request for the pair (the actual retry action). */
  onRetry: (symbol: string, timeframe: Timeframe) => void;
}

export class HistoryRecoveryController {
  private readonly policy: HistoryRecoveryPolicy;
  private readonly canRetry: (symbol: string, timeframe: Timeframe) => boolean;
  private readonly onRetry: (symbol: string, timeframe: Timeframe) => void;

  /** Retries scheduled so far, keyed by `${symbol}:${timeframe}`. */
  private attempts = new Map<string, number>();

  /** Pending retry timers, keyed by `${symbol}:${timeframe}`. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: HistoryRecoveryControllerOptions) {
    this.policy = {
      maxAttempts: options.policy?.maxAttempts ?? DEFAULT_HISTORY_RECOVERY_POLICY.maxAttempts,
      delayMs: options.policy?.delayMs ?? DEFAULT_HISTORY_RECOVERY_POLICY.delayMs,
    };
    this.canRetry = options.canRetry;
    this.onRetry = options.onRetry;
  }

  public attemptsFor(symbol: string, timeframe: Timeframe): number {
    return this.attempts.get(historyKey(symbol, timeframe)) ?? 0;
  }

  public isScheduled(symbol: string, timeframe: Timeframe): boolean {
    return this.timers.has(historyKey(symbol, timeframe));
  }

  public hasAttemptsLeft(symbol: string, timeframe: Timeframe): boolean {
    return this.attemptsFor(symbol, timeframe) < this.policy.maxAttempts;
  }

  /**
   * Consume a history request outcome.
   * - `success` resets the pair's retry budget and clears any pending timer.
   * - `abandoned` clears any pending timer but never retries (the connection is
   *   gone; the reconnect path owns re-requesting).
   * - `empty`/`failure` schedule at most one bounded retry.
   */
  public handleOutcome(
    symbol: string,
    timeframe: Timeframe,
    outcome: HistoryRequestOutcome
  ): void {
    if (outcome === 'success') {
      this.reset(symbol, timeframe);
      return;
    }
    if (outcome === 'abandoned') {
      this.cancel(symbol, timeframe);
      return;
    }
    this.scheduleRetry(symbol, timeframe);
  }

  /** Clear a pair's pending retry and reset its retry budget. */
  public reset(symbol: string, timeframe: Timeframe): void {
    const key = historyKey(symbol, timeframe);
    this.clearTimer(key);
    this.attempts.delete(key);
  }

  /** Clear a pair's pending retry without touching its retry budget. */
  public cancel(symbol: string, timeframe: Timeframe): void {
    this.clearTimer(historyKey(symbol, timeframe));
  }

  /**
   * Schedule a bounded retry for a pair whose last attempt did not produce
   * usable data (for example a recovery response that did not bridge the gap).
   * The retry obeys the same budget and the same `canRetry` gate as an
   * outcome-driven retry.
   */
  public requestRetry(symbol: string, timeframe: Timeframe): void {
    this.scheduleRetry(symbol, timeframe);
  }

  /** Clear every pending retry (retry budgets are preserved). */
  public cancelAll(): void {
    for (const key of Array.from(this.timers.keys())) {
      this.clearTimer(key);
    }
  }

  private scheduleRetry(symbol: string, timeframe: Timeframe): void {
    const key = historyKey(symbol, timeframe);

    // At most one timer per pair: a duplicate outcome must not stack retries.
    if (this.timers.has(key)) return;
    if (!this.hasAttemptsLeft(symbol, timeframe)) return;
    if (!this.canRetry(symbol, timeframe)) return;

    this.attempts.set(key, this.attemptsFor(symbol, timeframe) + 1);
    const timer = setTimeout(() => {
      // Delete before firing so a pair whose retry fails can schedule again,
      // and so a stale timer can never run twice.
      this.timers.delete(key);
      if (!this.canRetry(symbol, timeframe)) return;
      this.onRetry(symbol, timeframe);
    }, this.policy.delayMs);
    // Do not keep a process alive solely for a recovery timer (Node timer).
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(key, timer);
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}

/**
 * The outcome that must drive a pair's retry budget for a delivered history
 * response.
 *
 * The transport outcome says nothing about the pair's recovery state: a
 * response may carry plenty of candles and still fail to bridge the gap the
 * pair has to recover from. Reporting such a response as a success resets the
 * pair's retry budget, so every attempt starts over with a full allowance and
 * the pair is re-requested without end. An open gap that this response did not
 * bridge is therefore reported as a retryable failure: it consumes the budget
 * instead of resetting it.
 *
 * - `abandoned` is preserved: a dropped connection is recovered by the
 *   reconnect path, never by a retry here.
 * - An incomplete recovery is never a success: a would-be success is reported
 *   as a retryable failure instead, so it consumes the budget. Every other
 *   outcome keeps its own meaning (`empty` and `failure` are both retryable).
 * - Otherwise the transport outcome is used; a caller that delivers a response
 *   without an outcome falls back to the legacy derivation (candles present →
 *   success, no candles → failure).
 */
export function resolveHistoryRecoveryOutcome(input: {
  /** The transport outcome delivered with the response (may be absent). */
  requestOutcome?: HistoryRequestOutcome;
  /** The number of candles the response carried. */
  candleCount: number;
  /** True when the pair had an open gap that this response had to bridge. */
  recoveryPending: boolean;
  /** True when the response actually bridged that gap. */
  recoveryComplete: boolean;
}): HistoryRequestOutcome {
  const { requestOutcome, candleCount, recoveryPending, recoveryComplete } = input;

  if (requestOutcome === 'abandoned') return 'abandoned';

  // A caller that delivers a response without an outcome falls back to the
  // legacy derivation (candles present → success, no candles → failure).
  const derived = requestOutcome ?? (candleCount > 0 ? 'success' : 'failure');

  // An open gap that this response did not bridge is never a success: it
  // consumes the budget instead of resetting it. Every other outcome keeps its
  // own meaning ('empty' and 'failure' are both retryable).
  if (derived === 'success' && recoveryPending && !recoveryComplete) return 'failure';

  return derived;
}

/** What a delivered history response did to the pair and to its retry budget. */
export interface HistoryResponseApplication {
  /** The outcome that drove the pair's retry budget. */
  outcome: HistoryRequestOutcome;
  /** True while the pair still has an open history gap. */
  recoveryPending: boolean;
  /** True when the response bridged the gap (or no gap was open). */
  recoveryComplete: boolean;
  /** True when a gap was open and this response did not bridge it. */
  recoveryIncomplete: boolean;
  /**
   * True when the pair's retry budget is spent and no retry is pending: the
   * pair stays blocked until its history is reloaded explicitly (or the
   * connection is re-established).
   */
  retriesExhausted: boolean;
  /**
   * The number of entries of the response that were admitted into the trusted
   * history. A response can carry candles and still admit none of them (all
   * rejected as invalid): that is not a usable backfill.
   */
  admittedCandleCount: number;
  /** The number of entries of the response that were rejected as invalid. */
  rejectedCandleCount: number;
  /** The rejection details (bounded). */
  rejectedCandles: HistoryRejection[];
}

export interface ApplyHistoryResponseInput {
  /** The candle manager that owns the pair's history and recovery state. */
  manager: CandleManager;
  /** The bounded retry budget; null when no controller is active. */
  controller: HistoryRecoveryController | null;
  symbol: string;
  timeframe: Timeframe;
  /** The candles the response carried (may be empty). */
  candles: HistoryCandleData[];
  /** The transport outcome delivered with the response (may be absent). */
  requestOutcome?: HistoryRequestOutcome;
}

/**
 * Apply a delivered history response to a pair and drive the pair's bounded
 * retry budget from it.
 *
 * The response is applied first (as an ordinary backfill, or as a recovery
 * when the pair has an open gap) and the resulting state decides the outcome
 * that drives the budget. The manager validates the response before it admits
 * anything, so a response that carried only invalid entries delivers no usable
 * history: it is reported as a retryable failure instead of a success.
 * Exactly one retry is scheduled per pair: the controller owns the timer, so a
 * response never schedules a retry of its own.
 */
export function applyHistoryResponse(
  input: ApplyHistoryResponseInput
): HistoryResponseApplication {
  const { manager, controller, symbol, timeframe, requestOutcome } = input;
  const candles = Array.isArray(input.candles) ? input.candles : [];

  // A gap that is open when the response arrives must be bridged by it.
  const recoveryRequired = manager.isRecoveryRequired(symbol, timeframe);

  let recoveryComplete = !recoveryRequired;
  if (candles.length > 0) {
    if (recoveryRequired) {
      // The response is only accepted as a recovery when it actually bridges
      // the gap; an insufficient response leaves the pair blocked.
      recoveryComplete = manager.recoverFromHistory(symbol, timeframe, candles);
    } else {
      manager.seedHistory(symbol, timeframe, candles);
    }
  }

  // What the response actually contributed: the manager validated it before
  // admitting anything, so an invalid entry never reached the trusted history.
  const admission =
    candles.length > 0 ? manager.getLastHistoryAdmission(symbol, timeframe) : null;
  const admittedCandleCount = admission ? admission.admitted : 0;
  const rejectedCandleCount = admission ? admission.rejected : 0;
  const rejectedCandles = admission ? admission.rejections : [];

  let outcome = resolveHistoryRecoveryOutcome({
    requestOutcome,
    candleCount: candles.length,
    recoveryPending: recoveryRequired,
    recoveryComplete,
  });

  // A response that carried candles but admitted NONE of them delivered no
  // usable history: it is a retryable failure, not a success. Reporting it as
  // a success would reset the pair's retry budget and let the pair be
  // re-requested without end, while its history stays empty.
  if (outcome === 'success' && candles.length > 0 && admittedCandleCount === 0) {
    outcome = 'failure';
  }

  // The controller owns the retry timer: a response never schedules a retry of
  // its own, so a pair can never stack two retries.
  if (controller) {
    controller.handleOutcome(symbol, timeframe, outcome);
  }

  const retryable = outcome === 'failure' || outcome === 'empty';
  const retriesExhausted =
    retryable &&
    controller !== null &&
    !controller.hasAttemptsLeft(symbol, timeframe) &&
    !controller.isScheduled(symbol, timeframe);

  return {
    outcome,
    recoveryPending: manager.isRecoveryRequired(symbol, timeframe),
    recoveryComplete,
    recoveryIncomplete: recoveryRequired && !recoveryComplete,
    retriesExhausted,
    admittedCandleCount,
    rejectedCandleCount,
    rejectedCandles,
  };
}
