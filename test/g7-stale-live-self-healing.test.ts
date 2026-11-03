/**
 * G7 — STALE -> LIVE self-healing recovery.
 *
 * The confirmed defect: when a symbol's feed went STALE and later became LIVE
 * again WITHOUT a WebSocket reconnect, the pair stayed marked as requiring
 * recovery, but nothing re-issued the recovery request. The pair therefore
 * stayed blocked forever. The dashboard had the same omission: its stale
 * listener returned early for `isStale === false`.
 *
 * These tests drive the real candle manager, the real bounded recovery
 * controller/chunk coordinator, the real headless acquisition adapter, and the
 * same production resumption gate the dashboard uses. No socket, no network,
 * and no fabricated market data: the candles are deterministic period fixtures
 * whose only purpose is to describe the required history.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  CandleManager,
  type Candle,
  type TickData,
  type Timeframe,
} from '../lib/deriv/candles';
import {
  LiveAcquisitionAdapter,
  type MonitoringMarketSource,
  type MonitoringObservation,
} from '../lib/monitoring/live-acquisition';
import { MonitoringCore } from '../lib/monitoring/headless-core';
import {
  HistoryRecoveryController,
  applyHistoryResponse,
} from '../lib/deriv/history-recovery';
import { RecoveryChunkCoordinator } from '../lib/deriv/history-chunks';
import { resumeStaleRecovery } from '../lib/deriv/recovery-resume';
import {
  applyHistoryOutcome,
  createHistoryBookkeeping,
  historyKey,
  markHistoryPending,
  planHistoryLoad,
} from '../lib/deriv/history-init';
import type { FeedStatus } from '../lib/deriv/feed';
import type { ConnectionStatus } from '../lib/deriv/websocket';
import type {
  HistoryCandleData,
  HistoryRequestCallback,
  HistoryRequestOutcome,
} from '../lib/deriv/history-requests';

const EURUSD = 'EURUSD';
const GBPUSD = 'GBPUSD';
const MINUTE = 60;
const FIRST_PERIOD = 60;
const SEED_PERIODS = 5;
/** The forming candle at the moment the feed goes stale. */
const INTERRUPTED_PERIOD = FIRST_PERIOD + SEED_PERIODS * MINUTE; // 360
/** A tick inside the interrupted period (the live edge). */
const LIVE_TICK_EPOCH = INTERRUPTED_PERIOD + 30; // 390

function historyCandle(epoch: number, close = 1.1): HistoryCandleData {
  return { epoch, open: close, high: close, low: close, close };
}

function series(firstEpoch: number, count: number, close = 1.1): HistoryCandleData[] {
  const out: HistoryCandleData[] = [];
  for (let i = 0; i < count; i++) out.push(historyCandle(firstEpoch + i * MINUTE, close));
  return out;
}

function tick(symbol: string, price: number, epoch: number): TickData {
  return { symbol, derivSymbol: symbol, price, epoch };
}

function closedCandle(epoch: number, close = 1.1): Candle {
  return { epoch, open: close, high: close, low: close, close, volume: 1, isClosed: true };
}

function collect(adapter: LiveAcquisitionAdapter): MonitoringObservation[] {
  const out: MonitoringObservation[] = [];
  adapter.onObservation((o) => out.push(o));
  return out;
}

function ofType<T extends MonitoringObservation['type']>(
  observations: MonitoringObservation[],
  type: T
): Array<Extract<MonitoringObservation, { type: T }>> {
  return observations.filter(
    (o): o is Extract<MonitoringObservation, { type: T }> => o.type === type
  );
}

/**
 * A controlled market source. It only records requests and hands back the
 * fixture the test explicitly completes; it never invents a candle.
 */
class RecordingSource implements MonitoringMarketSource {
  public readonly requests: Array<{
    symbolId: string;
    timeframe: Timeframe;
    count: number;
    end: number | 'latest' | undefined;
  }> = [];

