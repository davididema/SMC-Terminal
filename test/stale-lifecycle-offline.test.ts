import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  CandleManager,
  type Candle,
  type TickData,
  type Timeframe,
} from '../lib/deriv/candles';
import { DerivWebSocketClient, type ConnectionStatus } from '../lib/deriv/websocket';
import { HistoryRecoveryController } from '../lib/deriv/history-recovery';
import {
  RecoveryChunkCoordinator,
  type RecoveryCycleResult,
} from '../lib/deriv/history-chunks';
import {
  LiveAcquisitionAdapter,
  type MonitoringMarketSource,
} from '../lib/monitoring/live-acquisition';
import { MonitoringCore } from '../lib/monitoring/headless-core';
import type { FeedStatus } from '../lib/deriv/feed';
import type {
  HistoryCandleData,
  HistoryRequestCallback,
  HistoryRequestOutcome,
} from '../lib/deriv/history-requests';

const EURUSD = 'EURUSD';
const PERIOD = 60;
const ANCHOR = 60;

function historyCandle(epoch: number, close = 1.1): HistoryCandleData {
  return { epoch, open: close, high: close, low: close, close };
}

function series(firstEpoch: number, count: number, close = 1.1): HistoryCandleData[] {
  const out: HistoryCandleData[] = [];
  for (let i = 0; i < count; i++) out.push(historyCandle(firstEpoch + i * PERIOD, close));
  return out;
}

function tick(symbol: string, price: number, epoch: number): TickData {
  return { symbol, derivSymbol: symbol, price, epoch };
}

function liveEpochOf(periods: number): number {
  return ANCHOR + periods * PERIOD;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

test('C2 stale — emitted once after the threshold, cleared by a tick, then re-armed', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  const original = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];

  const client = new DerivWebSocketClient({
    pingIntervalMs: 1_000_000,
    staleThresholdSeconds: 1,
    reconnectBaseDelayMs: 1_000_000,
  });
  const events: Array<{ symbol: string; isStale: boolean }> = [];
  client.onStale((symbol, isStale) => events.push({ symbol, isStale }));

  try {
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    client.subscribeTicks(EURUSD);

    const emit = (epoch: number) =>
      socket.emit({
        msg_type: 'tick',
        tick: { symbol: 'frxEURUSD', quote: 1.09, epoch },
      });

    emit(Math.floor(Date.now() / 1000));
    assert.equal(client.isSymbolStale(EURUSD), false);
    assert.equal(events.length, 0);

    mock.timers.tick(5_000);
    assert.equal(client.isSymbolStale(EURUSD), true);
    assert.deepEqual(events, [{ symbol: EURUSD, isStale: true }]);

    mock.timers.tick(10_000);
    assert.equal(events.length, 1, 'a continuing stale episode is not re-emitted');

    emit(Math.floor(Date.now() / 1000));
    assert.equal(client.isSymbolStale(EURUSD), false);
    assert.deepEqual(
      events.map((event) => event.isStale),
      [true, false]
    );

    mock.timers.tick(5_000);
    assert.deepEqual(
      events.map((event) => event.isStale),
      [true, false, true],
      'silence after a healthy tick starts a new episode'
    );
  } finally {
    client.disconnect();
    mock.timers.reset();
    (globalThis as { WebSocket?: unknown }).WebSocket = original;
  }
});

test('C2 recovery — cancellation prevents a scheduled retry without restoring the budget', async () => {
  let retries = 0;
  const controller = new HistoryRecoveryController({
    policy: { maxAttempts: 3, delayMs: 20 },
    canRetry: () => true,
    onRetry: () => {
      retries += 1;
    },
  });

  controller.handleOutcome(EURUSD, '1m', 'failure');
  assert.equal(controller.isScheduled(EURUSD, '1m'), true);
  assert.equal(controller.attemptsFor(EURUSD, '1m'), 1);

  controller.cancelAll();
  assert.equal(controller.isScheduled(EURUSD, '1m'), false);

  await delay(60);
  assert.equal(retries, 0, 'the cancelled retry never fires');
  assert.equal(
    controller.attemptsFor(EURUSD, '1m'),
    1,
    'cancellation preserves the consumed attempt'
  );
});

class RecordingSource implements MonitoringMarketSource {
  public readonly requests: Array<{
    symbolId: string;
    timeframe: Timeframe;
    count: number;
    end: number | 'latest' | undefined;
  }> = [];

  private status: ConnectionStatus = 'DISCONNECTED';
  private readonly feed = new Map<string, FeedStatus>();
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

  public getLastTickEpoch(): number | undefined {
    return undefined;
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
    for (const listener of this.tickListeners) listener(value);
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

test('C2 stale — a self-healing STALE to LIVE transition resumes the recovery request', () => {
  const core = new MonitoringCore();
  const source = new RecordingSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });

  try {
    adapter.start();
    source.completeHistory(EURUSD, '1m', series(PERIOD, 5), 'success');
    source.emitTick(tick(EURUSD, 1.1, PERIOD + 5 * PERIOD + 30));
    assert.equal(core.candleManager.isRecoveryRequired(EURUSD, '1m'), false);

    const requestsBefore = source.requests.length;

    source.emitFeed({ symbol: EURUSD, state: 'STALE' });
    assert.equal(core.candleManager.isRecoveryRequired(EURUSD, '1m'), true);
    assert.equal(adapter.getPairState(EURUSD, '1m')?.recoveryRequired, true);

    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });
    source.emitFeed({ symbol: EURUSD, state: 'LIVE' });

    assert.equal(
      source.requests.length,
      requestsBefore + 1,
      'the LIVE transition re-requests the interrupted history exactly once'
    );
    assert.equal(
      core.candleManager.isRecoveryRequired(EURUSD, '1m'),
      true,
      'the pair stays blocked until the recovery response bridges the gap'
    );

