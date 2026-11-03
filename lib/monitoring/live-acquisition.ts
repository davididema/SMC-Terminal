/**
 * Live, read-only acquisition adapter (Phase 2B, Stage 2).
 *
 * Obtains genuine Deriv market data through the EXISTING transport
 * (`DerivWebSocketClient`) and candle logic (`CandleManager`), and feeds only
 * genuinely-closed candles into the EXISTING headless monitoring core.
 *
 * Scope / guarantees (Stage 2):
 * - READ-ONLY: no order placement, no account authorization, no execution.
 * - No desktop/sound/Web-Push/user notifications: it only emits structured
 *   observations for a caller/runner to inspect.
 * - It reuses the existing symbol mapping and timeframe definitions; it never
 *   introduces an alternative provider or symbol mapping and never fabricates a
 *   price, candle, tick, signal, or market status.
 * - It never evaluates from an incomplete candle, from history seeding, from a
 *   history recovery, or from a restored/replayed candle. Evaluation happens
 *   only when `CandleManager` emits a confirmed candle-close event.
 * - A connection, subscription, or history response being *accepted* is never
 *   treated as proof that usable market data exists: feed health is read from
 *   the client's own per-symbol feed status (LIVE requires a genuine tick).
 *
 * The adapter depends on the core only through its public candle manager and
 * `evaluatePair` (see `MonitoringEvaluationTarget`). The real `MonitoringCore`
 * satisfies that interface; the narrow type keeps the adapter testable without a
 * live socket. The dashboard's own live-data path is untouched.
 */

import {
  CandleManager,
  Timeframe,
  TickData,
  Candle,
  describeHistoryRejections,
  type HistoryRejection,
} from '../deriv/candles';
import type { ConnectionStatus } from '../deriv/websocket';
import type { FeedState, FeedStatus } from '../deriv/feed';
import type {
  HistoryCandleData,
  HistoryRequestCallback,
  HistoryRequestOutcome,
} from '../deriv/history-requests';
import { HistoryRecoveryController } from '../deriv/history-recovery';
import {
  RecoveryChunkCoordinator,
  type RecoveryCycleResult,
} from '../deriv/history-chunks';
import { resumeStaleRecovery } from '../deriv/recovery-resume';
import { signalPairKey } from '../signals/signal-history';
import type {
  SignalOutput,
  SignalDecision,
  SignalRejectionCode,
} from '../signals/signal-engine';
import type { GeneratedSignalEvent } from '../notifications/types';
import type { PairEvaluationReport } from './headless-core';

/**
 * The subset of the existing `DerivWebSocketClient` the adapter needs. The
 * concrete client satisfies this interface; tests inject a controlled double.
 */
export interface MonitoringMarketSource {
  connect(): void;
  disconnect(): void;
  getStatus(): ConnectionStatus;
  getFeedStatus(symbolId: string): FeedStatus | undefined;
  getLastTickEpoch(symbolId: string): number | undefined;
  subscribeTicks(symbolId: string): void;
  fetchCandlesHistory(
    symbolId: string,
    timeframe: Timeframe,
    count: number,
    callback: HistoryRequestCallback,
    end?: number | 'latest'
  ): void;
  onStatusChange(listener: (status: ConnectionStatus) => void): () => void;
  onTick(listener: (tick: TickData) => void): () => void;
  onFeedStatus(listener: (status: FeedStatus) => void): () => void;
}

/**
 * The subset of the existing `MonitoringCore` the adapter needs. `MonitoringCore`
 * satisfies this interface structurally; production and the diagnostic runner
 * always pass the real core.
 */
export interface MonitoringEvaluationTarget {
  readonly candleManager: CandleManager;
  evaluatePair(symbolId: string, timeframe: Timeframe): PairEvaluationReport;
}

export interface MonitoredPair {
  symbolId: string;
  timeframe: Timeframe;
}

export interface LiveAcquisitionConfig {
  /** The bounded set of pairs to observe. */
  pairs: MonitoredPair[];
  /** Historical candle count requested per pair (default 100). */
  historyCount?: number;
}