  private status: ConnectionStatus = 'DISCONNECTED';
  private readonly feed = new Map<string, FeedStatus>();
  private readonly lastTick = new Map<string, number>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly tickListeners = new Set<(tick: TickData) => void>();
  private readonly feedListeners = new Set<(status: FeedStatus) => void>();
  private readonly pending: Array<{
    symbolId: string;
    timeframe: Timeframe;
    callback: HistoryRequestCallback;
  }> = [];

  public connect(): void {
    this.status = 'CONNECTED';
    for (const listener of this.statusListeners) listener(this.status);
  }

  public disconnect(): void {
    this.status = 'DISCONNECTED';
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getFeedStatus(symbolId: string): FeedStatus | undefined {
    return this.feed.get(symbolId);
  }

  public getLastTickEpoch(symbolId: string): number | undefined {
    return this.lastTick.get(symbolId);
  }

  public subscribeTicks(): void {}

  public fetchCandlesHistory(
    symbolId: string,
    timeframe: Timeframe,
    count: number,
    callback: HistoryRequestCallback,
    end?: number | 'latest'
  ): void {
    this.requests.push({ symbolId, timeframe, count, end });
    this.pending.push({ symbolId, timeframe, callback });
  }

  public onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  public onTick(listener: (tick: TickData) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  public onFeedStatus(listener: (status: FeedStatus) => void): () => void {
    this.feedListeners.add(listener);
    return () => this.feedListeners.delete(listener);
  }

  public emitFeed(status: FeedStatus): void {
    this.feed.set(status.symbol, status);
    for (const listener of this.feedListeners) listener(status);
  }

  public emitTick(value: TickData): void {
    this.lastTick.set(value.symbol, value.epoch);
    for (const listener of this.tickListeners) listener(value);
  }

  public pendingCount(symbolId?: string, timeframe?: Timeframe): number {
    return this.pending.filter(
      (request) =>
        (symbolId === undefined || request.symbolId === symbolId) &&
        (timeframe === undefined || request.timeframe === timeframe)
    ).length;
  }

  public requestCount(symbolId?: string): number {
    return this.requests.filter(
      (request) => symbolId === undefined || request.symbolId === symbolId
    ).length;
  }

  public completeHistory(
    symbolId: string,
    timeframe: Timeframe,
    candles: HistoryCandleData[],
    outcome: HistoryRequestOutcome
  ): void {
    const idx = this.pending.findIndex(
      (request) => request.symbolId === symbolId && request.timeframe === timeframe
    );
    if (idx < 0) throw new Error(`no pending history request for ${symbolId}:${timeframe}`);
    const [request] = this.pending.splice(idx, 1);
    request.callback(symbolId, timeframe, candles, outcome);
  }
}

/** Seed the initial backfill and leave a forming candle at INTERRUPTED_PERIOD. */
function seedAndTick(source: RecordingSource, symbolId: string): void {
  source.completeHistory(symbolId, '1m', series(FIRST_PERIOD, SEED_PERIODS), 'success');
  source.emitTick(tick(symbolId, 1.1, LIVE_TICK_EPOCH));
}

// =============================================================================================
// A — Basic self-healing
// =============================================================================================

test('G7 A — STALE -> LIVE without a reconnect resumes recovery and stays blocked until success', () => {
  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });
  const observations = collect(adapter);

  try {
    adapter.start();
    seedAndTick(source, EURUSD);
    assert.equal(core.candleManager.isRecoveryRequired(EURUSD, '1m'), false);

    const requestsBeforeStale = source.requests.length;

    source.emitFeed({ symbol: EURUSD, state: 'STALE' });
    const requirement = core.candleManager.getRecoveryRequirement(EURUSD, '1m');
    assert.ok(requirement, 'the stale episode records a recovery requirement');
    assert.equal(requirement.recoveryEpoch, INTERRUPTED_PERIOD);
    assert.equal(adapter.getPairState(EURUSD, '1m')?.recoveryRequired, true);

    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    assert.equal(
      source.requests.length,
      requestsBeforeStale + 1,
      'becoming live again initiates the recovery request'
    );
    assert.equal(
      core.candleManager.isRecoveryRequired(EURUSD, '1m'),
      true,
      'the pair remains blocked before recovery succeeds'
    );
    assert.equal(
      adapter.handleClosedCandle(EURUSD, '1m', closedCandle(INTERRUPTED_PERIOD + MINUTE)),
      null,
      'a close is never evaluated while recovery is pending'
    );
    assert.equal(adapter.getPairState(EURUSD, '1m')?.evaluationCount, 0);

    source.completeHistory(EURUSD, '1m', [historyCandle(INTERRUPTED_PERIOD)], 'success');

    assert.equal(
      core.candleManager.isRecoveryRequired(EURUSD, '1m'),
      false,
      'the verified recovery releases the pair'
    );
    assert.equal(adapter.getPairState(EURUSD, '1m')?.recoveryRequired, false);

    const report = adapter.handleClosedCandle(
      EURUSD,
      '1m',
      closedCandle(INTERRUPTED_PERIOD + MINUTE)
    );
    assert.ok(report, 'normal evaluation resumes after the successful recovery');
    assert.equal(adapter.getPairState(EURUSD, '1m')?.evaluationCount, 1);
    assert.equal(ofType(observations, 'evaluation').length, 1);
  } finally {
    adapter.stop();
  }
});

