/**
 * Historical candle backfill planning.
 *
 * Decides whether a given (symbol, timeframe) pair still needs its historical
 * candle backfill. Backfill readiness is tracked explicitly by pair rather than
 * inferred from the number of candles currently held, because live tick
 * aggregation can create a handful of candles before history is ever requested.
 */

export type HistoryLoadPlan =
  | 'request'
  | 'skip-seeded'
  | 'skip-pending'
  | 'no-client';

/** Stable identity for a symbol/timeframe pair. */
export function historyKey(symbolId: string, timeframe: string): string {
  return `${symbolId}:${timeframe}`;
}

/**
 * Backfill bookkeeping owned by the dashboard: pairs whose history has been
 * seeded successfully, and pairs with a request currently in flight.
 */
export interface HistoryBookkeeping {
  seeded: Set<string>;
  pending: Set<string>;
}

export function createHistoryBookkeeping(): HistoryBookkeeping {
  return { seeded: new Set<string>(), pending: new Set<string>() };
}

/** Mark a pair as having an outstanding history request. */
export function markHistoryPending(
  bookkeeping: HistoryBookkeeping,
  symbolId: string,
  timeframe: string
): void {
  bookkeeping.pending.add(historyKey(symbolId, timeframe));
}

/**
 * Apply the outcome of a history request: the pending marker is always cleared
 * (success, failure, or connection loss), and the pair is only marked seeded
 * when candles were actually returned. A failed request therefore leaves the
 * pair retryable rather than permanently pending.
 */
export function applyHistoryOutcome(
  bookkeeping: HistoryBookkeeping,
  symbolId: string,
  timeframe: string,
  candleCount: number
): void {
  const key = historyKey(symbolId, timeframe);
  bookkeeping.pending.delete(key);
  if (candleCount > 0) {
    bookkeeping.seeded.add(key);
  }
}

/**
 * Determine the next action for a pair's historical backfill.
 *
 * - Already seeded successfully -> skip-seeded
 * - Request currently in flight -> skip-pending (deduplicates concurrent calls)
 * - No websocket client available -> no-client
 * - Otherwise -> request
 *
 * When `recoveryRequired` is set the pair must re-derive the period that spans
 * a connection discontinuity, so the 'skip-seeded' shortcut does not apply:
 * a pair that was seeded before the gap still has to be re-requested. The
 * in-flight and client checks stay in force.
 *
 * Note: the amount of live candle history is deliberately NOT an input. A pair
 * with live candles but no completed backfill must still yield 'request'.
 */
export function planHistoryLoad(
  symbolId: string,
  timeframe: string,
  seeded: ReadonlySet<string>,
  pending: ReadonlySet<string>,
  hasClient: boolean,
  recoveryRequired = false
): HistoryLoadPlan {
  const key = historyKey(symbolId, timeframe);
  if (recoveryRequired) {
    // The pair must re-derive the period that spans a connection discontinuity:
    // the 'skip-seeded' shortcut does not apply, but an in-flight request is
    // still deduplicated and a missing client still blocks the request.
    if (pending.has(key)) return 'skip-pending';
    if (!hasClient) return 'no-client';
    return 'request';
  }
  if (seeded.has(key)) return 'skip-seeded';
  if (pending.has(key)) return 'skip-pending';
  if (!hasClient) return 'no-client';
  return 'request';
}
