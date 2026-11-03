/**
 * Phase 3A — D6: an out-of-order tick must not regress the live edge.
 *
 * The confirmed defect: `CandleManager.processTick` recorded the event time of
 * EVERY tick, including a delayed one. The candle construction ignored the
 * out-of-order tick (as it must), but the tracked live edge moved backwards
 * with it. The live edge is the reference of the recovery coverage
 * (`getRecoveryRequirement`), so a stale live edge could weaken the recovery
 * requirement of a pair that was still blocked, and the history merge could
 * treat a completed candle as if it were still forming.
 *
 * These tests use synthetic epochs and an in-memory market source. No socket,
 * no network, and no fabricated market data: the candles are deterministic
 * fixtures whose only purpose is to describe periods.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Candle,
  CandleManager,
  TickData,
  Timeframe,
} from '../lib/deriv/candles';
import {
  HistoryRecoveryController,
  applyHistoryResponse,
} from '../lib/deriv/history-recovery';
import {
  RecoveryChunkCoordinator,
  planRecoveryChunks,
  type RecoveryCycleResult,
} from '../lib/deriv/history-chunks';
import {
  LiveAcquisitionAdapter,
  MonitoringMarketSource,
  MonitoringObservation,
} from '../lib/monitoring/live-acquisition';
import { MonitoringCore } from '../lib/monitoring/headless-core';
import { DerivWebSocketClient } from '../lib/deriv/websocket';
import type { ConnectionStatus } from '../lib/deriv/websocket';
import type { FeedStatus } from '../lib/deriv/feed';
import type {
  HistoryCandleData,
  HistoryRequestCallback,
  HistoryRequestOutcome,
} from '../lib/deriv/history-requests';

// --- The scenario -------------------------------------------------------------
// A tick at epoch 100 belongs to the 1m period that starts at epoch 60. The
// connection then drops; the first tick after the reconnect is at epoch 700 and
// belongs to the 1m period that starts at epoch 660.
const INTERRUPTED_PERIOD = 60;
const LIVE_PERIOD = 660;
const PERIOD = 60;

/** The anchor period of the wide gap used by the D5 interaction test. */
const ANCHOR = 60;

function tick(symbol: string, price: number, epoch: number): TickData {
  return { symbol, derivSymbol: symbol, price, epoch };
}

/** A deterministic closed candle for a 1m period. */
function candle(epoch: number, close = 1.1): HistoryCandleData {
  return { epoch, open: close, high: close, low: close, close };
}

/** The history a recovery would return: the interrupted period up to the live edge. */
function recoveryCandles(epochs: readonly number[]): HistoryCandleData[] {
  return epochs.map((epoch) => candle(epoch));
}

/** The live edge of a gap that spans `periods` 1m periods. */
function liveEpochOf(periods: number): number {
  return ANCHOR + periods * PERIOD;
}

// =============================================================================================
// A — an older tick cannot regress the live edge
// =============================================================================================

test('D6 A1 — an older tick cannot move the tracked live edge backwards', () => {
  const manager = new CandleManager();
  manager.processTick(tick('EURUSD', 1.1, 720));
  assert.equal(manager.getState('EURUSD')!.lastTickTime, 720, 'the live edge is the newest event');

  // A delayed tick from before the newest event arrives.
  manager.processTick(tick('EURUSD', 9.9, 660));

  assert.equal(
    manager.getState('EURUSD')!.lastTickTime,
    720,
    'the live edge did not move backwards'
  );
  assert.equal(
    manager.getState('EURUSD')!.lastPrice,
    1.1,
    'the price of the newest accepted event is kept'
  );
  assert.equal(
    manager.getCurrentCandle('EURUSD', '1m')?.epoch,
    720,
    'the candle state is untouched by the out-of-order tick'
  );
});