// =============================================================================================
// B — Duplicate LIVE notifications
// =============================================================================================

test('G7 B — repeated LIVE notifications create one job and keep the original anchor', () => {
  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });

  try {
    adapter.start();
    seedAndTick(source, EURUSD);
    source.emitFeed({ symbol: EURUSD, state: 'STALE' });

    const before = core.candleManager.getRecoveryRequirement(EURUSD, '1m');
    assert.ok(before);
    const requestsBeforeLive = source.requests.length;

    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    assert.equal(
      source.requests.length,
      requestsBeforeLive + 1,
      'multiple LIVE notifications schedule exactly one recovery request'
    );
    assert.equal(source.pendingCount(EURUSD, '1m'), 1, 'only one request is in flight');

    const after = core.candleManager.getRecoveryRequirement(EURUSD, '1m');
    assert.ok(after);
    assert.equal(after.recoveryEpoch, before.recoveryEpoch, 'the original gap anchor is unchanged');
    assert.equal(after.interruptedEpoch, before.interruptedEpoch);
    assert.equal(after.requiredCount, before.requiredCount);
  } finally {
    adapter.stop();
  }
});

// =============================================================================================
// C — Retry-budget preservation
// =============================================================================================

test('G7 C — LIVE never resets a consumed retry budget', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });

  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });
  const incomplete = () => [historyCandle(FIRST_PERIOD), historyCandle(FIRST_PERIOD + MINUTE)];

  try {
    adapter.start();
    seedAndTick(source, EURUSD);

    source.emitFeed({ symbol: EURUSD, state: 'STALE' });
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });
    assert.equal(source.pendingCount(EURUSD, '1m'), 1);

    // First recovery response does not bridge the gap: it consumes attempt 1.
    source.completeHistory(EURUSD, '1m', incomplete(), 'success');
    assert.equal(source.pendingCount(EURUSD, '1m'), 0);
    assert.equal(core.candleManager.isRecoveryRequired(EURUSD, '1m'), true);

    mock.timers.tick(3000);
    assert.equal(source.pendingCount(EURUSD, '1m'), 1, 'retry 1 was issued');
    source.completeHistory(EURUSD, '1m', incomplete(), 'success'); // attempt 2
    assert.equal(source.pendingCount(EURUSD, '1m'), 0);

    mock.timers.tick(3000);
    assert.equal(source.pendingCount(EURUSD, '1m'), 1, 'retry 2 was issued');
    source.completeHistory(EURUSD, '1m', incomplete(), 'success'); // attempt 3 = exhausted
    assert.equal(source.pendingCount(EURUSD, '1m'), 0);

    const requestsAfterExhaustion = source.requests.length;
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    assert.equal(
      source.requests.length,
      requestsAfterExhaustion,
      'LIVE does not silently restart an exhausted budget'
    );
    assert.equal(
      core.candleManager.isRecoveryRequired(EURUSD, '1m'),
      true,
      'the pair stays blocked (fail-closed)'
    );
  } finally {
    adapter.stop();
    mock.timers.reset();
  }
});

