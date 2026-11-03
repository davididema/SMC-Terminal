import {
  DerivSymbolConfig,
  getSymbolConfig,
  SUPPORTED_SYMBOLS,
} from './symbols';
import { TickData, Timeframe, TIMEFRAME_SECONDS, MAX_RECOVERY_HISTORY_COUNT } from './candles';
import {
  HistoryRequestRegistry,
  type HistoryRequestCallback,
} from './history-requests';
import {
  deriveFeedState,
  parseTick,
  symbolFromSubscriptionError,
  type FeedStatus,
} from './feed';

export type ConnectionStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'ERROR';

export interface WebSocketConfig {
  appId?: string;
  endpoint?: string;
  pingIntervalMs?: number;
  reconnectBaseDelayMs?: number;
  maxReconnectDelayMs?: number;
  staleThresholdSeconds?: number;
  historyTimeoutMs?: number;
}

export interface DerivLogEntry {
  id: string;
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export type TickListener = (tick: TickData) => void;
export type StatusListener = (status: ConnectionStatus) => void;
export type LogListener = (entry: DerivLogEntry) => void;
export type StaleListener = (symbol: string, isStale: boolean, secondsSinceLastTick: number) => void;
export type FeedStatusListener = (status: FeedStatus) => void;
export type CandleHistoryCallback = HistoryRequestCallback;

export const DEFAULT_DERIV_WS_ENDPOINT =
  'wss://api.derivws.com/trading/v1/options/ws/public';

// Conservative bound for a public WebSocket history request. A request that
// receives no response (or a malformed one that cannot be matched) within this
// window is retired so its pair is no longer stuck as "in flight".
export const DEFAULT_HISTORY_TIMEOUT_MS = 20_000;

export class DerivWebSocketClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'DISCONNECTED';
  private appId: string;
  private endpoint: string;
  private pingIntervalMs: number;
  private reconnectBaseDelayMs: number;
  private maxReconnectDelayMs: number;
  private staleThresholdSeconds: number;
  private historyTimeoutMs: number;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private isIntentionallyClosed = false;

  // Desired subscriptions (symbol IDs like "EURUSD", "V75")
  private desiredSubscriptions = new Set<string>();

  // Active subscription mapping: symbolId -> subscriptionId from Deriv
  private subscriptionIdMap = new Map<string, string>();

  // Deriv subscription ID to symbol ID reverse mapping
  private subIdToSymbolMap = new Map<string, string>();

  // Pending candle history requests waiting for connection
  private pendingCandleRequests: Array<{
    symbolId: string;
    timeframe: Timeframe;
    count: number;
    callback?: CandleHistoryCallback;
    end?: number | 'latest';
  }> = [];

  // Latest price tracker
  private latestPrices = new Map<string, number>();

  // Last tick timestamp tracker (Unix epoch in seconds)
  private lastTickEpochs = new Map<string, number>();

  // Tick stall status
  private staleStatusMap = new Map<string, boolean>();

  // Per-symbol feed health, derived from subscription outcomes and ticks.
  private feedStatusMap = new Map<string, FeedStatus>();
  private feedRecords = new Map<
    string,
    { errorCode?: string; errorMessage?: string; lastTickEpoch?: number; stale: boolean }
  >();

  // Total ticks received across all symbols
  private tickCount = 0;

  // Listeners
  private tickListeners = new Set<TickListener>();
  private statusListeners = new Set<StatusListener>();
  private logListeners = new Set<LogListener>();
  private staleListeners = new Set<StaleListener>();
  private feedStatusListeners = new Set<FeedStatusListener>();
  private historyRequests = new HistoryRequestRegistry({
    onTimeout: (entry) =>
      this.log(
        `Historical candle request timed out for ${entry.symbol} (${entry.timeframe})`,
        'warn'
      ),
  });
  private reqIdCounter = 1;

  // Monotonic id identifying each WebSocket connection attempt. History-request
  // cleanup is scoped to a generation so a stale socket's close cannot resolve
  // a request belonging to a newer connection.
  private connectionGeneration = 0;
  private activeGeneration = 0;