test('D6 A2 — an older tick cannot regress the recovery requirement', () => {
  const manager = new CandleManager();
  manager.processTick(tick('EURUSD', 1.1, 100));
  manager.markDiscontinuity('EURUSD');
  manager.processTick(tick('EURUSD', 1.2, 700));

  const before = manager.getRecoveryRequirement('EURUSD', '1m');
  assert.ok(before, 'the blocked pair has a requirement');
  assert.equal(before.liveEpoch, LIVE_PERIOD, 'the live edge of the requirement');
  assert.equal(before.requiredCount, 11, 'the number of required periods');

  // A delayed tick arrives while the pair is blocked.
  manager.processTick(tick('EURUSD', 9.9, 400));

  const after = manager.getRecoveryRequirement('EURUSD', '1m');
  assert.ok(after, 'the pair is still blocked');
  assert.equal(after.liveEpoch, before.liveEpoch, 'the live edge did not move backwards');
  assert.equal(
    after.requiredCount,
    before.requiredCount,
    'the requirement did not shrink to a weaker one'
  );
  assert.equal(
    after.recoveryEpoch,
    before.recoveryEpoch,
    'the oldest gap anchor is kept'
  );
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), true, 'the pair stays blocked');
});

test('D6 A3 — an out-of-order tick does not regress the feed health timestamp', () => {
  withFakeWebSocket(() => {
    const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
    try {
      client.subscribeTicks('EURUSD');
      client.connect();
      const socket = FakeWebSocket.instances[0];
      socket.open();

      socket.emit({
        msg_type: 'tick',
        tick: { symbol: 'frxEURUSD', quote: 1.09345, epoch: 1700000000, pip_size: 5 },
      });
      assert.equal(client.getFeedStatus('EURUSD')?.lastTickEpoch, 1700000000);

      // A delayed tick arrives.
      socket.emit({
        msg_type: 'tick',
        tick: { symbol: 'frxEURUSD', quote: 1.093, epoch: 1699999900, pip_size: 5 },
      });

      assert.equal(
        client.getFeedStatus('EURUSD')?.lastTickEpoch,
        1700000000,
        'the feed health timestamp did not regress'
      );
      assert.equal(client.getLastTickEpoch('EURUSD'), 1700000000);
      assert.equal(
        client.getFeedStatus('EURUSD')?.state,
        'LIVE',
        'the feed is still healthy'
      );
    } finally {
      client.disconnect();
    }
  });
});

test('D6 A4 — the monitored pair keeps its last-tick time when a delayed tick arrives', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  adapter.start();
  source.completeHistory('EURUSD', '1m', recoveryCandles([0]), 'success');

  source.emitTick(tick('EURUSD', 1.1, 100));
  assert.equal(adapter.getPairState('EURUSD', '1m')?.lastTickEpoch, 100);

  source.emitTick(tick('EURUSD', 9.9, 40));
  assert.equal(
    adapter.getPairState('EURUSD', '1m')?.lastTickEpoch,
    100,
    'the pair keeps the time of its newest event'
  );
});

// =============================================================================================
// B — a newer tick advances the live edge normally
// =============================================================================================

test('D6 B1 — a newer tick advances the live edge and the candles keep forming', () => {
  const manager = new CandleManager();
  const closes: Candle[] = [];
  manager.onCandleClose((_symbol, timeframe, closed) => {
    if (timeframe === '1m') closes.push(closed);
  });

  manager.processTick(tick('EURUSD', 1.1, 100));
  assert.equal(manager.getState('EURUSD')!.lastTickTime, 100);
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.epoch, INTERRUPTED_PERIOD);

  manager.processTick(tick('EURUSD', 1.2, 700));

  assert.equal(
    manager.getState('EURUSD')!.lastTickTime,
    700,
    'the live edge advanced to the newer event'
  );
  assert.equal(
    manager.getCurrentCandle('EURUSD', '1m')?.epoch,
    LIVE_PERIOD,
    'the forming candle advanced'
  );
  assert.equal(closes.length, 1, 'the previous candle was closed exactly once');
  assert.equal(closes[0].epoch, INTERRUPTED_PERIOD);
});

// =============================================================================================
// C — a duplicate tick
// =============================================================================================