// =============================================================================================
// D — Recovery already in flight
// =============================================================================================

test('G7 D — LIVE while recovery is active starts no duplicate cycle', () => {
  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });

  try {
    adapter.start();
    seedAndTick(source, EURUSD);
    source.emitFeed({ symbol: EURUSD, state: 'STALE' });
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    assert.equal(source.pendingCount(EURUSD, '1m'), 1, 'the recovery request is in flight');
    const requestsInFlight = source.requests.length;

    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    assert.equal(source.requests.length, requestsInFlight, 'no duplicate request while active');
    assert.equal(source.pendingCount(EURUSD, '1m'), 1);

    source.completeHistory(EURUSD, '1m', [historyCandle(INTERRUPTED_PERIOD)], 'success');
    assert.equal(
      core.candleManager.isRecoveryRequired(EURUSD, '1m'),
      false,
      'the existing recovery completes normally'
    );

    const requestsAfterRecovery = source.requests.length;
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });
    assert.equal(
      source.requests.length,
      requestsAfterRecovery,
      'a live notification after a completed recovery requests nothing'
    );
  } finally {
    adapter.stop();
  }
});

// =============================================================================================
// E — Incomplete recovery stays fail-closed
// =============================================================================================

test('G7 E — an incomplete recovery keeps the pair blocked and no close becomes eligible', () => {
  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });
  const observations = collect(adapter);

  try {
    adapter.start();
    seedAndTick(source, EURUSD);
    source.emitFeed({ symbol: EURUSD, state: 'STALE' });

    // A late tick spans several periods while the feed is stale. It must not
    // bypass recovery: the requirement widens instead.
    source.emitTick(tick(EURUSD, 1.3, INTERRUPTED_PERIOD + 3 * MINUTE)); // period 540
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    const requirement = core.candleManager.getRecoveryRequirement(EURUSD, '1m');
    assert.ok(requirement);
    assert.equal(requirement.requiredCount, 4, 'the widened gap requires 360,420,480 (+ live 540)');

    // The response skips the newest required period (480).
    source.completeHistory(
      EURUSD,
      '1m',
      [historyCandle(INTERRUPTED_PERIOD), historyCandle(INTERRUPTED_PERIOD + MINUTE)],
      'success'
    );

    assert.equal(
      core.candleManager.isRecoveryRequired(EURUSD, '1m'),
      true,
      'the pair remains blocked when the response does not cover the gap'
    );
    assert.equal(adapter.getPairState(EURUSD, '1m')?.recoveryRequired, true);
    assert.equal(
      adapter.handleClosedCandle(
        EURUSD,
        '1m',
        closedCandle(INTERRUPTED_PERIOD + 4 * MINUTE)
      ),
      null,
      'no close is evaluated from an incomplete recovery'
    );
    assert.equal(adapter.getPairState(EURUSD, '1m')?.evaluationCount, 0);
    assert.equal(ofType(observations, 'evaluation').length, 0);
    assert.equal(ofType(observations, 'candidate').length, 0);
    assert.equal(
      core.candleManager.getHistory(EURUSD, '1m').some((c) => c.epoch === INTERRUPTED_PERIOD),
      false,
      'the incomplete response is not admitted as recovery history'
    );
  } finally {
    adapter.stop();
  }
});

// =============================================================================================
// F — Successful recovery
// =============================================================================================

test('G7 F — all required historical periods are verified before evaluation resumes', () => {
  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });

  try {
    adapter.start();
    seedAndTick(source, EURUSD);
    source.emitFeed({ symbol: EURUSD, state: 'STALE' });
    source.emitTick(tick(EURUSD, 1.3, INTERRUPTED_PERIOD + 3 * MINUTE)); // period 540
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    source.completeHistory(
      EURUSD,
      '1m',
      series(INTERRUPTED_PERIOD, 4), // 360, 420, 480, 540
      'success'
    );

    assert.equal(
      core.candleManager.isRecoveryRequired(EURUSD, '1m'),
      false,
      'the complete required interval releases the pair'
    );
    assert.equal(
      adapter.getPairState(EURUSD, '1m')?.evaluationCount,
      0,
      'recovery itself never evaluates'
    );

    const report = adapter.handleClosedCandle(
      EURUSD,
      '1m',
      closedCandle(INTERRUPTED_PERIOD + 4 * MINUTE)
    );
    assert.ok(report, 'normal evaluation resumes through the existing lifecycle');
    assert.equal(adapter.getPairState(EURUSD, '1m')?.evaluationCount, 1);
  } finally {
    adapter.stop();
  }
});

