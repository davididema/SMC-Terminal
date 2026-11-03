/**
 * Phase 3A — D3: a recovery must be COMPLETE, not merely anchored.
 *
 * The confirmed defect: the recovery coverage check only asked whether the
 * response re-derived the oldest gap anchor, the currently interrupted candle
 * and the live edge of the pair. A response that skipped periods in the
 * MIDDLE of the gap (for example [60, 120, 240, 300] instead of
 * [60, 120, 180, 240, 300]) was accepted as a complete recovery: the pair was
 * released, the hole in its history became invisible, and every analysis that
 * followed ran on a history with a known gap.
 *
 * These tests use synthetic epochs and an in-memory stand-in for the
 * dashboard's request path. No socket, no network, and no fabricated market
 * data: the candles are deterministic fixtures whose only purpose is to
 * describe periods.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Candle,
  CandleManager,
  Timeframe,
  TickData,
  findMissingRequiredPeriods,
  isRecoveryCovered,
  type RecoveryRequirement,
} from '../lib/deriv/candles';
import {
  HistoryRecoveryController,
  applyHistoryResponse,
  type HistoryResponseApplication,
} from '../lib/deriv/history-recovery';
import type {
  HistoryCandleData,
  HistoryRequestOutcome,
} from '../lib/deriv/history-requests';

// --- The scenario -------------------------------------------------------------
// A tick at epoch 100 belongs to the 1m period starting at epoch 60. The
// connection then drops; the first tick after the reconnect is at epoch 400 and
// belongs to the 1m period starting at epoch 360. The required periods are
// therefore 60, 120, 180, 240 and 300 (the live edge 360 is observed live).
const INTERRUPTED_PERIOD = 60;
const LIVE_PERIOD = 360;
const PERIOD = 60;

function tick(symbol: string, price: number, epoch: number): TickData {
  return { symbol, derivSymbol: symbol, price, epoch };
}

/** A deterministic historical candle for a 1m period. */
function candle(epoch: number, close = 1.1): HistoryCandleData {
  return { epoch, open: close, high: close, low: close, close };
}

function recoveryCandles(epochs: readonly number[]): HistoryCandleData[] {
  return epochs.map((epoch) => candle(epoch));
}

/** The requirement of the scenario above, without a category (fail safe). */
function requirement(overrides: Partial<RecoveryRequirement> = {}): RecoveryRequirement {
  return {
    recoveryEpoch: INTERRUPTED_PERIOD,
    interruptedEpoch: null,
    liveEpoch: LIVE_PERIOD,
    periodSeconds: PERIOD,
    requiredCount: 6,
    ...overrides,
  };
}

/** A pair with an open gap, whose live edge has already moved forward. */
function interruptPair(manager: CandleManager, symbol = 'EURUSD'): void {
  manager.processTick(tick(symbol, 1.1, 100));
  manager.markDiscontinuity(symbol);
  manager.processTick(tick(symbol, 1.2, 400));
}

// --- The weekend fixture ------------------------------------------------------
// 2024-01-05 19:00 UTC (Friday) ... 2024-01-07 22:00 UTC (Sunday).
const FRIDAY_19_UTC = 1704481200;
const SUNDAY_21_UTC = 1704661200;
const SUNDAY_22_UTC = 1704664800;