test('D6 C1 — a duplicate tick does not duplicate a close event or a trusted candle', () => {
  const manager = new CandleManager();
  const closes: Candle[] = [];
  manager.onCandleClose((_symbol, _timeframe, closed) => closes.push(closed));

  manager.processTick(tick('EURUSD', 1.1, 100));
  manager.processTick(tick('EURUSD', 1.12, 100));
  manager.processTick(tick('EURUSD', 1.13, 100));

  const current = manager.getCurrentCandle('EURUSD', '1m')!;
  assert.equal(current.epoch, INTERRUPTED_PERIOD, 'the forming candle is unchanged');
  assert.equal(
    current.volume,
    3,
    'several price updates inside one candle stay legitimate'
  );
  assert.equal(current.close, 1.13, 'the newest quote of that candle wins');
  assert.equal(closes.length, 0, 'a duplicate tick never closes a candle');

  // The rollover closes the candle exactly once.
  manager.processTick(tick('EURUSD', 1.3, 120));
  assert.equal(closes.length, 1, 'exactly one close event on the rollover');
  assert.equal(closes[0].epoch, INTERRUPTED_PERIOD);

  const history = manager.getHistory('EURUSD', '1m');
  assert.equal(history.length, 1, 'one trusted candle');
  assert.equal(
    new Set(history.map((c) => c.epoch)).size,
    history.length,
    'no duplicate epochs in the trusted history'
  );
});

test('D6 C2 — a duplicate tick produces no duplicate close and no duplicate evaluation', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  const obs = collect(adapter);
  adapter.start();
  source.completeHistory('EURUSD', '1m', recoveryCandles([0]), 'success');

  source.emitTick(tick('EURUSD', 1.1, 100));
  source.emitTick(tick('EURUSD', 1.12, 100));
  source.emitTick(tick('EURUSD', 1.13, 100));

  assert.equal(ofType(obs, 'candle-close').length, 0, 'no close for a duplicate tick');
  assert.equal(ofType(obs, 'evaluation').length, 0, 'no evaluation for a duplicate tick');
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 0);

  // The rollover still closes and evaluates the candle exactly once.
  source.emitTick(tick('EURUSD', 1.2, 120));
  assert.equal(ofType(obs, 'candle-close').length, 1, 'exactly one close');
  assert.equal(ofType(obs, 'evaluation').length, 1, 'exactly one evaluation');
});

// =============================================================================================
// D — an unusable event time
// =============================================================================================

test('D6 D1 — an unusable event time cannot corrupt the live edge or the candles', () => {
  const manager = new CandleManager();
  manager.processTick(tick('EURUSD', 1.1, 720));

  const unusable: Array<[string, number]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -120],
  ];
  for (const [label, epoch] of unusable) {
    manager.processTick({ symbol: 'EURUSD', derivSymbol: 'EURUSD', price: 9.9, epoch });
    assert.equal(
      manager.getState('EURUSD')!.lastTickTime,
      720,
      `the live edge survives an epoch of ${label}`
    );
    assert.equal(manager.getState('EURUSD')!.lastPrice, 1.1, 'the price is untouched');
  }

  // A malformed (non-numeric) event time is unusable as well.
  manager.processTick({
    symbol: 'EURUSD',
    derivSymbol: 'EURUSD',
    price: 9.9,
    epoch: 'not-a-number' as unknown as number,
  });
  assert.equal(manager.getState('EURUSD')!.lastTickTime, 720);

  // No candle was created on an unusable period.
  const current = manager.getCurrentCandle('EURUSD', '1m')!;
  assert.equal(current.epoch, 720, 'the forming candle is still the newest period');
  assert.ok(Number.isFinite(current.close), 'the candle holds no unusable value');
  assert.equal(manager.getHistory('EURUSD', '1m').length, 0, 'no trusted candle was created');

  // Epoch 0 is a VALID period in this project's data model (the historical
  // validation accepts it), so it is not rejected - it is simply out of order
  // here, and it cannot move the live edge backwards either.
  manager.processTick({ symbol: 'EURUSD', derivSymbol: 'EURUSD', price: 9.9, epoch: 0 });
  assert.equal(
    manager.getState('EURUSD')!.lastTickTime,
    720,
    'an out-of-order epoch 0 does not move the live edge'
  );
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.epoch, 720, 'the candle is untouched');
});