// =============================================================================================
// G — Symbol isolation
// =============================================================================================

test('G7 G — one symbol healing does not touch an unrelated symbol', () => {
  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [
      { symbolId: EURUSD, timeframe: '1m' },
      { symbolId: GBPUSD, timeframe: '1m' },
    ],
  });

  try {
    adapter.start();
    seedAndTick(source, EURUSD);
    seedAndTick(source, GBPUSD);

    source.emitFeed({ symbol: EURUSD, state: 'STALE' });
    assert.equal(core.candleManager.isRecoveryRequired(EURUSD, '1m'), true);
    assert.equal(
      core.candleManager.isRecoveryRequired(GBPUSD, '1m'),
      false,
      'the unrelated symbol is not marked'
    );

    const gbpRequestsBefore = source.requestCount(GBPUSD);
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    assert.equal(source.requestCount(EURUSD), 2, 'only EURUSD is re-requested');
    assert.equal(
      source.requestCount(GBPUSD),
      gbpRequestsBefore,
      'the unrelated symbol receives no extra request'
    );
    assert.equal(adapter.getPairState(GBPUSD, '1m')?.recoveryRequired, false);

    source.completeHistory(EURUSD, '1m', [historyCandle(INTERRUPTED_PERIOD)], 'success');
    assert.equal(core.candleManager.isRecoveryRequired(EURUSD, '1m'), false);
    assert.equal(
      core.candleManager.isRecoveryRequired(GBPUSD, '1m'),
      false,
      'the unrelated symbol is still unaffected after the recovery completes'
    );

    assert.ok(
      adapter.handleClosedCandle(GBPUSD, '1m', closedCandle(INTERRUPTED_PERIOD + MINUTE)),
      'the unrelated symbol remains evaluable'
    );
  } finally {
    adapter.stop();
  }
});

// =============================================================================================
// H — Dashboard integration
// =============================================================================================

/**
 * The dashboard's actual recovery collaborators, wired the same way
 * `app/dashboard/page.tsx` wires them. Ingestion, retry, chunking, and recovery
 * are the real production modules; only the React state updates are omitted.
 */
class DashboardRecoveryHarness {
  public readonly manager = new CandleManager();
  public readonly core: MonitoringCore;
  public readonly bookkeeping = createHistoryBookkeeping();
  public readonly controller: HistoryRecoveryController;
  public readonly chunks: RecoveryChunkCoordinator;
  public readonly displayedSymbol = EURUSD;
  public readonly displayedTimeframe: Timeframe = '1m';

  constructor(private readonly source: RecordingSource) {
    this.core = new MonitoringCore({ candleManager: this.manager });
    this.controller = new HistoryRecoveryController({
      canRetry: () => this.source.getStatus() === 'CONNECTED',
      onRetry: (symbolId, timeframe) => this.requestHistory(symbolId, timeframe),
    });
    this.chunks = new RecoveryChunkCoordinator({
      manager: this.manager,
      controller: this.controller,
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
      onCycleEnd: (result) => {
        applyHistoryOutcome(
          this.bookkeeping,
          result.symbol,
          result.timeframe,
          result.admittedCandleCount
        );
      },
    });
  }