  constructor(config: WebSocketConfig = {}) {
    this.appId =
      config.appId ||
      process.env.NEXT_PUBLIC_DERIV_APP_ID ||
      '';
    this.endpoint =
      config.endpoint ||
      process.env.NEXT_PUBLIC_DERIV_WS_URL ||
      DEFAULT_DERIV_WS_ENDPOINT;
    this.pingIntervalMs = config.pingIntervalMs || 25000;
    this.reconnectBaseDelayMs = config.reconnectBaseDelayMs || 2000;
    this.maxReconnectDelayMs = config.maxReconnectDelayMs || 30000;
    this.staleThresholdSeconds = config.staleThresholdSeconds || 30;
    this.historyTimeoutMs = config.historyTimeoutMs || DEFAULT_HISTORY_TIMEOUT_MS;
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getLatestPrice(symbol: string): number | undefined {
    return this.latestPrices.get(symbol);
  }

  public getAllLatestPrices(): Map<string, number> {
    return this.latestPrices;
  }

  public getLastTickEpoch(symbol: string): number | undefined {
    return this.lastTickEpochs.get(symbol);
  }

  public getTickCount(): number {
    return this.tickCount;
  }

  public isSubscribed(symbol: string): boolean {
    return this.subscriptionIdMap.has(symbol);
  }

  public isSymbolStale(symbol: string): boolean {
    return this.staleStatusMap.get(symbol) ?? false;
  }

  public getFeedStatus(symbol: string): FeedStatus | undefined {
    return this.feedStatusMap.get(symbol);
  }

  public getAllFeedStatuses(): Map<string, FeedStatus> {
    return new Map(this.feedStatusMap);
  }

  public onTick(listener: TickListener): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  public onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  public onLog(listener: LogListener): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  public onStale(listener: StaleListener): () => void {
    this.staleListeners.add(listener);
    return () => this.staleListeners.delete(listener);
  }

  public onFeedStatus(listener: FeedStatusListener): () => void {
    this.feedStatusListeners.add(listener);
    return () => this.feedStatusListeners.delete(listener);
  }

  private emitFeedStatus(status: FeedStatus): void {
    for (const listener of this.feedStatusListeners) {
      try {
        listener(status);
      } catch (err) {
        console.error('[DerivWS] Error in feed status listener:', err);
      }
    }
  }

  /**
   * Recomputes and (if changed) emits a symbol's feed status. A symbol is only
   * LIVE once a valid tick has been received; a connected socket by itself never
   * marks a symbol healthy.
   */
  private recomputeFeedStatus(symbol: string): void {
    const rec = this.feedRecords.get(symbol) ?? { stale: false };
    const state = deriveFeedState({
      hasTick: rec.lastTickEpoch !== undefined,
      isStale: rec.stale,
      errorCode: rec.errorCode ?? null,
    });
    const next: FeedStatus = {
      symbol,
      state,
      ...(rec.errorCode !== undefined ? { errorCode: rec.errorCode } : {}),
      ...(rec.errorMessage !== undefined ? { errorMessage: rec.errorMessage } : {}),
      ...(rec.lastTickEpoch !== undefined ? { lastTickEpoch: rec.lastTickEpoch } : {}),
    };
    const prev = this.feedStatusMap.get(symbol);
    this.feedStatusMap.set(symbol, next);
    if (!prev || prev.state !== next.state || prev.errorCode !== next.errorCode) {
      this.emitFeedStatus(next);
    }
  }

  private setStatus(newStatus: ConnectionStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      for (const listener of this.statusListeners) {
        try {
          listener(newStatus);
        } catch (err) {
          console.error('[DerivWS] Error in status listener:', err);
        }
      }
    }
  }

