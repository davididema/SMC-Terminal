/**
 * Phase 3A — D2: the bounded history-recovery budget.
 *
 * The confirmed defect: the dashboard reported a history response that carried
 * candles as a SUCCESSFUL recovery even when the response did not bridge the
 * pair's open gap. A success resets the pair's retry budget, so every
 * incomplete response restarted the budget from zero and the pair was
 * re-requested without end (the attempt counter never grew past one, while the
 * requested window kept widening towards the provider maximum).
 *
 * These tests use synthetic epochs and an in-memory stand-in for the
 * dashboard's request path. No socket, no network, and no fabricated market
 * data: the candles are deterministic fixtures whose only purpose is to
 * describe periods.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Candle, CandleManager, Timeframe, TickData } from '../lib/deriv/candles';
import {
  HistoryRecoveryController,
  applyHistoryResponse,
  resolveHistoryRecoveryOutcome,
  type HistoryResponseApplication,
} from '../lib/deriv/history-recovery';
import type {
  HistoryCandleData,
  HistoryRequestOutcome,
} from '../lib/deriv/history-requests';
import {
  LiveAcquisitionAdapter,
  MonitoringMarketSource,
  MonitoringObservation,
} from '../lib/monitoring/live-acquisition';
import { MonitoringCore } from '../lib/monitoring/headless-core';
import type { ConnectionStatus } from '../lib/deriv/websocket';
import type { FeedStatus } from '../lib/deriv/feed';

// --- The scenario -------------------------------------------------------------
// A tick at epoch 100 belongs to the 1m period starting at epoch 60. The
// connection then drops; the first tick after the reconnect is at epoch 400 and
// belongs to the 1m period starting at epoch 360.
const INTERRUPTED_PERIOD = 60;
const LIVE_PERIOD = 360;

function tick(symbol: string, price: number, epoch: number): TickData {
  return { symbol, derivSymbol: symbol, price, epoch };
}

/** A deterministic historical candle for a 1m period. */
function candle(epoch: number, close = 1.1): HistoryCandleData {
  return { epoch, open: close, high: close, low: close, close };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// =============================================================================================
// A deterministic stand-in for the dashboard's history request path
// =============================================================================================

/**
 * Answers every history request with a canned response and re-issues the
 * request whenever the bounded recovery controller schedules a retry. The
 * request size follows the same rule the dashboard uses, so the window a
 * recovery asks for can be observed.
 */
class RecoveryHarness {
  public readonly manager: CandleManager;
  public readonly controller: HistoryRecoveryController;

  /** One entry per delivered response, in delivery order. */
  public readonly responses: HistoryResponseApplication[] = [];
  /** The number of retries the controller issued. */
  public requestCount = 0;
  /** The number of candles each retry asked for. */
  public readonly requestCounts: number[] = [];

  private responseFactory: () => HistoryCandleData[];
  private readonly requestOutcome: HistoryRequestOutcome | undefined;
  private readonly fallbackCount: number;

  constructor(options: {
    responseFactory: () => HistoryCandleData[];
    requestOutcome?: HistoryRequestOutcome;
    maxAttempts?: number;
    delayMs?: number;
    canRetry?: (symbol: string, timeframe: Timeframe) => boolean;
    manager?: CandleManager;
    fallbackCount?: number;
  }) {
    this.manager = options.manager ?? new CandleManager();
    this.responseFactory = options.responseFactory;
    this.requestOutcome = options.requestOutcome;
    this.fallbackCount = options.fallbackCount ?? 100;
    this.controller = new HistoryRecoveryController({
      policy: {
        maxAttempts: options.maxAttempts ?? 3,
        delayMs: options.delayMs ?? 5,
      },
      canRetry: options.canRetry ?? (() => true),
      onRetry: (symbol, timeframe) => {
        // The scheduled retry re-issues the very same request, asking for the
        // wider window the pair needs.
        this.requestCount += 1;
        this.requestCounts.push(
          this.manager.getRecoveryHistoryCount(symbol, timeframe, this.fallbackCount)
        );
        this.deliver(symbol, timeframe);
      },
    });
  }

  /** Replace the response the next request is answered with. */
  public setResponse(responseFactory: () => HistoryCandleData[]): void {
    this.responseFactory = responseFactory;
  }

  /** Deliver a response for the pair and apply it. */
  public deliver(symbol: string, timeframe: Timeframe): HistoryResponseApplication {
    const applied = applyHistoryResponse({
      manager: this.manager,
      controller: this.controller,
      symbol,
      timeframe,
      candles: this.responseFactory(),
      requestOutcome: this.requestOutcome,
    });
    this.responses.push(applied);
    return applied;
  }
}

/** A pair with an open gap: a tick forms the 1m candle of period 60, then the
 *  connection drops. */
function interruptPair(manager: CandleManager, symbol = 'EURUSD'): void {
  manager.processTick(tick(symbol, 1.1, 100));
  manager.markDiscontinuity(symbol);
}

// =============================================================================================
// The retry budget is bounded
// =============================================================================================

test('D2 A1 — an incomplete recovery consumes the budget instead of resetting it', async () => {
  const harness = new RecoveryHarness({
    // The response carries candles but never re-derives the interrupted period.
    responseFactory: () => [candle(240), candle(300)],
    requestOutcome: 'success',
  });
  interruptPair(harness.manager);

  const first = harness.deliver('EURUSD', '1m');
  assert.equal(first.outcome, 'failure', 'an incomplete recovery is never a success');
  assert.equal(first.recoveryIncomplete, true, 'the gap was not bridged');
  assert.equal(first.recoveryPending, true, 'the pair stays blocked');
  assert.equal(first.retriesExhausted, false, 'the budget still has room');
  assert.equal(
    harness.controller.attemptsFor('EURUSD', '1m'),
    1,
    'the attempt is consumed, not discarded by a reset'
  );

  // The scheduled retries re-request the history and fail again.
  await delay(80);

  assert.ok(harness.responses.length >= 2, 'the incomplete recovery is retried');
  assert.equal(
    harness.responses.every((r) => r.outcome === 'failure'),
    true,
    'no incomplete recovery is ever reported as a success'
  );
  assert.equal(
    harness.controller.attemptsFor('EURUSD', '1m'),
    3,
    'the attempt counter grows to the limit instead of staying at one'
  );
  assert.equal(harness.controller.isScheduled('EURUSD', '1m'), false, 'no retry is left pending');
  assert.equal(harness.responses.length, 4, 'the request chain is bounded (1 + maxAttempts)');
  assert.equal(harness.requestCount, 3, 'exactly maxAttempts retries were issued');
  assert.equal(
    harness.manager.isRecoveryRequired('EURUSD', '1m'),
    true,
    'the pair stays blocked while the gap is open'
  );
  assert.equal(
    harness.responses[harness.responses.length - 1].retriesExhausted,
    true,
    'the spent budget is reported'
  );

  // The chain really stopped: no further response arrives.
  await delay(80);
  assert.equal(harness.responses.length, 4, 'no further retry is scheduled once the budget is spent');
  assert.equal(harness.requestCount, 3, 'no further request is issued');
});

test('D2 A2 — the recovery window widens only within the bounded budget', async () => {
  const harness = new RecoveryHarness({
    responseFactory: () => [candle(240), candle(300)],
    requestOutcome: 'success',
  });
  interruptPair(harness.manager);

  harness.deliver('EURUSD', '1m');
  await delay(80);

  assert.deepEqual(
    harness.requestCounts,
    [200, 400, 800],
    'each retry asks for a wider window'
  );
  assert.ok(
    Math.max(...harness.requestCounts) < 5000,
    'the request never widens without bound towards the provider maximum'
  );
});

test('D2 A3 — an empty response is retryable and never releases the pair', async () => {
  const harness = new RecoveryHarness({
    responseFactory: () => [],
    requestOutcome: 'empty',
  });
  interruptPair(harness.manager);

  const applied = harness.deliver('EURUSD', '1m');
  assert.equal(applied.outcome, 'empty', 'an empty response keeps its own outcome');
  assert.equal(applied.recoveryPending, true, 'the pair stays blocked');
  assert.equal(harness.controller.attemptsFor('EURUSD', '1m'), 1, 'the attempt is consumed');
  await delay(80);
  assert.equal(harness.controller.attemptsFor('EURUSD', '1m'), 3, 'the budget is bounded');
  assert.equal(harness.manager.isRecoveryRequired('EURUSD', '1m'), true);
});

test('D2 A4 — a dropped connection is never retried here', () => {
  const harness = new RecoveryHarness({
    responseFactory: () => [],
    requestOutcome: 'abandoned',
  });
  interruptPair(harness.manager);

  const applied = harness.deliver('EURUSD', '1m');
  assert.equal(applied.outcome, 'abandoned');
  assert.equal(harness.controller.attemptsFor('EURUSD', '1m'), 0, 'no attempt is consumed');
  assert.equal(harness.controller.isScheduled('EURUSD', '1m'), false, 'no retry is scheduled');
});

// =============================================================================================
// A genuine success restores the budget
// =============================================================================================

test('D2 B1 — a response that bridges the gap is a success and restores the budget', async () => {
  const harness = new RecoveryHarness({
    responseFactory: () => [candle(240), candle(300)],
    requestOutcome: 'success',
  });
  interruptPair(harness.manager);

  harness.deliver('EURUSD', '1m');
  await delay(80);
  assert.equal(
    harness.controller.attemptsFor('EURUSD', '1m'),
    3,
    'the budget is spent by the incomplete responses'
  );
  assert.equal(harness.controller.hasAttemptsLeft('EURUSD', '1m'), false);

  // A response that re-derives the interrupted period bridges the gap.
  harness.setResponse(() => [candle(INTERRUPTED_PERIOD)]);
  const applied = harness.deliver('EURUSD', '1m');
  assert.equal(applied.outcome, 'success', 'a covered recovery is a success');
  assert.equal(applied.recoveryComplete, true);
  assert.equal(applied.recoveryPending, false);
  assert.equal(applied.recoveryIncomplete, false);
  assert.equal(harness.manager.isRecoveryRequired('EURUSD', '1m'), false, 'the pair is whole again');
  assert.equal(harness.controller.attemptsFor('EURUSD', '1m'), 0, 'the budget is restored');
  assert.equal(harness.controller.hasAttemptsLeft('EURUSD', '1m'), true);
});

test('D2 B2 — a later gap gets a fresh allowance', async () => {
  const harness = new RecoveryHarness({
    responseFactory: () => [candle(240), candle(300)],
    requestOutcome: 'success',
  });
  interruptPair(harness.manager);

  harness.deliver('EURUSD', '1m');
  await delay(80);
  assert.equal(harness.controller.attemptsFor('EURUSD', '1m'), 3);

  // The gap is bridged, the budget is restored ...
  harness.setResponse(() => [candle(INTERRUPTED_PERIOD)]);
  harness.deliver('EURUSD', '1m');
  assert.equal(harness.controller.attemptsFor('EURUSD', '1m'), 0);

  // ... and the next gap is retried with a full allowance again.
  harness.manager.markDiscontinuity('EURUSD');
  harness.setResponse(() => [candle(240), candle(300)]);
  const applied = harness.deliver('EURUSD', '1m');
  assert.equal(applied.outcome, 'failure');
  assert.equal(
    harness.controller.attemptsFor('EURUSD', '1m'),
    1,
    'the restored budget is spent again from the start'
  );
});

// =============================================================================================
// The budget is isolated per pair
// =============================================================================================

test('D2 C1 — the retry budget is isolated per pair', async () => {
  const harness = new RecoveryHarness({
    responseFactory: () => [candle(240), candle(300)],
    requestOutcome: 'success',
  });
  interruptPair(harness.manager, 'EURUSD');
  interruptPair(harness.manager, 'GBPUSD');

  harness.deliver('EURUSD', '1m');
  harness.deliver('GBPUSD', '1m');
  await delay(80);

  assert.equal(harness.controller.attemptsFor('EURUSD', '1m'), 3);
  assert.equal(harness.controller.attemptsFor('GBPUSD', '1m'), 3);

  // A success on one pair leaves the other pair's budget untouched.
  harness.setResponse(() => [candle(INTERRUPTED_PERIOD)]);
  harness.deliver('EURUSD', '1m');
  assert.equal(harness.controller.attemptsFor('EURUSD', '1m'), 0, 'the covered pair is restored');
  assert.equal(
    harness.controller.attemptsFor('GBPUSD', '1m'),
    3,
    'the other pair keeps its own budget'
  );
  assert.equal(harness.manager.isRecoveryRequired('GBPUSD', '1m'), true, 'and stays blocked');
});

// =============================================================================================
// The D1 guarantee survives the bounded retry
// =============================================================================================

test('D2 D1 — the exhausted budget never releases a pair whose gap is still open', async () => {
  const closes: Candle[] = [];
  const manager = new CandleManager();
  manager.onCandleClose((_symbol, _timeframe, closed) => closes.push(closed));

  manager.processTick(tick('EURUSD', 1.1, 100));
  manager.markDiscontinuity('EURUSD');
  // The first tick after the reconnect drops the interrupted candle.
  manager.processTick(tick('EURUSD', 1.2, 400));
  assert.equal(closes.length, 0, 'the interrupted candle is never closed');

  const harness = new RecoveryHarness({
    manager,
    responseFactory: () => [candle(240), candle(300)],
    requestOutcome: 'success',
  });

  harness.deliver('EURUSD', '1m');
  await delay(80);

  assert.equal(harness.controller.attemptsFor('EURUSD', '1m'), 3, 'the budget is spent');
  assert.equal(
    manager.isRecoveryRequired('EURUSD', '1m'),
    true,
    'the recovery requirement survives the exhausted budget'
  );
  assert.equal(
    manager.getRecoveryRequirement('EURUSD', '1m')?.interruptedEpoch,
    INTERRUPTED_PERIOD,
    'the interrupted candle is still named'
  );
  assert.equal(
    manager.getHistory('EURUSD', '1m').some((c) => c.epoch === INTERRUPTED_PERIOD),
    false,
    'the interrupted candle never enters the trusted closed history'
  );
  assert.equal(closes.length, 0, 'no close is emitted for the interrupted candle');
});

// --- The adapter refuses to evaluate a pair whose gap is still open ----------

/** A market source that is only constructed, never driven. */
class MinimalSource implements MonitoringMarketSource {
  public getStatus(): ConnectionStatus {
    return 'CONNECTED';
  }
  public getFeedStatus(): FeedStatus | undefined {
    return undefined;
  }
  public getLastTickEpoch(): number | undefined {
    return undefined;
  }
  public connect(): void {
    // Not used by these tests.
  }
  public disconnect(): void {
    // Not used by these tests.
  }
  public subscribeTicks(): void {
    // Not used by these tests.
  }
  public fetchCandlesHistory(): void {
    // Not used by these tests.
  }
  public onStatusChange(): () => void {
    return () => {};
  }
  public onTick(): () => void {
    return () => {};
  }
  public onFeedStatus(): () => void {
    return () => {};
  }
}

function collect(adapter: LiveAcquisitionAdapter): MonitoringObservation[] {
  const out: MonitoringObservation[] = [];
  adapter.onObservation((o) => out.push(o));
  return out;
}

test('D2 D2 — a pair with an open gap is never evaluated', () => {
  const manager = new CandleManager();
  manager.processTick(tick('EURUSD', 1.1, 100));
  manager.markDiscontinuity('EURUSD');

  const core = new MonitoringCore({ candleManager: manager });
  const adapter = new LiveAcquisitionAdapter(new MinimalSource(), core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  const obs = collect(adapter);

  const report = adapter.handleClosedCandle('EURUSD', '1m', {
    epoch: LIVE_PERIOD,
    open: 1.1,
    high: 1.1,
    low: 1.1,
    close: 1.1,
    volume: 1,
    isClosed: true,
  });

  assert.equal(report, null, 'the evaluation is refused');
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 0, 'nothing is evaluated');
  assert.equal(
    obs.filter((o) => o.type === 'evaluation').length,
    0,
    'no evaluation is emitted'
  );
  assert.ok(
    obs.some((o) => o.type === 'error' && o.stage === 'recovery'),
    'the refused evaluation is reported'
  );
  assert.equal(core.session.size(), 0, 'no notification state is created');
});

// =============================================================================================
// The outcome resolution itself
// =============================================================================================

test('D2 E1 — the outcome resolution separates the transport result from the recovery state', () => {
  assert.equal(
    resolveHistoryRecoveryOutcome({
      requestOutcome: 'success',
      candleCount: 10,
      recoveryPending: true,
      recoveryComplete: false,
    }),
    'failure',
    'a response that does not bridge the gap is never a success'
  );
  assert.equal(
    resolveHistoryRecoveryOutcome({
      requestOutcome: 'abandoned',
      candleCount: 0,
      recoveryPending: true,
      recoveryComplete: false,
    }),
    'abandoned',
    'a dropped connection is recovered by the reconnect path'
  );
  assert.equal(
    resolveHistoryRecoveryOutcome({
      requestOutcome: 'success',
      candleCount: 10,
      recoveryPending: true,
      recoveryComplete: true,
    }),
    'success',
    'a covered recovery resets the budget'
  );
  assert.equal(
    resolveHistoryRecoveryOutcome({
      requestOutcome: 'success',
      candleCount: 10,
      recoveryPending: false,
      recoveryComplete: true,
    }),
    'success',
    'an ordinary backfill keeps the transport outcome'
  );
  assert.equal(
    resolveHistoryRecoveryOutcome({
      requestOutcome: 'empty',
      candleCount: 0,
      recoveryPending: false,
      recoveryComplete: true,
    }),
    'empty'
  );
  assert.equal(
    resolveHistoryRecoveryOutcome({
      requestOutcome: 'empty',
      candleCount: 0,
      recoveryPending: true,
      recoveryComplete: false,
    }),
    'empty',
    'an empty response keeps its own (retryable) meaning'
  );
  assert.equal(
    resolveHistoryRecoveryOutcome({ candleCount: 3, recoveryPending: false, recoveryComplete: true }),
    'success',
    'a legacy caller without an outcome falls back to the candle count'
  );
  assert.equal(
    resolveHistoryRecoveryOutcome({ candleCount: 0, recoveryPending: false, recoveryComplete: true }),
    'failure'
  );
});