test('D6 D2 — an unusable event time cannot change the recovery state', () => {
  const manager = new CandleManager();
  manager.processTick(tick('EURUSD', 1.1, 100));
  manager.markDiscontinuity('EURUSD');
  manager.processTick(tick('EURUSD', 1.2, 700));

  const before = manager.getRecoveryRequirement('EURUSD', '1m');
  assert.ok(before, 'the blocked pair has a requirement');

  manager.processTick({
    symbol: 'EURUSD',
    derivSymbol: 'EURUSD',
    price: 9.9,
    epoch: Number.NaN,
  });

  const after = manager.getRecoveryRequirement('EURUSD', '1m');
  assert.ok(after, 'the pair is still blocked');
  assert.equal(after.liveEpoch, before.liveEpoch, 'the live edge is unchanged');
  assert.equal(after.requiredCount, before.requiredCount, 'the requirement is unchanged');
  assert.equal(
    manager.getTimeframeState('EURUSD', '1m')?.interruptedEpoch,
    INTERRUPTED_PERIOD,
    'the interrupted candle is still marked'
  );
});

// =============================================================================================
// E — the recovery interaction (D1, D2, D3, D4 and D5 stay protected)
// =============================================================================================

test('D6 E1 — an older tick cannot make an incomplete recovery appear complete', () => {
  const manager = new CandleManager();
  manager.processTick(tick('EURUSD', 1.1, 100));
  manager.markDiscontinuity('EURUSD');
  manager.processTick(tick('EURUSD', 1.2, 700));

  const before = manager.getRecoveryRequirement('EURUSD', '1m')!;

  // A delayed tick arrives while the pair is blocked.
  manager.processTick(tick('EURUSD', 9.9, 400));

  const after = manager.getRecoveryRequirement('EURUSD', '1m')!;
  assert.equal(after.liveEpoch, before.liveEpoch, 'the requirement did not regress');
  assert.equal(after.requiredCount, before.requiredCount, 'the requirement did not shrink');
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), true, 'the pair stays blocked');

  // An incomplete recovery is still refused (D3).
  const refused = manager.recoverFromHistory('EURUSD', '1m', recoveryCandles([60, 120]));
  assert.equal(refused, false, 'the incomplete recovery is refused');
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), true, 'the pair stays blocked');
  assert.equal(
    manager.getTimeframeState('EURUSD', '1m')?.interruptedEpoch,
    INTERRUPTED_PERIOD,
    "D1: the interrupted candle is still marked"
  );
});

test('D6 E2 — an older tick cannot close the interrupted candle', () => {
  const manager = new CandleManager();
  const closes: Candle[] = [];
  manager.onCandleClose((_symbol, _timeframe, closed) => closes.push(closed));

  manager.processTick(tick('EURUSD', 1.1, 100));
  manager.markDiscontinuity('EURUSD');
  manager.processTick(tick('EURUSD', 1.2, 700));
  assert.equal(closes.length, 0, 'the interrupted candle is never closed');

  // A delayed tick must not close it either.
  manager.processTick(tick('EURUSD', 9.9, 400));

  assert.equal(closes.length, 0, 'the interrupted candle is still never closed');
  assert.equal(
    manager.getTimeframeState('EURUSD', '1m')?.interruptedEpoch,
    INTERRUPTED_PERIOD,
    'the interruption is still marked'
  );
  assert.equal(
    manager.getHistory('EURUSD', '1m').length,
    0,
    'it never entered the trusted closed history'
  );
});