  private log(message: string, level: DerivLogEntry['level'] = 'info'): void {
    const entry: DerivLogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date(),
      level,
      message,
    };
    for (const listener of this.logListeners) {
      try {
        listener(entry);
      } catch (err) {
        console.error('[DerivWS] Error in log listener:', err);
      }
    }
  }

  /**
   * Connect to the Deriv WebSocket server.
   */
  public connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING ||
        this.ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    this.isIntentionallyClosed = false;
    this.setStatus('CONNECTING');
    this.log(`Connecting to Deriv WebSocket (${this.endpoint})...`, 'info');

    try {
      // Support isomorphic runtime (browser WebSocket or global WebSocket in modern Node)
      const WS = typeof window !== 'undefined' ? window.WebSocket : globalThis.WebSocket;
      if (!WS) {
        throw new Error('WebSocket is not supported in this runtime environment.');
      }

      this.connectionGeneration += 1;
      const generation = this.connectionGeneration;

      this.ws = new WS(this.endpoint);

      this.ws.onopen = () => this.handleOpen(generation);
      this.ws.onmessage = (event) => this.handleMessage(event);
      this.ws.onerror = (event) => this.handleError(event);
      this.ws.onclose = (event) => this.handleClose(event, generation);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`Failed to initiate WebSocket: ${errorMsg}`, 'error');
      this.setStatus('ERROR');
      this.scheduleReconnect();
    }
  }

  private handleOpen(generation: number): void {
    // Ignore an open event from a superseded socket.
    if (generation !== this.connectionGeneration) return;

    this.activeGeneration = generation;
    this.reconnectAttempts = 0;
    this.setStatus('CONNECTED');
    this.log('WebSocket connected successfully', 'success');

    // Start heartbeat & staleness monitoring
    this.startPingInterval();
    this.startStaleCheck();

    // Re-subscribe to all desired symbols cleanly without duplicating
    this.resubscribeAll();

    // Flush any pending candle history requests queued while connecting
    this.flushPendingCandleRequests();
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const data = JSON.parse(event.data);

      if (data.error) {
        const code = data.error.code;
        const message = data.error.message || code;
        this.log(`Deriv API Error [${code ?? 'unknown'}]: ${message}`, 'error');

        // Associate tick-subscription errors with their symbol so the UI can
        // distinguish a closed market / unavailable symbol from a healthy feed.
        // Candle-history errors must not affect live feed health.
        const sub = symbolFromSubscriptionError(data.echo_req);
        if (sub) {
          const rec = this.feedRecords.get(sub.symbol) ?? { stale: false };
          rec.errorCode = code;
          rec.errorMessage = message;
          this.feedRecords.set(sub.symbol, rec);
          this.recomputeFeedStatus(sub.symbol);
        }

        // Resolve any pending candle-history callback so the caller can retry.
        // Without this, a failed request would leave the callback registered
        // forever and the pair stuck as "in flight".
        const failed = this.historyRequests.take(data.req_id);
        if (failed) {
          failed.callback(failed.symbol, failed.timeframe, [], 'failure');
        }
        return;
      }

      const msgType = data.msg_type;

      if (msgType === 'ping') {
        // Heartbeat response
        return;
      }

      if (msgType === 'tick' && data.tick) {
        // Validate the payload before it can affect prices, candles, or feed
        // health. Invalid ticks are rejected rather than coerced.
        const tickData = parseTick(data.tick);
        if (!tickData) {
          this.log('Rejected invalid tick payload from Deriv feed', 'warn');
          return;
        }

        const symbolId = tickData.symbol;

        // Track subscription ID if returned
        if (data.subscription?.id) {
          const subId = data.subscription.id;
          this.subscriptionIdMap.set(symbolId, subId);
          this.subIdToSymbolMap.set(subId, symbolId);
        }

        this.tickCount += 1;
        this.latestPrices.set(symbolId, tickData.price);

        // The tracked event time of the symbol never moves backwards: an
        // out-of-order tick is still a valid tick (it proves the feed is
        // alive), but it must not make the newest observed market event look
        // older than it is - that would report a healthy feed as stalled.
        const knownEpoch = this.lastTickEpochs.get(symbolId);
        const newestEpoch =
          knownEpoch === undefined || tickData.epoch > knownEpoch
            ? tickData.epoch
            : knownEpoch;
        this.lastTickEpochs.set(symbolId, newestEpoch);

        // A valid tick proves the feed is healthy: clear any prior error/stale.
        const rec = this.feedRecords.get(symbolId) ?? { stale: false };
        rec.lastTickEpoch = newestEpoch;
        rec.stale = false;
        delete rec.errorCode;
        delete rec.errorMessage;
        this.feedRecords.set(symbolId, rec);
        this.recomputeFeedStatus(symbolId);

        // Clear stale status if it was stale
        if (this.staleStatusMap.get(symbolId)) {
          this.staleStatusMap.set(symbolId, false);
          this.emitStale(symbolId, false, 0);
        }

        for (const listener of this.tickListeners) {
          try {
            listener(tickData);
          } catch (err) {
            console.error('[DerivWS] Error in tick listener:', err);
          }
        }
        return;
      }

      if (msgType === 'candles') {
        // Only act on a message whose request id matches an in-flight request,
        // so ownership is established beyond doubt. If the payload is not a
        // candle array it is treated as a failed request rather than a valid
        // empty history: the request is retired exactly once and the caller
        // clears its pending marker, keeping the pair retryable.
        const completed = this.historyRequests.take(data.req_id);
        if (!completed) return;
        if (Array.isArray(data.candles)) {
          completed.callback(
            completed.symbol,
            completed.timeframe,
            data.candles,
            data.candles.length > 0 ? 'success' : 'empty'
          );
          this.log(
            `Loaded ${data.candles.length} historical ${completed.timeframe} candles for ${completed.symbol}`,
            'info'
          );
        } else {
          this.log(
            `Malformed candles response for ${completed.symbol} (${completed.timeframe}); failing the history request`,
            'warn'
          );
          completed.callback(completed.symbol, completed.timeframe, [], 'failure');
        }
        return;
      }

      if (msgType === 'forget') {
        this.log(`Unsubscribed: ${data.forget}`, 'info');
      }
    } catch (err) {
      this.log(`Failed to parse WebSocket message: ${err}`, 'error');
    }
  }

  private handleError(event: Event): void {
    this.log('WebSocket encountered an error', 'error');
    this.setStatus('ERROR');
  }

  private handleClose(event: CloseEvent, generation: number): void {
    // Ignore a late close from a superseded socket so it cannot tear down the
    // current connection or resolve requests that belong to it.
    if (generation !== this.connectionGeneration) {
      return;
    }

    // Fail in-flight history requests for this connection so the dashboard can
    // clear its pending markers and retry after reconnecting.
    this.historyRequests.failGeneration(generation);

    this.cleanupConnection();

    if (this.isIntentionallyClosed) {
      this.setStatus('DISCONNECTED');
      this.log('WebSocket disconnected by user', 'info');
    } else {
      this.setStatus('RECONNECTING');
      this.log(`WebSocket closed (${event.code}). Attempting reconnection...`, 'warn');
      this.scheduleReconnect();
    }
  }

  private cleanupConnection(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
    // Subscription IDs are invalidated when socket closes
    this.subscriptionIdMap.clear();
    this.subIdToSymbolMap.clear();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectAttempts += 1;
    // Exponential backoff with jitter
    const delay = Math.min(
      this.reconnectBaseDelayMs * Math.pow(1.5, this.reconnectAttempts - 1) + Math.random() * 500,
      this.maxReconnectDelayMs
    );
    this.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`, 'info');

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startPingInterval(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ ping: 1 }));
        } catch {
          // Send failed
        }
      }
    }, this.pingIntervalMs);
  }

  private startStaleCheck(): void {
    if (this.staleCheckTimer) clearInterval(this.staleCheckTimer);
    this.staleCheckTimer = setInterval(() => {
      const nowEpoch = Math.floor(Date.now() / 1000);

      for (const symbolId of this.desiredSubscriptions) {
        const lastEpoch = this.lastTickEpochs.get(symbolId);
        if (lastEpoch) {
          const diff = nowEpoch - lastEpoch;
          const isStale = diff > this.staleThresholdSeconds;
          const currentStale = this.staleStatusMap.get(symbolId) ?? false;

          if (isStale !== currentStale) {
            this.staleStatusMap.set(symbolId, isStale);
            this.emitStale(symbolId, isStale, diff);
            const rec = this.feedRecords.get(symbolId) ?? { stale: false };
            rec.stale = isStale;
            this.feedRecords.set(symbolId, rec);
            this.recomputeFeedStatus(symbolId);
            if (isStale) {
              this.log(`Warning: Symbol ${symbolId} has not received ticks for ${diff}s`, 'warn');
            }
          }
        }
      }
    }, 5000);
  }

  private emitStale(symbol: string, isStale: boolean, seconds: number): void {
    for (const listener of this.staleListeners) {
      try {
        listener(symbol, isStale, seconds);
      } catch (err) {
        console.error('[DerivWS] Error in stale listener:', err);
      }
    }
  }

  /**
   * Subscribe to real-time ticks for a symbol.
   * Prevents duplicate subscriptions.
   */
  public subscribeTicks(symbolId: string): void {
    const config = getSymbolConfig(symbolId);
    if (!config) {
      this.log(`Unknown symbol ID: ${symbolId}`, 'error');
      return;
    }

    this.desiredSubscriptions.add(symbolId);

    // An explicit (re)subscribe clears any prior error for the symbol so that a
    // previously closed/unavailable market returns to PENDING until ticks arrive.
    const rec = this.feedRecords.get(symbolId) ?? { stale: false };
    delete rec.errorCode;
    delete rec.errorMessage;
    this.feedRecords.set(symbolId, rec);
    this.recomputeFeedStatus(symbolId);

    // If socket is open and not already subscribed with active ID, send subscription
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (this.subscriptionIdMap.has(symbolId)) {
        // Already active subscription exists
        return;
      }

      this.log(`Subscribing to ${config.displayName} (${config.derivSymbol})...`, 'info');
      try {
        this.ws.send(
          JSON.stringify({
            ticks: config.derivSymbol,
            subscribe: 1,
          })
        );
      } catch (err) {
        this.log(`Failed to send subscription for ${symbolId}: ${err}`, 'error');
      }
    }
  }

  /**
   * Unsubscribe from ticks for a symbol.
   */
  public unsubscribeTicks(symbolId: string): void {
    this.desiredSubscriptions.delete(symbolId);
    const subId = this.subscriptionIdMap.get(symbolId);

    if (subId && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ forget: subId }));
      } catch (err) {
        console.error('[DerivWS] Error forgetting subscription:', err);
      }
    }

    this.subscriptionIdMap.delete(symbolId);
    if (subId) {
      this.subIdToSymbolMap.delete(subId);
    }

    this.feedRecords.delete(symbolId);
    this.staleStatusMap.delete(symbolId);

    // No longer subscribed: reset to IDLE explicitly (recompute would report
    // PENDING for a missing record, which means "awaiting first tick").
    const prev = this.feedStatusMap.get(symbolId);
    const idle: FeedStatus = { symbol: symbolId, state: 'IDLE' };
    this.feedStatusMap.set(symbolId, idle);
    if (!prev || prev.state !== 'IDLE') {
      this.emitFeedStatus(idle);
    }
  }

  /**
   * Fetch initial historical candles from Deriv (e.g. 100 1m, 5m, 15m, 30m, 1H, 4H, 1D candles).
   * Queues requests if connection is currently being established.
   *
   * `end` is the end marker of the requested window. It is `'latest'` for an
   * ordinary request, and an epoch for a bounded window of a chunked recovery
   * (see `history-chunks.ts`), which needs the older part of the history that
   * a single request cannot deliver. The provider's limit of 5000 candles per
   * request is enforced here, so a caller can never ask for more.
   */
  public fetchCandlesHistory(
    symbolId: string,
    timeframe: Timeframe,
    count = 100,
    callback?: CandleHistoryCallback,
    end: number | 'latest' = 'latest'
  ): void {
    const config = getSymbolConfig(symbolId);
    if (!config) return;

    const boundedCount = Math.max(
      1,
      Math.min(Math.floor(count) || 1, MAX_RECOVERY_HISTORY_COUNT)
    );

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingCandleRequests.push({
        symbolId,
        timeframe,
        count: boundedCount,
        callback,
        end,
      });
      return;
    }

    const reqId = this.reqIdCounter++;
    const granularity = TIMEFRAME_SECONDS[timeframe] || 60;
    const endMarker = end === 'latest' ? 'latest' : Math.floor(end);

    if (callback) {
      this.historyRequests.add(
        reqId,
        {
          symbol: symbolId,
          timeframe,
          callback,
          generation: this.activeGeneration,
        },
        this.historyTimeoutMs
      );
    }

    try {
      this.ws.send(
        JSON.stringify({
          ticks_history: config.derivSymbol,
          adjust_start_time: 1,
          count: boundedCount,
          end: endMarker,
          style: 'candles',
          granularity,
          req_id: reqId,
        })
      );
    } catch (err) {
      this.log(`Failed to request candle history for ${symbolId} (${timeframe}): ${err}`, 'error');
    }
  }

  private flushPendingCandleRequests(): void {
    const pending = [...this.pendingCandleRequests];
    this.pendingCandleRequests = [];
    for (const req of pending) {
      this.fetchCandlesHistory(
        req.symbolId,
        req.timeframe,
        req.count,
        req.callback,
        req.end ?? 'latest'
      );
    }
  }

  /**
   * Resubscribe to all desired symbols after reconnection.
   */
  private resubscribeAll(): void {
    for (const symbolId of this.desiredSubscriptions) {
      const config = getSymbolConfig(symbolId);
      if (!config) continue;

      this.log(`Resubscribing to ${config.displayName}...`, 'info');
      try {
        this.ws?.send(
          JSON.stringify({
            ticks: config.derivSymbol,
            subscribe: 1,
          })
        );
      } catch (err) {
        this.log(`Failed to resubscribe to ${symbolId}: ${err}`, 'error');
      }
    }
  }

  /**
   * Disconnect and clear timers.
   */
  public disconnect(): void {
    this.isIntentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore
      }
    }
    this.historyRequests.failAll();
    this.cleanupConnection();
    this.setStatus('DISCONNECTED');
  }
}

// Global singleton instance for client-side usage
let sharedDerivClient: DerivWebSocketClient | null = null;

export function getDerivClient(): DerivWebSocketClient {
  if (!sharedDerivClient) {
    sharedDerivClient = new DerivWebSocketClient();
  }
  return sharedDerivClient;
}