/** The requirement of a Forex pair that was disconnected over the weekend. */
function weekendRequirement(
  overrides: Partial<RecoveryRequirement> = {}
): RecoveryRequirement {
  return {
    recoveryEpoch: FRIDAY_19_UTC,
    interruptedEpoch: FRIDAY_19_UTC,
    liveEpoch: SUNDAY_22_UTC,
    periodSeconds: 3600,
    requiredCount: 52,
    category: 'Forex',
    ...overrides,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCondition(
  description: string,
  condition: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await delay(1);
  }
}

// =============================================================================================
// A missing interior period is a genuine gap
// =============================================================================================

test('D3 A1 — a response that skips an interior period does not cover the gap', () => {
  const req = requirement();

  assert.deepEqual(
    findMissingRequiredPeriods(req, [60, 120, 180, 240, 300]),
    [],
    'a complete sequence has no missing period'
  );
  assert.deepEqual(
    findMissingRequiredPeriods(req, [60, 120, 240, 300]),
    [180],
    'the skipped period is reported'
  );
  assert.equal(
    isRecoveryCovered(req, [60, 120, 240, 300]),
    false,
    'a history with a hole in the middle is not a recovered history'
  );
  assert.equal(
    isRecoveryCovered(req, [60, 120, 240, 300, 360]),
    false,
    'reaching the live edge does not excuse the skipped period'
  );
  assert.equal(
    isRecoveryCovered(req, [60, 120, 180, 240, 300]),
    true,
    'the complete sequence still covers the gap'
  );
});

test('D3 A2 — the manager refuses an incomplete recovery and keeps the pair blocked', () => {
  const manager = new CandleManager();
  interruptPair(manager);

  const recovered = manager.recoverFromHistory(
    'EURUSD',
    '1m',
    recoveryCandles([60, 120, 240, 300])
  );
  assert.equal(recovered, false, 'the recovery is refused');
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), true, 'the pair stays blocked');
  assert.equal(
    manager.getRecoveryRequirement('EURUSD', '1m')?.recoveryEpoch,
    INTERRUPTED_PERIOD,
    'the gap anchor survives'
  );
  assert.equal(
    manager.getTimeframeState('EURUSD', '1m')?.interruptedEpoch,
    INTERRUPTED_PERIOD,
    'the interrupted candle is still named'
  );
  const history = manager.getHistory('EURUSD', '1m');
  assert.equal(history.some((c) => c.epoch === 180), false, 'the missing period is not admitted');
  assert.equal(
    history.some((c) => c.epoch === INTERRUPTED_PERIOD),
    false,
    'the interrupted candle is not admitted either'
  );
  assert.equal(
    manager.getRecoveryHistoryCount('EURUSD', '1m', 100),
    200,
    'the next attempt asks for a wider window'
  );
});

// =============================================================================================
// Several missing periods are refused as well
// =============================================================================================

test('D3 B — several missing interior periods are refused', () => {
  const req = requirement();

  assert.deepEqual(
    findMissingRequiredPeriods(req, [60, 180, 300, 360]),
    [120, 240],
    'every skipped period is reported'
  );
  assert.equal(
    isRecoveryCovered(req, [60, 180, 300, 360]),
    false,
    'a response that skips several periods does not cover the gap'
  );
  assert.equal(
    isRecoveryCovered(req, [60, 120, 180, 240, 300, 360]),
    true,
    'the complete sequence covers the gap'
  );
});

// =============================================================================================
// A complete sequence bridges the gap
// =============================================================================================

test('D3 C — a complete sequence bridges the gap and releases the pair', () => {
  const manager = new CandleManager();
  interruptPair(manager);

  const recovered = manager.recoverFromHistory(
    'EURUSD',
    '1m',
    recoveryCandles([60, 120, 180, 240, 300, 360])
  );
  assert.equal(recovered, true, 'the recovery succeeds');
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), false, 'the pair is whole again');
  assert.equal(
    manager.getTimeframeState('EURUSD', '1m')?.interruptedEpoch,
    null,
    'the interrupted candle is no longer marked'
  );

  const history = manager.getHistory('EURUSD', '1m');
  assert.deepEqual(history.map((c) => c.epoch), [60, 120, 180, 240, 300]);
  assert.equal(history.every((c) => c.isClosed), true, 'every recovered period is a closed candle');
});

// =============================================================================================
// Ordering and duplicates
// =============================================================================================

test('D3 D1 — the order of the recovered periods does not matter', () => {
  const req = requirement();
  assert.equal(
    isRecoveryCovered(req, [300, 240, 180, 120, 60]),
    true,
    'an out-of-order complete response covers the gap'
  );
});

test('D3 D2 — a duplicate is harmless, but it cannot hide a missing period', () => {
  const req = requirement();
  assert.equal(
    isRecoveryCovered(req, [60, 120, 180, 180, 240, 300]),
    true,
    'a duplicated period does not break a complete response'
  );
  assert.deepEqual(
    findMissingRequiredPeriods(req, [60, 120, 120, 240, 300]),
    [180],
    'a duplicate cannot stand in for a missing period'
  );
  assert.equal(
    isRecoveryCovered(req, [60, 120, 120, 240, 300]),
    false,
    'a duplicated response that still skips a period does not cover the gap'
  );
});