test('D6 E3 — an older tick does not touch the bounded retry budget (D2)', () => {
  const manager = new CandleManager();
  const controller = new HistoryRecoveryController({
    policy: { maxAttempts: 3, delayMs: 5 },
    canRetry: () => true,
    onRetry: () => {},
  });

  manager.processTick(tick('EURUSD', 1.1, 100));
  manager.markDiscontinuity('EURUSD');
  manager.processTick(tick('EURUSD', 1.2, 700));

  // A response that does not bridge the gap consumes the budget.
  const applied = applyHistoryResponse({
    manager,
    controller,
    symbol: 'EURUSD',
    timeframe: '1m',
    candles: recoveryCandles([60, 120]),
    requestOutcome: 'success',
  });
  assert.equal(applied.recoveryComplete, false, 'the recovery did not complete');
  assert.equal(applied.outcome, 'failure', 'an incomplete recovery is a retryable failure');
  assert.equal(controller.attemptsFor('EURUSD', '1m'), 1, 'the budget was consumed');

  // The rejected tick changes nothing.
  manager.processTick(tick('EURUSD', 9.9, 400));

  assert.equal(
    controller.attemptsFor('EURUSD', '1m'),
    1,
    'the retry budget is untouched by the rejected tick'
  );
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), true, 'the pair stays blocked');
});

test('D6 E4 — an older tick does not weaken the historical validation (D4)', () => {
  const manager = new CandleManager();
  manager.processTick(tick('EURUSD', 1.1, 100));
  manager.markDiscontinuity('EURUSD');
  manager.processTick(tick('EURUSD', 1.2, 700));

  manager.processTick(tick('EURUSD', 9.9, 400));

  // A response with an invalid entry is still rejected (D4).
  const refused = manager.recoverFromHistory('EURUSD', '1m', [
    { epoch: 60, open: 1.2, high: 1.0, low: 1.1, close: 1.15 },
  ]);
  assert.equal(refused, false, 'the invalid response is refused');
  const admission = manager.getLastHistoryAdmission('EURUSD', '1m')!;
  assert.equal(admission.rejected, 1, 'the invalid entry is rejected');
  assert.equal(admission.admitted, 0, 'nothing was admitted');
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), true, 'the pair stays blocked');
});

test('D6 E5 — an older tick cannot advance or release a chunked recovery (D5)', () => {
  const manager = new CandleManager();
  const transport = new DeferredWindows();
  const results: RecoveryCycleResult[] = [];
  const coordinator = new RecoveryChunkCoordinator({
    manager,
    transport: {
      fetchHistoryWindow: (symbol, timeframe, count, end, callback) =>
        transport.fetch(symbol, timeframe, count, end, callback),
    },
    onCycleEnd: (result) => results.push(result),
  });

  // A wide gap: the pair observes the anchor period and resumes far ahead.
  manager.processTick(tick('V75', 1.1, ANCHOR + 30));
  manager.markDiscontinuity('V75');
  manager.processTick(tick('V75', 1.2, liveEpochOf(8000) + 30));

  const requirementBefore = manager.getRecoveryRequirement('V75', '1m')!;
  const planBefore = planRecoveryChunks(requirementBefore);
  assert.equal(planBefore.size, 'chunked', 'the gap needs a bounded chunk cycle');

  const start = coordinator.start('V75', '1m');
  assert.equal(start.kind, 'chunked', 'the chunk cycle started');
  assert.equal(results.length, 0, 'the cycle is still waiting for its first window');

  // A delayed tick arrives while the chunk cycle is running.
  manager.processTick(tick('V75', 9.9, ANCHOR + 90));

  const requirementAfter = manager.getRecoveryRequirement('V75', '1m')!;
  assert.equal(
    requirementAfter.liveEpoch,
    requirementBefore.liveEpoch,
    'the live edge of the chunk plan did not move'
  );
  assert.equal(
    requirementAfter.requiredCount,
    requirementBefore.requiredCount,
    'the chunk plan did not change'
  );
  assert.equal(planRecoveryChunks(requirementAfter).requiredCount, planBefore.requiredCount);
  assert.equal(manager.isRecoveryRequired('V75', '1m'), true, 'the pair is still blocked');
  assert.equal(results.length, 0, 'the cycle was not released by the delayed tick');

  // The bounded chain still bridges the gap afterwards.
  transport.flushAll();
  assert.equal(results.length, 1, 'exactly one cycle ended');
  assert.equal(results[0].recoveryComplete, true, 'the chunk cycle bridged the gap');
  assert.equal(manager.isRecoveryRequired('V75', '1m'), false, 'the pair is whole again');
});