/** Structured observation emitted for a caller/runner. Never a notification. */
export type MonitoringObservation =
  | { type: 'connection'; at: Date; status: ConnectionStatus }
  | {
      type: 'feed';
      at: Date;
      symbolId: string;
      state: FeedState;
      errorCode?: string;
      errorMessage?: string;
    }
  | {
      type: 'history';
      at: Date;
      pairKey: string;
      outcome:
        | HistoryRequestOutcome
        | 'requested'
        | 'recovery-complete'
        | 'recovery-incomplete';
      candleCount: number;
    }
  | {
      type: 'candle-close';
      at: Date;
      pairKey: string;
      epoch: number;
      close: number;
    }
  | {
      type: 'evaluation';
      at: Date;
      pairKey: string;
      epoch: number;
      decision: SignalDecision;
      signalId?: string;
      rejectionReasons?: SignalRejectionCode[];
    }
  | { type: 'candidate'; at: Date; pairKey: string; epoch: number; signalId: string }
  | { type: 'error'; at: Date; pairKey: string | null; stage: string; message: string };

export type HistoryAcquisitionStatus =
  | 'none'
  | 'requested'
  | 'success'
  | 'empty'
  | 'failure'
  | 'abandoned';

/** Per-pair, caller-inspectable state. Distinct concepts are kept distinct. */
export interface PairAcquisitionState {
  pairKey: string;
  symbolId: string;
  timeframe: Timeframe;
  /** Transport status (does NOT imply usable data). */
  connectionStatus: ConnectionStatus;
  /** Feed health from the client; LIVE requires a genuine tick. */
  feedState: FeedState;
  feedErrorCode: string | null;
  feedErrorMessage: string | null;
  /** Last genuine tick epoch, or null when none has arrived. */
  lastTickEpoch: number | null;
  /** Last confirmed closed candle epoch, or null when none has closed. */
  lastClosedCandleEpoch: number | null;
  lastClosedCandleAt: Date | null;
  historyStatus: HistoryAcquisitionStatus;
  historyCandleCount: number;
  historyAt: Date | null;
  /**
   * True while the pair's history must be recovered before it may be evaluated
   * again (a connection discontinuity left the pair with a gap).
   */
  recoveryRequired: boolean;
  /** Evaluations run (one per genuinely-close candle), never from seeding. */
  evaluationCount: number;
  lastEvaluationAt: Date | null;
  /** Latest evaluation's engine output (may be an honest NO_TRADE). */
  lastSignal: SignalOutput | null;
  candidateCount: number;
  lastCandidateAt: Date | null;
  /** Latest accepted notification candidate (genuine LONG/SHORT only). */
  lastCandidate: GeneratedSignalEvent | null;
}

function createState(pair: MonitoredPair, connectionStatus: ConnectionStatus): PairAcquisitionState {
  return {
    pairKey: signalPairKey(pair.symbolId, pair.timeframe),
    symbolId: pair.symbolId,
    timeframe: pair.timeframe,
    connectionStatus,
    feedState: 'IDLE',
    feedErrorCode: null,
    feedErrorMessage: null,
    lastTickEpoch: null,
    lastClosedCandleEpoch: null,
    lastClosedCandleAt: null,
    historyStatus: 'none',
    historyCandleCount: 0,
    historyAt: null,
    recoveryRequired: false,
    evaluationCount: 0,
    lastEvaluationAt: null,
    lastSignal: null,
    candidateCount: 0,
    lastCandidateAt: null,
    lastCandidate: null,
  };
}

export class LiveAcquisitionAdapter {
  private readonly source: MonitoringMarketSource;
  private readonly target: MonitoringEvaluationTarget;
  private readonly pairs: MonitoredPair[];
  private readonly historyCount: number;

  private readonly states = new Map<string, PairAcquisitionState>();
  private readonly bySymbol = new Map<string, MonitoredPair[]>();
  /** Highest evaluated close epoch per pair; blocks duplicate/out-of-order closes. */
  private readonly lastEvaluatedEpoch = new Map<string, number>();