// =============================================================================================
// A legitimate closure is not a missing period
// =============================================================================================

test('D3 E1 — the hours in which the market was closed are not missing periods', () => {
  const req = weekendRequirement();

  assert.deepEqual(
    findMissingRequiredPeriods(req, [FRIDAY_19_UTC, SUNDAY_21_UTC]),
    [],
    'the weekend closure is not a gap'
  );
  assert.equal(
    isRecoveryCovered(req, [FRIDAY_19_UTC, SUNDAY_21_UTC]),
    true,
    'a Forex pair recovers across a weekend closure'
  );
});

test('D3 E2 — the same weekend gap is a defect for an instrument that trades 24/7', () => {
  const req = weekendRequirement({ category: 'Synthetics' });

  assert.ok(
    findMissingRequiredPeriods(req, [FRIDAY_19_UTC, SUNDAY_21_UTC]).length > 0,
    'a continuous market never closes for the weekend'
  );
  assert.equal(
    isRecoveryCovered(req, [FRIDAY_19_UTC, SUNDAY_21_UTC]),
    false,
    'the weekend gap is refused for a synthetic index'
  );
});

test('D3 E3 — an unknown category excuses nothing', () => {
  const req = weekendRequirement({ category: undefined });
  assert.ok(
    findMissingRequiredPeriods(req, [FRIDAY_19_UTC, SUNDAY_21_UTC]).length > 0,
    'without a documented closure model every missing period is a defect'
  );
  assert.equal(
    isRecoveryCovered(req, [FRIDAY_19_UTC, SUNDAY_21_UTC]),
    false,
    'the unknown category fails safe'
  );
});

test('D3 E4 — the pair category comes from the symbol configuration', () => {
  const manager = new CandleManager();
  for (const symbol of ['EURUSD', 'XAUUSD', 'V75', 'UNKNOWN']) {
    manager.processTick(tick(symbol, 1.1, 100));
  }
  manager.markDiscontinuity('EURUSD');
  manager.markDiscontinuity('XAUUSD');
  manager.markDiscontinuity('V75');
  manager.markDiscontinuity('UNKNOWN');

  assert.equal(manager.getRecoveryRequirement('EURUSD', '1m')?.category, 'Forex');
  assert.equal(manager.getRecoveryRequirement('XAUUSD', '1m')?.category, 'Metals');
  assert.equal(manager.getRecoveryRequirement('V75', '1m')?.category, 'Synthetics');
  assert.equal(
    manager.getRecoveryRequirement('UNKNOWN', '1m')?.category,
    undefined,
    'an unknown symbol has no documented closure'
  );
});

test('D3 E5 — a weekend gap is recovered end to end for a Forex pair', () => {
  const manager = new CandleManager();
  manager.processTick(tick('EURUSD', 1.1, FRIDAY_19_UTC + 60));
  manager.markDiscontinuity('EURUSD');
  manager.processTick(tick('EURUSD', 1.2, SUNDAY_22_UTC + 60));

  const recovered = manager.recoverFromHistory(
    'EURUSD',
    '1H',
    recoveryCandles([FRIDAY_19_UTC, SUNDAY_21_UTC])
  );
  assert.equal(recovered, true, 'the closed hours do not block the recovery');
  assert.equal(manager.isRecoveryRequired('EURUSD', '1H'), false, 'the pair is whole again');
  assert.deepEqual(
    manager.getHistory('EURUSD', '1H').map((c) => c.epoch),
    [FRIDAY_19_UTC, SUNDAY_21_UTC],
    'the recovered periods are the closed history'
  );
});

// =============================================================================================
// The D1 and D2 guarantees survive the completeness check
// =============================================================================================