  /** The dashboard's `requestHistory` path. */
  public requestHistory(symbolId: string, timeframe: Timeframe): void {
    const recoveryRequired = this.manager.isRecoveryRequired(symbolId, timeframe);
    const plan = planHistoryLoad(
      symbolId,
      timeframe,
      this.bookkeeping.seeded,
      this.bookkeeping.pending,
      true,
      recoveryRequired
    );
    if (plan !== 'request') return;

    markHistoryPending(this.bookkeeping, symbolId, timeframe);

    const chunkStart = this.chunks.start(symbolId, timeframe);
    if (chunkStart.kind === 'chunked' || chunkStart.kind === 'oversized') return;

    const count = this.manager.getRecoveryHistoryCount(symbolId, timeframe, 100);
    this.source.fetchCandlesHistory(symbolId, timeframe, count, (s, tf, candles, outcome) => {
      applyHistoryResponse({
        manager: this.manager,
        controller: this.controller,
        symbol: s,
        timeframe: tf,
        candles: candles ?? [],
        requestOutcome: outcome,
      });
      const admitted = this.manager.getLastHistoryAdmission(s, tf);
      applyHistoryOutcome(this.bookkeeping, s, tf, admitted?.admitted ?? 0);
    });
  }

  /** The dashboard's `onStale` (isStale === true) branch. */
  public onStale(symbol: string): void {
    this.manager.markDiscontinuity(symbol);
    this.controller.cancel(symbol, this.displayedTimeframe);
  }

  /** The dashboard's `onStale` (isStale === false) branch. */
  public onLive(symbol: string): boolean {
    if (symbol !== this.displayedSymbol) return false;
    const tf = this.displayedTimeframe;
    return resumeStaleRecovery({
      isRecoveryRequired: () => this.manager.isRecoveryRequired(symbol, tf),
      isRequestPending: () => this.bookkeeping.pending.has(historyKey(symbol, tf)),
      isRetryScheduled: () => this.controller.isScheduled(symbol, tf),
      isChunkActive: () => this.chunks.isActive(symbol, tf),
      hasRetryBudget: () => this.controller.hasAttemptsLeft(symbol, tf),
      requestHistory: () => this.requestHistory(symbol, tf),
    });
  }

  public evaluate(symbolId: string, timeframe: Timeframe) {
    if (this.manager.isRecoveryRequired(symbolId, timeframe)) return null;
    return this.core.evaluatePair(symbolId, timeframe);
  }
}

// =============================================================================================
// I — Transport outcomes of a resumed single-request recovery are retried
// =============================================================================================

test('G7 I1 — an empty response to a resumed recovery schedules exactly one bounded retry', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });

  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });

  try {
    adapter.start();
    seedAndTick(source, EURUSD);
    source.emitFeed({ symbol: EURUSD, state: 'STALE' });
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    assert.equal(source.pendingCount(EURUSD, '1m'), 1, 'the resumed request is in flight');
    const requestsAfterResume = source.requests.length;

    source.completeHistory(EURUSD, '1m', [], 'empty');

    assert.equal(source.pendingCount(EURUSD, '1m'), 0);
    assert.equal(
      source.requests.length,
      requestsAfterResume,
      'the empty response itself issues no second request'
    );
    assert.equal(
      core.candleManager.isRecoveryRequired(EURUSD, '1m'),
      true,
      'an empty response never releases the pair'
    );

    mock.timers.tick(3000);
    assert.equal(source.pendingCount(EURUSD, '1m'), 1, 'exactly one bounded retry was issued');
    assert.equal(source.requests.length, requestsAfterResume + 1);

    mock.timers.tick(3000);
    assert.equal(
      source.requests.length,
      requestsAfterResume + 1,
      'no second retry is stacked while the first retry is in flight'
    );
    assert.equal(core.candleManager.isRecoveryRequired(EURUSD, '1m'), true);
  } finally {
    adapter.stop();
    mock.timers.reset();
  }
});

test('G7 I2 — a transport failure on a resumed recovery schedules exactly one bounded retry', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });

  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });

  try {
    adapter.start();
    seedAndTick(source, EURUSD);
    source.emitFeed({ symbol: EURUSD, state: 'STALE' });
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    const requestsAfterResume = source.requests.length;
    source.completeHistory(EURUSD, '1m', [], 'failure');

    assert.equal(source.pendingCount(EURUSD, '1m'), 0);
    assert.equal(source.requests.length, requestsAfterResume);
    assert.equal(core.candleManager.isRecoveryRequired(EURUSD, '1m'), true);

    mock.timers.tick(3000);
    assert.equal(source.pendingCount(EURUSD, '1m'), 1, 'the transport failure is retried once');
    assert.equal(source.requests.length, requestsAfterResume + 1);
    assert.equal(
      core.candleManager.isRecoveryRequired(EURUSD, '1m'),
      true,
      'the retry request itself does not release the pair'
    );

    mock.timers.tick(3000);
    assert.equal(
      source.requests.length,
      requestsAfterResume + 1,
      'no duplicate retry is stacked'
    );
  } finally {
    adapter.stop();
    mock.timers.reset();
  }
});