// =============================================================================================
// F — symbol and timeframe isolation
// =============================================================================================

test('D6 F1 — an out-of-order tick of one symbol cannot regress another pair', () => {
  const manager = new CandleManager();
  manager.processTick(tick('EURUSD', 1.1, 720));
  manager.processTick(tick('GBPUSD', 1.2, 700));

  manager.processTick(tick('EURUSD', 9.9, 660));

  assert.equal(manager.getState('EURUSD')!.lastTickTime, 720, 'the pair keeps its live edge');
  assert.equal(
    manager.getState('GBPUSD')!.lastTickTime,
    700,
    'the other symbol is untouched'
  );
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.epoch, 720);
  assert.equal(manager.getCurrentCandle('GBPUSD', '1m')?.epoch, 660);
});

test('D6 F2 — the live edge is per symbol, the requirement stays per pair', () => {
  const manager = new CandleManager();
  manager.processTick(tick('EURUSD', 1.1, 700));
  manager.markDiscontinuity('EURUSD');
  manager.processTick(tick('EURUSD', 1.2, 7000));

  const oneMinute = manager.getRecoveryRequirement('EURUSD', '1m')!;
  const oneHour = manager.getRecoveryRequirement('EURUSD', '1H')!;
  assert.equal(oneMinute.liveEpoch, 6960, 'the 1m live edge');
  assert.equal(oneHour.liveEpoch, 3600, 'the 1H live edge');
  assert.notEqual(
    oneMinute.requiredCount,
    oneHour.requiredCount,
    'every timeframe keeps its own requirement'
  );

  // An out-of-order tick regresses neither of them.
  manager.processTick(tick('EURUSD', 9.9, 400));

  assert.equal(manager.getRecoveryRequirement('EURUSD', '1m')!.liveEpoch, 6960);
  assert.equal(manager.getRecoveryRequirement('EURUSD', '1H')!.liveEpoch, 3600);
  assert.equal(manager.getState('EURUSD')!.lastTickTime, 7000, 'the live edge is unchanged');
});

// =============================================================================================
// G — ordinary candle behaviour
// =============================================================================================

test('D6 G1 — in-order ticks still form candles and close them once on the rollover', () => {
  const manager = new CandleManager();
  const closes: Candle[] = [];
  manager.onCandleClose((_symbol, _timeframe, closed) => closes.push(closed));

  manager.processTick(tick('EURUSD', 1.1, 100));
  manager.processTick(tick('EURUSD', 1.15, 110));
  manager.processTick(tick('EURUSD', 1.05, 115));

  const current = manager.getCurrentCandle('EURUSD', '1m')!;
  assert.equal(current.epoch, INTERRUPTED_PERIOD);
  assert.equal(current.open, 1.1);
  assert.equal(current.high, 1.15);
  assert.equal(current.low, 1.05);
  assert.equal(current.close, 1.05);
  assert.equal(current.volume, 3);
  assert.equal(current.isClosed, false);
  assert.equal(closes.length, 0, 'no close while the period is ongoing');

  manager.processTick(tick('EURUSD', 1.3, 120));

  assert.equal(closes.length, 1, 'exactly one close event on the rollover');
  assert.equal(closes[0].epoch, INTERRUPTED_PERIOD);
  assert.equal(manager.getHistory('EURUSD', '1m').length, 1, 'one trusted candle');
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.epoch, 120, 'the next candle forms');
});

// =============================================================================================
// The controlled market source (adapter level)
// =============================================================================================

/**
 * Minimal in-memory WebSocket double. The client resolves the constructor from
 * the global scope, so the test installs this class before calling `connect()`.
 */
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

function withFakeWebSocket(run: () => void): void {
  const original = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  try {
    run();
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = original;
  }
}