test('D3 F1 — the interrupted candle is still never closed while the gap is open', () => {
  const closes: Candle[] = [];
  const manager = new CandleManager();
  manager.onCandleClose((_symbol, _timeframe, closed) => closes.push(closed));

  interruptPair(manager);
  assert.equal(closes.length, 0, 'the interrupted candle is never closed');

  const refused = manager.recoverFromHistory(
    'EURUSD',
    '1m',
    recoveryCandles([60, 120, 240, 300])
  );
  assert.equal(refused, false, 'the incomplete recovery is refused');
  assert.equal(
    manager.getTimeframeState('EURUSD', '1m')?.interruptedEpoch,
    INTERRUPTED_PERIOD,
    'the interrupted candle is still marked'
  );
  assert.equal(
    manager.getHistory('EURUSD', '1m').some((c) => c.epoch === INTERRUPTED_PERIOD),
    false,
    'the interrupted candle never enters the trusted closed history'
  );

  manager.processTick(tick('EURUSD', 1.25, 700));
  assert.equal(
    closes.some((c) => c.epoch === INTERRUPTED_PERIOD),
    false,
    'the interrupted candle is never closed'
  );
  assert.equal(
    manager.getHistory('EURUSD', '1m').some((c) => c.epoch === INTERRUPTED_PERIOD),
    false,
    'the interrupted candle is not pushed into the closed history'
  );
});

/** A compact stand-in for the dashboard's history request path. */
class RecoveryHarness {
  public readonly manager: CandleManager;
  public readonly controller: HistoryRecoveryController;
  public readonly responses: HistoryResponseApplication[] = [];
  public requestCount = 0;

  private responseFactory: () => HistoryCandleData[];
  private readonly requestOutcome: HistoryRequestOutcome | undefined;

  constructor(options: {
    responseFactory: () => HistoryCandleData[];
    requestOutcome?: HistoryRequestOutcome;
    maxAttempts?: number;
    delayMs?: number;
  }) {
    this.manager = new CandleManager();
    this.responseFactory = options.responseFactory;
    this.requestOutcome = options.requestOutcome;
    this.controller = new HistoryRecoveryController({
      policy: {
        maxAttempts: options.maxAttempts ?? 3,
        delayMs: options.delayMs ?? 5,
      },
      canRetry: () => true,
      onRetry: (symbol, timeframe) => {
        this.requestCount += 1;
        this.deliver(symbol, timeframe);
      },
    });
  }

  public setResponse(responseFactory: () => HistoryCandleData[]): void {
    this.responseFactory = responseFactory;
  }

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

test('D3 F2 — an incomplete recovery consumes the bounded budget and keeps the pair blocked', async () => {
  const harness = new RecoveryHarness({
    // The response carries candles but skips a period inside the gap.
    responseFactory: () => recoveryCandles([60, 120, 240, 300]),
    requestOutcome: 'success',
  });
  interruptPair(harness.manager);

  const first = harness.deliver('EURUSD', '1m');
  assert.equal(first.outcome, 'failure', 'an incomplete recovery is never a success');
  assert.equal(first.recoveryIncomplete, true, 'the gap was not bridged');
  assert.equal(first.recoveryPending, true, 'the pair stays blocked');

  await waitForCondition(
    'the bounded recovery retry chain to settle',
    () => !harness.controller.isScheduled('EURUSD', '1m')
  );
  assert.equal(
    harness.controller.attemptsFor('EURUSD', '1m'),
    3,
    'the budget is spent instead of being reset'
  );
  assert.equal(harness.responses.length, 4, 'the request chain is bounded (1 + maxAttempts)');
  assert.equal(
    harness.responses.every((r) => r.outcome === 'failure'),
    true,
    'no incomplete recovery is ever reported as a success'
  );
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

  // A complete response bridges the gap and restores the budget.
  harness.setResponse(() => recoveryCandles([60, 120, 180, 240, 300, 360]));
  const covered = harness.deliver('EURUSD', '1m');
  assert.equal(covered.outcome, 'success', 'a covered recovery is a success');
  assert.equal(covered.recoveryComplete, true);
  assert.equal(covered.recoveryPending, false);
  assert.equal(harness.manager.isRecoveryRequired('EURUSD', '1m'), false, 'the pair is whole again');
  assert.equal(harness.controller.attemptsFor('EURUSD', '1m'), 0, 'the budget is restored');
});