test('G7 I3 — the bounded retry after a failure can complete the recovery and restore evaluation', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });

  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });

  try {
    adapter.start();
    seedAndTick(source, EURUSD);
    source.emitFeed({ symbol: EURUSD, state: 'STALE' });
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    source.completeHistory(EURUSD, '1m', [], 'empty');
    mock.timers.tick(3000);
    assert.equal(source.pendingCount(EURUSD, '1m'), 1, 'the retry is in flight');

    source.completeHistory(EURUSD, '1m', [historyCandle(INTERRUPTED_PERIOD)], 'success');

    assert.equal(
      core.candleManager.isRecoveryRequired(EURUSD, '1m'),
      false,
      'the successful retry clears the recovery requirement'
    );
    assert.ok(
      adapter.handleClosedCandle(EURUSD, '1m', closedCandle(INTERRUPTED_PERIOD + MINUTE)),
      'evaluation resumes after the verified recovery'
    );
    assert.equal(adapter.getPairState(EURUSD, '1m')?.evaluationCount, 1);
  } finally {
    adapter.stop();
    mock.timers.reset();
  }
});

test('G7 I4 — LIVE while a bounded retry is scheduled does not issue a duplicate request', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });

  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });

  try {
    adapter.start();
    seedAndTick(source, EURUSD);
    source.emitFeed({ symbol: EURUSD, state: 'STALE' });
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    source.completeHistory(EURUSD, '1m', [], 'empty');
    const requestsAfterFailure = source.requests.length;
    assert.equal(source.pendingCount(EURUSD, '1m'), 0, 'the retry is scheduled, not in flight');

    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    assert.equal(
      source.requests.length,
      requestsAfterFailure,
      'LIVE does not bypass the already scheduled retry'
    );
    assert.equal(source.pendingCount(EURUSD, '1m'), 0);

    mock.timers.tick(3000);
    assert.equal(source.pendingCount(EURUSD, '1m'), 1, 'the original retry fires exactly once');
    assert.equal(source.requests.length, requestsAfterFailure + 1);
  } finally {
    adapter.stop();
    mock.timers.reset();
  }
});

test('G7 I5 — LIVE while a bounded chunk cycle is active issues no duplicate single request', () => {
  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });
  const wideEdge = INTERRUPTED_PERIOD + 5001 * MINUTE;

  try {
    adapter.start();
    seedAndTick(source, EURUSD);
    source.emitFeed({ symbol: EURUSD, state: 'STALE' });

    // A late tick widens the gap far beyond one history request but inside the
    // bounded chunk capacity.
    source.emitTick(tick(EURUSD, 1.3, wideEdge + 30));
    const requestsBeforeLive = source.requests.length;
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    assert.equal(source.requests.length, requestsBeforeLive + 1, 'the chunk cycle issued a window');
    assert.equal(source.pendingCount(EURUSD, '1m'), 1, 'the chunk window is in flight');

    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    assert.equal(
      source.requests.length,
      requestsBeforeLive + 1,
      'a repeated LIVE adds no single request next to the active chunk cycle'
    );
    assert.equal(source.pendingCount(EURUSD, '1m'), 1);
    assert.equal(core.candleManager.isRecoveryRequired(EURUSD, '1m'), true);
  } finally {
    adapter.stop();
  }
});

