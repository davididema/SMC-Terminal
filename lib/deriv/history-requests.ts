/**
 * Connection-scoped registry of in-flight historical candle requests.
 *
 * The websocket client registers a request when it is sent and removes it when
 * the response (or an error) arrives. If a connection closes before a response,
 * the registry fails every request belonging to that connection generation so
 * the dashboard can clear its pending marker and retry on the next connection.
 * Requests belonging to other generations are preserved, so a stale socket's
 * cleanup can never resolve or invalidate a newer request.
 *
 * A request may also be armed with a bounded timeout. If no response arrives in
 * time the registry retires exactly that request (keyed by its unique id) and
 * delivers an empty result, so the dashboard clears its pending marker and the
 * pair becomes retryable. Because request ids are never reused, a timeout can
 * only ever retire the request it was created for.
 */

import { Timeframe } from './candles';

export interface HistoryCandleData {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Why a history request reached its callback:
 * - `success`: a non-empty candle array was returned.
 * - `empty`: a valid response arrived, but it carried no candles.
 * - `failure`: the request errored, timed out, or was malformed.
 * - `abandoned`: the owning connection closed before a response arrived.
 *
 * `success`/`empty` are only produced by a delivered response;
 * `failure`/`abandoned` are produced by the registry when no usable response
 * was applied. Callers use this discriminator to decide whether a bounded
 * retry is warranted (see `history-recovery.ts`).
 */
export type HistoryRequestOutcome =
  | 'success'
  | 'empty'
  | 'failure'
  | 'abandoned';

export type HistoryRequestCallback = (
  symbol: string,
  timeframe: Timeframe,
  candles: HistoryCandleData[],
  outcome?: HistoryRequestOutcome
) => void;

export interface HistoryRequestEntry {
  symbol: string;
  timeframe: Timeframe;
  callback: HistoryRequestCallback;
  generation: number;
}

export interface HistoryRequestRegistryOptions {
  /** Invoked immediately before an in-flight request is retired by its timeout. */
  onTimeout?: (entry: HistoryRequestEntry) => void;
}

export class HistoryRequestRegistry {
  private requests = new Map<number, HistoryRequestEntry>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private onTimeout?: (entry: HistoryRequestEntry) => void;

  constructor(options: HistoryRequestRegistryOptions = {}) {
    this.onTimeout = options.onTimeout;
  }

  /**
   * Register a request. When `timeoutMs` is a finite positive number the
   * request is retired automatically if no response arrives in time. The timer
   * is never the sole reason the process stays alive.
   */
  public add(requestId: number, entry: HistoryRequestEntry, timeoutMs?: number): void {
    this.requests.set(requestId, entry);
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const timer = setTimeout(() => this.handleTimeout(requestId), timeoutMs);
      // Do not keep a process alive solely for a history timeout (Node timer).
      (timer as { unref?: () => void }).unref?.();
      this.timers.set(requestId, timer);
    }
  }

  public has(requestId: number): boolean {
    return this.requests.has(requestId);
  }

  public size(): number {
    return this.requests.size;
  }

  private clearTimer(requestId: number): void {
    const timer = this.timers.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    this.timers.delete(requestId);
  }

  /**
   * Retire a request whose timeout expired. Only the matching request id is
   * affected; if it was already resolved/failed/abandoned this is a no-op.
   */
  private handleTimeout(requestId: number): void {
    this.timers.delete(requestId);
    const entry = this.requests.get(requestId);
    if (!entry) return;
    this.requests.delete(requestId);
    this.onTimeout?.(entry);
    entry.callback(entry.symbol, entry.timeframe, [], 'failure');
  }

  /**
   * Remove and return a request. Removing before the caller invokes the
   * callback guarantees a given response is applied at most once, even if a
   * late or duplicate message references the same id. The request's timeout is
   * cleared so a resolved/failed request can never fire later.
   */
  public take(requestId: number): HistoryRequestEntry | undefined {
    const entry = this.requests.get(requestId);
    if (entry) {
      this.requests.delete(requestId);
      this.clearTimer(requestId);
    }
    return entry;
  }

  /**
   * Fail each in-flight request of `generation` with an empty candle list and
   * remove it (clearing its timer). Delivered as `abandoned`: the owning
   * connection closed, so recovery is the reconnect path's responsibility.
   * Requests of other generations are left untouched.
   */
  public failGeneration(generation: number): void {
    for (const [requestId, entry] of Array.from(this.requests.entries())) {
      if (entry.generation !== generation) continue;
      this.requests.delete(requestId);
      this.clearTimer(requestId);
      entry.callback(entry.symbol, entry.timeframe, [], 'abandoned');
    }
  }

  /**
   * Fail and remove every in-flight request (clearing all timers). Delivered as
   * `abandoned` for the same reason as `failGeneration`.
   */
  public failAll(): void {
    for (const [requestId, entry] of Array.from(this.requests.entries())) {
      this.requests.delete(requestId);
      this.clearTimer(requestId);
      entry.callback(entry.symbol, entry.timeframe, [], 'abandoned');
    }
  }
}