  private readonly observationListeners = new Set<(o: MonitoringObservation) => void>();
  private unsubscribers: Array<() => void> = [];
  private started = false;
  private connectionStatus: ConnectionStatus;
  /** Bounded retries for history requests that did not produce usable data. */
  private readonly recovery: HistoryRecoveryController;
  /**
   * Bounded chunked recovery for gaps that are wider than a single history
   * request. The provider delivers at most 5000 candles per request, so a
   * wider gap is served by a BOUNDED number of bounded requests.
   */
  private readonly chunks: RecoveryChunkCoordinator;

  constructor(
    source: MonitoringMarketSource,
    target: MonitoringEvaluationTarget,
    config: LiveAcquisitionConfig
  ) {
    this.source = source;
    this.target = target;
    this.pairs = config.pairs.map((p) => ({ ...p }));
    this.historyCount = config.historyCount ?? 100;
    this.connectionStatus = source.getStatus();

    for (const pair of this.pairs) {
      const key = signalPairKey(pair.symbolId, pair.timeframe);
      if (this.states.has(key)) continue;
      this.states.set(key, createState(pair, this.connectionStatus));
      const list = this.bySymbol.get(pair.symbolId) ?? [];
      list.push(pair);
      this.bySymbol.set(pair.symbolId, list);
    }

    // A retry is only permitted while the socket is connected and the symbol's
    // market is neither closed nor unavailable. A disconnected socket cancels
    // every scheduled retry (the reconnect path re-requests instead).
    this.recovery = new HistoryRecoveryController({
      canRetry: (symbolId) => {
        if (this.connectionStatus !== 'CONNECTED') return false;
        const feed = this.source.getFeedStatus(symbolId)?.state;
        return feed !== 'CLOSED' && feed !== 'UNAVAILABLE';
      },
      onRetry: (symbolId, timeframe) => {
        const pair = this.pairs.find(
          (p) => p.symbolId === symbolId && p.timeframe === timeframe
        );
        if (pair) this.requestHistory(pair);
      },
    });

    // Bounded chunked recovery for gaps that are wider than one request. Every
    // window stays inside the provider's limit, the windows overlap by one
    // period, and nothing is admitted before the whole cycle is complete.
    this.chunks = new RecoveryChunkCoordinator({
      manager: target.candleManager,
      controller: this.recovery,
      transport: {
        fetchHistoryWindow: (symbolId, timeframe, count, end, callback) => {
          this.source.fetchCandlesHistory(
            symbolId,
            timeframe,
            count,
            (_s, _tf, candles, outcome) => {
              callback(
                candles ?? [],
                outcome ?? (candles && candles.length > 0 ? 'success' : 'failure')
              );
            },
            end ?? 'latest'
          );
        },
      },
      onCycleEnd: (result) => this.handleChunkCycleEnd(result),
    });
  }

  public onObservation(listener: (o: MonitoringObservation) => void): () => void {
    this.observationListeners.add(listener);
    return () => this.observationListeners.delete(listener);
  }

  public getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  public getState(): PairAcquisitionState[] {
    return Array.from(this.states.values(), (s) => ({ ...s }));
  }

  public getPairState(symbolId: string, timeframe: Timeframe): PairAcquisitionState | undefined {
    const s = this.states.get(signalPairKey(symbolId, timeframe));
    return s ? { ...s } : undefined;
  }

  /**
   * Register listeners, connect, subscribe to the monitored symbols, and request
   * their history. Safe to call once; repeated calls are ignored.
   */
  public start(): void {
    if (this.started) return;
    this.started = true;

    this.unsubscribers.push(
      this.source.onStatusChange((status) => this.handleStatus(status)),
      this.source.onFeedStatus((status) => this.handleFeed(status)),
      this.source.onTick((tick) => this.handleTick(tick)),
      this.target.candleManager.onCandleClose((symbolId, timeframe, candle) => {
        this.handleClosedCandle(symbolId, timeframe, candle);
      })
    );

    this.connectionStatus = this.source.getStatus();
    for (const pair of this.pairs) {
      this.syncFeed(pair.symbolId);
    }

    this.source.connect();

    const uniqueSymbols = new Set(this.pairs.map((p) => p.symbolId));
    for (const symbolId of uniqueSymbols) {
      this.source.subscribeTicks(symbolId);
    }
    for (const pair of this.pairs) {
      this.requestHistory(pair);
    }
  }