class FakeMarketSource implements MonitoringMarketSource {
  public readonly requests: Array<{
    symbolId: string;
    timeframe: Timeframe;
    count: number;
    callback: HistoryRequestCallback;
  }> = [];

  private status: ConnectionStatus = 'DISCONNECTED';
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private readonly tickListeners = new Set<(t: TickData) => void>();
  private readonly feedListeners = new Set<(s: FeedStatus) => void>();

  connect(): void {
    this.setStatus('CONNECTED');
  }

  disconnect(): void {
    this.setStatus('DISCONNECTED');
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getFeedStatus(): FeedStatus | undefined {
    return undefined;
  }

  getLastTickEpoch(): number | undefined {
    return undefined;
  }

  subscribeTicks(): void {
    // No subscription bookkeeping is needed by these tests.
  }

  fetchCandlesHistory(
    symbolId: string,
    timeframe: Timeframe,
    count: number,
    callback: HistoryRequestCallback
  ): void {
    this.requests.push({ symbolId, timeframe, count, callback });
  }

  onStatusChange(listener: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onTick(listener: (t: TickData) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  onFeedStatus(listener: (s: FeedStatus) => void): () => void {
    this.feedListeners.add(listener);
    return () => this.feedListeners.delete(listener);
  }

  // --- test controls ---

  setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  emitTick(t: TickData): void {
    for (const listener of this.tickListeners) listener(t);
  }

  completeHistory(
    symbolId: string,
    timeframe: Timeframe,
    candles: HistoryCandleData[],
    outcome: HistoryRequestOutcome
  ): void {
    const idx = this.requests.findIndex(
      (r) => r.symbolId === symbolId && r.timeframe === timeframe
    );
    if (idx < 0) throw new Error(`no pending history request for ${symbolId}:${timeframe}`);
    const [req] = this.requests.splice(idx, 1);
    req.callback(symbolId, timeframe, candles, outcome);
  }
}

function collect(adapter: LiveAcquisitionAdapter): MonitoringObservation[] {
  const out: MonitoringObservation[] = [];
  adapter.onObservation((o) => out.push(o));
  return out;
}

function ofType<T extends MonitoringObservation['type']>(
  obs: MonitoringObservation[],
  type: T
): Array<Extract<MonitoringObservation, { type: T }>> {
  return obs.filter((o): o is Extract<MonitoringObservation, { type: T }> => o.type === type);
}

// =============================================================================================
// The deferred window transport (chunked recovery)
// =============================================================================================

/**
 * A transport that records the requested windows and answers them only when the
 * test asks for it, so a running chunk cycle can be observed while it is
 * waiting for its first window.
 */
class DeferredWindows {
  public readonly windows: Array<{ count: number; end: number | null }> = [];
  private readonly pending: Array<() => void> = [];

  constructor(private readonly liveEpoch: number = liveEpochOf(8000)) {}

  public fetch(
    _symbol: string,
    _timeframe: Timeframe,
    count: number,
    end: number | null,
    callback: (candles: HistoryCandleData[], outcome: HistoryRequestOutcome) => void
  ): void {
    this.windows.push({ count, end });
    this.pending.push(() => callback(this.window(count, end), 'success'));
  }

  /** The candles of a window: the newest `count` periods, ending at `end`. */
  private window(count: number, end: number | null): HistoryCandleData[] {
    // The delivered periods sit on the timeframe grid, exactly like the
    // provider's candles do.
    const newest =
      end === null ? Math.floor(this.liveEpoch / PERIOD) * PERIOD : end;
    const candles: HistoryCandleData[] = [];
    for (let i = 0; i < count; i++) {
      const epoch = newest - i * PERIOD;
      if (epoch < ANCHOR) break;
      candles.push(candle(epoch));
    }
    return candles;
  }

  /** Deliver every outstanding window (a delivered window may queue the next). */
  public flushAll(): void {
    let guard = 0;
    while (this.pending.length > 0 && guard < 10) {
      const deliver = this.pending.shift()!;
      deliver();
      guard += 1;
    }
  }
}