    source.completeHistory(EURUSD, '1m', series(PERIOD + 5 * PERIOD, 1), 'success');
    assert.equal(
      core.candleManager.isRecoveryRequired(EURUSD, '1m'),
      false,
      'a complete recovery releases the pair'
    );

    source.emitTick(tick(EURUSD, 1.2, PERIOD + 6 * PERIOD + 30));
    assert.equal(
      source.requests.length,
      requestsBefore + 1,
      'a live tick after the completed recovery requests nothing new'
    );
  } finally {
    adapter.stop();
  }
});

class WindowProvider {
  public readonly requests: Array<{ count: number; end: number | null }> = [];
  public defer = true;

  private readonly deferred: Array<() => void> = [];

  constructor(
    private readonly liveEpoch: number,
    private readonly includeLive: boolean
  ) {}

  public fetch(
    symbol: string,
    timeframe: Timeframe,
    count: number,
    end: number | null,
    callback: (candles: HistoryCandleData[], outcome: HistoryRequestOutcome) => void
  ): void {
    void symbol;
    void timeframe;
    this.requests.push({ count, end });

    const deliver = () => {
      const newest =
        end ?? (this.includeLive ? this.liveEpoch : this.liveEpoch - PERIOD);
      const oldest = newest - (count - 1) * PERIOD;
      const candles: HistoryCandleData[] = [];
      for (let epoch = oldest; epoch <= newest; epoch += PERIOD) {
        candles.push(historyCandle(epoch));
      }
      callback(candles, 'success');
    };

    if (this.defer) {
      this.deferred.push(deliver);
    } else {
      deliver();
    }
  }

  public flush(): void {
    this.defer = false;
    while (this.deferred.length > 0) {
      const deliver = this.deferred.shift();
      if (deliver) deliver();
    }
  }
}

interface ChunkHarness {
  manager: CandleManager;
  provider: WindowProvider;
  controller: HistoryRecoveryController;
  coordinator: RecoveryChunkCoordinator;
  results: RecoveryCycleResult[];
}

function createChunkHarness(includeLive: boolean): ChunkHarness {
  const manager = new CandleManager(30000);
  const provider = new WindowProvider(liveEpochOf(8000), includeLive);
  const results: RecoveryCycleResult[] = [];
  const controller = new HistoryRecoveryController({
    policy: { maxAttempts: 0, delayMs: 5 },
    canRetry: () => true,
    onRetry: () => {
      throw new Error('a retry was scheduled in a test with no retry budget');
    },
  });
  const coordinator = new RecoveryChunkCoordinator({
    manager,
    controller,
    transport: {
      fetchHistoryWindow: (symbol, timeframe, count, end, callback) =>
        provider.fetch(symbol, timeframe, count, end, callback),
    },
    onCycleEnd: (result) => results.push(result),
  });

  manager.processTick(tick(EURUSD, 1.1, ANCHOR + 30));
  manager.markDiscontinuity(EURUSD);
  manager.processTick(tick(EURUSD, 1.2, liveEpochOf(8000) + 30));

  return { manager, provider, controller, coordinator, results };
}

test('C2 stale — a chunk cycle that cannot re-derive the interrupted live period stays blocked', () => {
  const harness = createChunkHarness(false);
  const start = harness.coordinator.start(EURUSD, '1m');
  assert.equal(start.kind, 'chunked');
  assert.equal(harness.provider.requests.length, 1);
  assert.equal(harness.provider.requests[0].end, null);

  harness.manager.markDiscontinuity(EURUSD);
  harness.controller.cancelAll();

  const requirement = harness.manager.getRecoveryRequirement(EURUSD, '1m');
  assert.ok(requirement);
  assert.equal(requirement.interruptedEpoch, liveEpochOf(8000));

  harness.provider.flush();

  assert.equal(harness.results.length, 1);
  assert.equal(harness.results[0].recoveryComplete, false);
  assert.equal(harness.results[0].recoveryPending, true);
  assert.equal(harness.manager.isRecoveryRequired(EURUSD, '1m'), true);
});

test('C2 stale — a chunk cycle that re-derives the live period resumes without a false close', () => {
  const harness = createChunkHarness(true);
  const closes: Candle[] = [];
  harness.manager.onCandleClose((symbol, timeframe, candle) => {
    if (symbol === EURUSD && timeframe === '1m') closes.push(candle);
  });

  const start = harness.coordinator.start(EURUSD, '1m');
  assert.equal(start.kind, 'chunked');

  harness.manager.markDiscontinuity(EURUSD);
  harness.controller.cancelAll();
  assert.equal(
    harness.manager.getRecoveryRequirement(EURUSD, '1m')?.interruptedEpoch,
    liveEpochOf(8000)
  );

  harness.provider.flush();

  assert.equal(harness.results.length, 1);
  assert.equal(harness.results[0].recoveryComplete, true);
  assert.equal(harness.manager.isRecoveryRequired(EURUSD, '1m'), false);
  assert.ok(
    harness.manager.getHistory(EURUSD, '1m').some((c) => c.epoch === liveEpochOf(8000)),
    'the interrupted live period is authoritative history'
  );
  assert.equal(closes.length, 0, 'recovery never emits a live close');

  harness.manager.processTick(tick(EURUSD, 1.3, liveEpochOf(8000) + PERIOD + 30));
  assert.equal(closes.length, 0, 'the recovered period is not finalized by a later tick');

  harness.manager.processTick(tick(EURUSD, 1.4, liveEpochOf(8000) + 2 * PERIOD + 30));
  assert.equal(closes.length, 1);
  assert.equal(closes[0].epoch, liveEpochOf(8000) + PERIOD);
});