  /** Unregister listeners and close the read-only connection. */
  public stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        // A source double may already be torn down; ignore.
      }
    }
    this.unsubscribers = [];
    this.connectionStatus = 'DISCONNECTED';
    for (const st of this.states.values()) {
      st.connectionStatus = 'DISCONNECTED';
    }
    this.recovery.cancelAll();
    this.source.disconnect();
  }

  /**
   * Confirmed candle-close entry point. Wired to `CandleManager.onCandleClose`
   * in `start()` and directly testable. Returns the evaluation report, or null
   * when the event was ignored (unmonitored pair, non-closed candle, or a
   * duplicate/out-of-order epoch).
   */
  public handleClosedCandle(
    symbolId: string,
    timeframe: Timeframe,
    candle: Candle
  ): PairEvaluationReport | null {
    const key = signalPairKey(symbolId, timeframe);
    const st = this.states.get(key);
    if (!st) return null; // Not a monitored pair: ignore (per-pair isolation).

    // Only genuinely closed candles may ever be evaluated.
    if (candle.isClosed !== true) {
      this.emit({
        type: 'error',
        at: new Date(),
        pairKey: key,
        stage: 'candle-close',
        message: 'ignored a non-closed candle (incomplete candles are never evaluated)',
      });
      return null;
    }

    // Block a candle delivered twice (or received again during recovery): only a
    // strictly newer epoch than the last *successfully evaluated* close may be
    // evaluated.
    const previous = this.lastEvaluatedEpoch.get(key);
    if (previous !== undefined && candle.epoch <= previous) {
      return null;
    }

    const closedAt = new Date();
    st.lastClosedCandleEpoch = candle.epoch;
    st.lastClosedCandleAt = closedAt;
    this.emit({
      type: 'candle-close',
      at: closedAt,
      pairKey: key,
      epoch: candle.epoch,
      close: candle.close,
    });

    // A pair whose history still has a known gap is never evaluated: the close
    // may be based on data that was never observed (a candle that spans a
    // connection discontinuity). The close itself is reported, the evaluation
    // is refused.
    if (st.recoveryRequired || this.target.candleManager.isRecoveryRequired(symbolId, timeframe)) {
      this.emit({
        type: 'error',
        at: new Date(),
        pairKey: key,
        stage: 'recovery',
        message: `refused to evaluate a candle close for ${key} while its history recovery is pending`,
      });
      return null;
    }

    let report: PairEvaluationReport;
    try {
      report = this.target.evaluatePair(symbolId, timeframe);
    } catch (err) {
      // A failed evaluation must NOT permanently consume the candle: the epoch
      // is left unrecorded so a later delivery of the same close (e.g. during
      // recovery) retries rather than being silently dropped. Genuine
      // duplicates/out-of-order closes are still suppressed once the epoch has
      // actually been evaluated (see below).
      this.emit({
        type: 'error',
        at: new Date(),
        pairKey: key,
        stage: 'evaluation',
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    // Record the epoch only after evaluation succeeded, so duplicate and
    // out-of-order closes remain blocked while a transient evaluation failure
    // cannot strand this candle.
    this.lastEvaluatedEpoch.set(key, candle.epoch);

    st.evaluationCount += 1;
    st.lastEvaluationAt = report.evaluation.evaluatedAt ?? new Date();
    st.lastSignal = report.evaluation.signal;
    this.emit({
      type: 'evaluation',
      at: st.lastEvaluationAt,
      pairKey: key,
      epoch: candle.epoch,
      decision: report.evaluation.signal?.decision ?? 'NO_TRADE',
      ...(report.evaluation.signal?.signalId !== undefined
        ? { signalId: report.evaluation.signal.signalId }
        : {}),
      ...(report.evaluation.signal?.rejectionReasons !== undefined
        ? { rejectionReasons: report.evaluation.signal.rejectionReasons }
        : {}),
    });

    if (report.candidate) {
      st.candidateCount += 1;
      st.lastCandidateAt = new Date();
      st.lastCandidate = report.candidate;
      this.emit({
        type: 'candidate',
        at: st.lastCandidateAt,
        pairKey: key,
        epoch: candle.epoch,
        signalId: report.candidate.signalId,
      });
    }

    return report;
  }

  private handleStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    for (const st of this.states.values()) {
      st.connectionStatus = status;
    }
    this.emit({ type: 'connection', at: new Date(), status });

    if (status === 'CONNECTED') {
      // Re-request pairs that were never successfully seeded (or whose request
      // failed/was abandoned) AND pairs whose history must be recovered after a
      // connection discontinuity. Never re-evaluates; seeding alone never
      // produces a candidate.
      for (const pair of this.pairs) {
        this.requestHistory(pair);
      }
    } else {
      // A non-connected status means the ticks of an unknown stretch of time
      // were never observed. The forming candle that spans the gap is
      // incomplete and must never be finalized as a valid close, and the pair
      // may only be evaluated again after its history has been recovered.
      this.markDiscontinuities();
      // Any non-connected state invalidates scheduled retries.
      this.recovery.cancelAll();
    }

    if (status === 'ERROR') {
      this.emit({
        type: 'error',
        at: new Date(),
        pairKey: null,
        stage: 'connection',
        message: 'WebSocket connection error',
      });
    }
  }

  /**
   * Record the connection discontinuity for every monitored symbol and reflect
   * the resulting recovery requirement in the pair states. When `symbols` is
   * given, only those symbols are marked: a stale feed interrupts one symbol's
   * ticks, not every monitored symbol's.
   */
  private markDiscontinuities(symbols?: Iterable<string>): void {
    const targets = new Set(symbols ?? this.pairs.map((p) => p.symbolId));
    for (const symbolId of targets) {
      this.target.candleManager.markDiscontinuity(symbolId);
      for (const pair of this.bySymbol.get(symbolId) ?? []) {
        const st = this.states.get(signalPairKey(pair.symbolId, pair.timeframe));
        if (!st) continue;
        st.recoveryRequired = this.target.candleManager.isRecoveryRequired(
          pair.symbolId,
          pair.timeframe
        );
      }
    }
  }

  /** Invalidate the scheduled retries of one symbol's pairs (budgets kept). */
  private cancelRetriesForSymbol(symbolId: string): void {
    for (const pair of this.bySymbol.get(symbolId) ?? []) {
      this.recovery.cancel(pair.symbolId, pair.timeframe);
    }
  }

  /**
   * Resume the outstanding recovery of a symbol that became live again without
   * a reconnect. Recovery is only requested through the existing path, and only
   * when the pair still owes one and no recovery work is already running.
   */
  private resumeRecoveryAfterLive(symbolId: string): void {
    for (const pair of this.bySymbol.get(symbolId) ?? []) {
      const st = this.states.get(signalPairKey(pair.symbolId, pair.timeframe));
      if (!st) continue;
      resumeStaleRecovery({
        isRecoveryRequired: () =>
          this.target.candleManager.isRecoveryRequired(pair.symbolId, pair.timeframe),
        isRequestPending: () => st.historyStatus === 'requested',
        isRetryScheduled: () => this.recovery.isScheduled(pair.symbolId, pair.timeframe),
        isChunkActive: () => this.chunks.isActive(pair.symbolId, pair.timeframe),
        hasRetryBudget: () => this.recovery.hasAttemptsLeft(pair.symbolId, pair.timeframe),
        requestHistory: () => this.requestHistory(pair),
      });
    }
  }

  private handleFeed(status: FeedStatus): void {
    this.emit({
      type: 'feed',
      at: new Date(),
      symbolId: status.symbol,
      state: status.state,
      ...(status.errorCode !== undefined ? { errorCode: status.errorCode } : {}),
      ...(status.errorMessage !== undefined ? { errorMessage: status.errorMessage } : {}),
    });

    for (const pair of this.bySymbol.get(status.symbol) ?? []) {
      const st = this.states.get(signalPairKey(pair.symbolId, pair.timeframe));
      if (!st) continue;
      st.feedState = status.state;
      st.feedErrorCode = status.errorCode ?? null;
      st.feedErrorMessage = status.errorMessage ?? null;
      if (status.lastTickEpoch !== undefined) {
        st.lastTickEpoch = status.lastTickEpoch;
      }
    }

    if (status.state === 'STALE') {
      // A stale feed is a discontinuity for THIS symbol: the ticks of an unknown
      // stretch of time were not observed, so the forming candle that spans the
      // gap must never be finalized as a valid close and the pair may only be
      // evaluated again after its history has been recovered. This mirrors the
      // non-connected connection path, scoped to the stale symbol. Marking is
      // idempotent, so repeated STALE status callbacks cannot duplicate the
      // cycle or un-block the pair before its recovery completes.
      this.markDiscontinuities([status.symbol]);
      // Only this symbol's scheduled retries are invalidated. Another symbol's
      // recovery is unaffected by this symbol going stale.
      this.cancelRetriesForSymbol(status.symbol);
    }

    if (status.state === 'LIVE') {
      // The symbol's feed recovered without a reconnect. The gap its stale
      // episode created is still open, so resume the EXISTING recovery path.
      // The discontinuity is not re-marked (the original anchor survives), the
      // consumed retry budget is untouched, and repeated LIVE callbacks cannot
      // create a second job (the pair stays blocked until recovery completes).
      this.resumeRecoveryAfterLive(status.symbol);
    }

    if (status.state === 'CLOSED' || status.state === 'UNAVAILABLE') {
      this.emit({
        type: 'error',
        at: new Date(),
        pairKey: null,
        stage: 'feed',
        message: `[${status.symbol}] feed ${status.state.toLowerCase()}${
          status.errorMessage ? `: ${status.errorMessage}` : ''
        }`,
      });
    }
  }

  private handleTick(tick: TickData): void {
    const pairs = this.bySymbol.get(tick.symbol);
    if (!pairs || pairs.length === 0) return; // Ignore unmonitored symbols.

    // Reuse the existing candle aggregation (updates every timeframe).
    this.target.candleManager.processTick(tick);

    for (const pair of pairs) {
      const st = this.states.get(signalPairKey(pair.symbolId, pair.timeframe));
      // The tracked event time of the pair never moves backwards: an
      // out-of-order tick is still processed (the candle manager keeps its own
      // ordering rules), but it must not make the pair look older than it is.
      if (st && (st.lastTickEpoch === null || tick.epoch > st.lastTickEpoch)) {
        st.lastTickEpoch = tick.epoch;
      }
    }
  }

  /** Reflect the client's current feed status for a symbol into pair state. */
  private syncFeed(symbolId: string): void {
    const status = this.source.getFeedStatus(symbolId);
    if (!status) return;
    for (const pair of this.bySymbol.get(symbolId) ?? []) {
      const st = this.states.get(signalPairKey(pair.symbolId, pair.timeframe));
      if (!st) continue;
      st.feedState = status.state;
      st.feedErrorCode = status.errorCode ?? null;
      st.feedErrorMessage = status.errorMessage ?? null;
      if (status.lastTickEpoch !== undefined) st.lastTickEpoch = status.lastTickEpoch;
    }
  }

  /**
   * Request history for a pair unless it is already in flight or already
   * seeded. A pair whose history must be recovered (after a connection
   * discontinuity) is always re-requested, even when it was seeded before the
   * gap. Seeding never evaluates and never produces a candidate; a successful
   * seed simply makes the closed-candle history available.
   */
  private requestHistory(pair: MonitoredPair): void {
    const key = signalPairKey(pair.symbolId, pair.timeframe);
    const st = this.states.get(key);
    if (!st) return;

    const recoveryRequired = this.target.candleManager.isRecoveryRequired(
      pair.symbolId,
      pair.timeframe
    );
    if (st.historyStatus === 'requested') return; // A request is already in flight.
    if (!recoveryRequired && st.historyStatus === 'success') return;

    st.historyStatus = 'requested';
    st.historyAt = new Date();
    st.recoveryRequired = recoveryRequired;
    this.emit({
      type: 'history',
      at: st.historyAt,
      pairKey: key,
      outcome: 'requested',
      candleCount: st.historyCandleCount,
    });

    // A gap that is wider than a single history request can never be bridged by
    // one response (the provider delivers at most 5000 candles per request).
    // Such a gap is served by a BOUNDED number of bounded requests instead; the
    // coordinator owns them and reports the cycle's outcome when it ends. A gap
    // that is wider than the bounded budget is classified and the pair stays
    // blocked - no request is issued for it.
    const chunkStart = this.chunks.start(pair.symbolId, pair.timeframe);
    if (chunkStart.kind === 'chunked' || chunkStart.kind === 'oversized') {
      return;
    }

    // A recovery must span the whole gap, so it may need more candles than the
    // ordinary backfill.
    const count = this.target.candleManager.getRecoveryHistoryCount(
      pair.symbolId,
      pair.timeframe,
      this.historyCount
    );

    this.source.fetchCandlesHistory(
      pair.symbolId,
      pair.timeframe,
      count,
      (symbol, timeframe, candles, outcome) => {
        this.applyHistoryOutcome(symbol, timeframe, candles, outcome);
      }
    );
  }

  /**
   * A chunked recovery cycle ended. The pair is released only when the
   * combined history bridged the gap completely; otherwise it stays blocked
   * and its bounded retry budget is consumed (never reset).
   */
  private handleChunkCycleEnd(result: RecoveryCycleResult): void {
    const key = signalPairKey(result.symbol, result.timeframe);
    const st = this.states.get(key);
    if (!st) return;

    st.historyAt = new Date();
    st.recoveryRequired = this.target.candleManager.isRecoveryRequired(
      result.symbol,
      result.timeframe
    );

    if (result.oversized) {
      st.historyStatus = 'failure';
      st.historyCandleCount = 0;
      this.emit({
        type: 'history',
        at: st.historyAt,
        pairKey: key,
        outcome: 'failure',
        candleCount: 0,
      });
      this.emit({
        type: 'error',
        at: st.historyAt,
        pairKey: key,
        stage: 'recovery',
        message: `history gap for ${key} needs ${result.requiredCount} candles, which exceeds the bounded recovery budget of ${result.maxChunks} request(s): the pair stays blocked`,
      });
      return;
    }

    if (result.recoveryComplete) {
      st.historyStatus = 'success';
      st.historyCandleCount = result.admittedCandleCount;
      this.emit({
        type: 'history',
        at: st.historyAt,
        pairKey: key,
        outcome: 'recovery-complete',
        candleCount: result.admittedCandleCount,
      });
      return;
    }

    st.historyStatus = 'failure';
    st.historyCandleCount = 0;
    this.emit({
      type: 'history',
      at: st.historyAt,
      pairKey: key,
      outcome: 'recovery-incomplete',
      candleCount: 0,
    });
    this.emit({
      type: 'error',
      at: st.historyAt,
      pairKey: key,
      stage: 'recovery',
      message: `history recovery incomplete for ${key}: ${result.requestCount} bounded request(s) did not cover the gap completely`,
    });
  }

  private applyHistoryOutcome(
    symbolId: string,
    timeframe: Timeframe,
    candles: HistoryCandleData[],
    outcome?: HistoryRequestOutcome
  ): void {
    const key = signalPairKey(symbolId, timeframe);
    const st = this.states.get(key);
    if (!st) return;

    const count = Array.isArray(candles) ? candles.length : 0;
    const resolved: HistoryRequestOutcome = outcome ?? (count > 0 ? 'success' : 'failure');
    st.historyAt = new Date();

    if (resolved === 'success' && count > 0) {
      st.historyStatus = 'success';
      st.historyCandleCount = count;

      const recoveryRequired = this.target.candleManager.isRecoveryRequired(
        symbolId,
        timeframe
      );
      if (recoveryRequired) {
        // The response is only accepted as a recovery when it actually bridges
        // the gap. An insufficient response keeps the pair blocked.
        const covered = this.target.candleManager.recoverFromHistory(symbolId, timeframe, candles);
        const admission = this.target.candleManager.getLastHistoryAdmission(symbolId, timeframe);
        st.recoveryRequired = !covered;
        this.emit({
          type: 'history',
          at: st.historyAt,
          pairKey: key,
          outcome: covered ? 'recovery-complete' : 'recovery-incomplete',
          candleCount: count,
        });
        if (admission && admission.rejected > 0) {
          this.reportRejectedCandles(key, admission.rejected, admission.rejections);
        }
        if (covered) {
          // The pair is whole again: its retry budget is restored for a future gap.
          this.recovery.reset(symbolId, timeframe);
          return;
        }
        this.emit({
          type: 'error',
          at: new Date(),
          pairKey: key,
          stage: 'recovery',
          message: `history recovery incomplete for ${key}: the response did not cover the gap completely`,
        });
        // Bounded retry: a response that did not bridge the gap is retried
        // (with a larger request) while the connection holds.
        this.recovery.requestRetry(symbolId, timeframe);
        return;
      }

      // Reuse the existing seeding path; this never emits a close event, so it
      // can never generate a historical notification candidate.
      const admission = this.target.candleManager.seedHistory(symbolId, timeframe, candles);
      if (admission.rejected > 0) {
        this.reportRejectedCandles(key, admission.rejected, admission.rejections);
      }
      if (admission.admitted === 0) {
        // The response carried candles but none of them was admissible: the
        // pair received no usable history. That is a failure, not a success:
        // the pair stays retryable instead of being seeded with nothing.
        st.historyStatus = 'failure';
        st.historyCandleCount = 0;
        this.emit({
          type: 'history',
          at: st.historyAt,
          pairKey: key,
          outcome: 'failure',
          candleCount: 0,
        });
        this.recovery.requestRetry(symbolId, timeframe);
        return;
      }
      this.emit({
        type: 'history',
        at: st.historyAt,
        pairKey: key,
        outcome: 'success',
        candleCount: count,
      });
      return;
    }

    st.historyStatus = resolved;
    st.historyCandleCount = 0;
    this.emit({
      type: 'history',
      at: st.historyAt,
      pairKey: key,
      outcome: resolved,
      candleCount: 0,
    });
    if (resolved === 'failure' || resolved === 'abandoned') {
      this.emit({
        type: 'error',
        at: new Date(),
        pairKey: key,
        stage: 'history',
        message: `history request ${resolved} for ${key}`,
      });
    }
    if (resolved === 'failure' || resolved === 'empty' || resolved === 'abandoned') {
      // Route the transport outcome through the SAME bounded controller the
      // incomplete-recovery paths use. A failure/empty response consumes the
      // pair's retry budget and schedules at most one bounded retry; an
      // abandoned request only clears a pending retry (the reconnect path owns
      // re-requesting). The recovery requirement is never cleared here: only a
      // verified recovery may release the pair and reset the budget.
      this.recovery.handleOutcome(symbolId, timeframe, resolved);
    }
  }

  /**
   * Report the history entries a response carried but that were rejected as
   * invalid. The detail is bounded, so a garbled response cannot flood the
   * observation stream.
   */
  private reportRejectedCandles(
    pairKey: string,
    rejected: number,
    rejections: readonly HistoryRejection[]
  ): void {
    this.emit({
      type: 'error',
      at: new Date(),
      pairKey,
      stage: 'history',
      message: `history response for ${pairKey} rejected ${rejected} invalid candle(s): ${describeHistoryRejections(rejections)}`,
    });
  }

  private emit(observation: MonitoringObservation): void {
    for (const listener of this.observationListeners) {
      try {
        listener(observation);
      } catch (err) {
        console.error('[LiveAcquisition] Error in observation listener:', err);
      }
    }
  }
}