test('G7 I6 — STALE for one symbol preserves another symbol scheduled retry and budget', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });

  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [
      { symbolId: EURUSD, timeframe: '1m' },
      { symbolId: GBPUSD, timeframe: '1m' },
    ],
  });
  const incomplete = () => [historyCandle(FIRST_PERIOD), historyCandle(FIRST_PERIOD + MINUTE)];

  try {
    adapter.start();
    seedAndTick(source, EURUSD);
    seedAndTick(source, GBPUSD);

    // Give GBPUSD an outstanding recovery and let its first response consume
    // one bounded attempt, leaving a scheduled retry.
    source.emitFeed({ symbol: GBPUSD, state: 'STALE' });
    source.emitFeed({ symbol: GBPUSD, state: 'LIVE' });
    source.completeHistory(GBPUSD, '1m', incomplete(), 'success');
    assert.equal(source.pendingCount(GBPUSD, '1m'), 0, 'the retry is scheduled, not in flight');

    // EURUSD going stale must cancel only EURUSD retries.
    source.emitFeed({ symbol: EURUSD, state: 'STALE' });
    assert.equal(core.candleManager.isRecoveryRequired(EURUSD, '1m'), true);
    assert.equal(core.candleManager.isRecoveryRequired(GBPUSD, '1m'), true);

    const gbpRequestsBeforeRetry = source.requestCount(GBPUSD);

    mock.timers.tick(3000);
    assert.equal(
      source.pendingCount(GBPUSD, '1m'),
      1,
      'the other symbol scheduled retry survived the STALE cancellation'
    );
    assert.equal(source.requestCount(GBPUSD), gbpRequestsBeforeRetry + 1);
    assert.equal(source.pendingCount(EURUSD, '1m'), 0, 'no request was issued for the stale symbol');

    // The preserved budget remains bounded: attempts 2 and 3 still exist, then
    // the chain stops.
    source.completeHistory(GBPUSD, '1m', incomplete(), 'success');
    mock.timers.tick(3000);
    assert.equal(source.pendingCount(GBPUSD, '1m'), 1, 'attempt 2 is issued');

    source.completeHistory(GBPUSD, '1m', incomplete(), 'success');
    mock.timers.tick(3000);
    assert.equal(source.pendingCount(GBPUSD, '1m'), 1, 'attempt 3 is issued');

    source.completeHistory(GBPUSD, '1m', incomplete(), 'success');
    const gbpRequestsAfterExhaustion = source.requestCount(GBPUSD);
    mock.timers.tick(3000);
    assert.equal(
      source.requestCount(GBPUSD),
      gbpRequestsAfterExhaustion,
      'the retry budget is still bounded at its unchanged limit'
    );
    assert.equal(
      core.candleManager.isRecoveryRequired(GBPUSD, '1m'),
      true,
      'the unrelated symbol stays blocked while its gap is open'
    );
  } finally {
    adapter.stop();
    mock.timers.reset();
  }
});

test('G7 H — dashboard STALE -> LIVE integration cannot silently leave the pair blocked', () => {
  const source = new RecordingSource();
  const dashboard = new DashboardRecoveryHarness(source);

  dashboard.requestHistory(EURUSD, '1m');
  seedAndTick(source, EURUSD);
  assert.equal(dashboard.manager.isRecoveryRequired(EURUSD, '1m'), false);

  dashboard.onStale(EURUSD);
  assert.equal(
    dashboard.manager.isRecoveryRequired(EURUSD, '1m'),
    true,
    'the dashboard stale branch blocks the pair'
  );

  const requestsBeforeLive = source.requests.length;
  assert.equal(dashboard.onLive(EURUSD), true, 'the live branch resumes recovery');
  assert.equal(source.requests.length, requestsBeforeLive + 1);

  assert.equal(dashboard.onLive(EURUSD), false, 'a repeated live notification starts no job');
  assert.equal(dashboard.onLive(EURUSD), false);
  assert.equal(
    source.requests.length,
    requestsBeforeLive + 1,
    'repeated status events create no duplicate recovery work'
  );

  source.completeHistory(EURUSD, '1m', [historyCandle(INTERRUPTED_PERIOD)], 'success');

  assert.equal(
    dashboard.manager.isRecoveryRequired(EURUSD, '1m'),
    false,
    'the pair is not left permanently blocked'
  );
  assert.ok(
    dashboard.evaluate(EURUSD, '1m'),
    'normal dashboard evaluation is restored through the existing lifecycle'
  );
});
