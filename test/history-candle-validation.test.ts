/**
 * Phase 3A — D4: an invalid history must never enter the trusted history.
 *
 * The confirmed defect: a delivered history response was merged into the
 * trusted candle history as it arrived. A garbled entry (a NaN price, a candle
 * whose high sits below its open, an epoch that does not describe a period of
 * the timeframe) was accepted, kept, and then used by the analysis as if it
 * were market data. Worse, such an entry could satisfy a recovery requirement:
 * an interrupted pair was released while its "recovered" history contained a
 * period that never existed.
 *
 * The rule of D4: a delivered entry is either VALID (it is admitted) or it is
 * REJECTED (it is dropped and reported). It is never repaired. Widening the
 * high or lowering the low of a broken candle would invent prices the provider
 * never sent, and an invented candle in the trusted history is exactly what
 * the analysis must never see.
 *
 * These tests use synthetic epochs and deterministic fixtures whose only
 * purpose is to describe periods. No socket, no network, and no fabricated
 * market data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Candle,
  CandleManager,
  Timeframe,
  TickData,
  MAX_HISTORY_REJECTIONS_REPORTED,
  describeHistoryRejections,
  findMissingRequiredPeriods,
  validateHistoryCandles,
  type HistoryCandleInput,
  type HistoryRejectionReason,
} from '../lib/deriv/candles';
import {
  HistoryRecoveryController,
  applyHistoryResponse,
  type HistoryResponseApplication,
} from '../lib/deriv/history-recovery';
import type { HistoryCandleData, HistoryRequestOutcome } from '../lib/deriv/history-requests';

// --- The scenario -------------------------------------------------------------
// A tick at epoch 100 belongs to the 1m period starting at epoch 60. The
// connection then drops; the first tick after the reconnect is at epoch 400
// and belongs to the 1m period starting at epoch 360. The required periods are
// therefore 60, 120, 180, 240 and 300 (the live edge 360 is observed live).
const SYMBOL = 'EURUSD';
const PERIOD = 60;
const INTERRUPTED_PERIOD = 60;
const LIVE_PERIOD = 360;

function tick(price: number, epoch: number): TickData {
  return { symbol: SYMBOL, derivSymbol: SYMBOL, price, epoch };
}

/** A valid, deterministic 1m candle for the given period. */
function candle(epoch: number, close = 1.1): HistoryCandleInput {
  return { epoch, open: close, high: close, low: close, close };
}

/**
 * A history entry exactly as the provider delivered it: untrusted, so its
 * fields can hold anything at all.
 */
type Delivered = Record<string, unknown>;

/** Present untrusted entries to the trusted-history API. */
function delivered(entries: Delivered[]): HistoryCandleInput[] {
  return entries as unknown as HistoryCandleInput[];
}

/** The same, for the response-application API. */
function deliveredResponse(entries: Delivered[]): HistoryCandleData[] {
  return entries as unknown as HistoryCandleData[];
}

function reasonsOf(rejections: readonly { reason: HistoryRejectionReason }[]): HistoryRejectionReason[] {
  return rejections.map((r) => r.reason);
}

/** A pair with an open gap, whose live edge has already moved forward. */
function interruptPair(manager: CandleManager): void {
  manager.processTick(tick(1.1, 100));
  manager.markDiscontinuity(SYMBOL);
  manager.processTick(tick(1.2, 400));
}

// =============================================================================================
// A — a non-finite value is rejected
// =============================================================================================

test('D4 A1 — a non-finite price is rejected, not repaired', () => {
  const broken: Delivered[] = [
    { epoch: 60, open: 1.1, high: NaN, low: 1.0, close: 1.05 },
    { epoch: 120, open: 1.1, high: Infinity, low: 1.0, close: 1.05 },
    { epoch: 180, open: 1.1, high: 1.2, low: -Infinity, close: 1.05 },
    { epoch: 240, open: 1.1, high: 'abc', low: 1.0, close: 1.05 },
    { epoch: 300, open: null, high: 1.2, low: 1.0, close: 1.05 },
    { epoch: 360, open: 1.1, high: 1.2, low: 1.0, close: undefined },
  ];

  const result = validateHistoryCandles(broken, PERIOD);

  assert.equal(result.valid.length, 0, 'no entry with a non-finite price is admitted');
  assert.equal(result.rejections.length, 6, 'every broken entry is reported');
  assert.deepEqual(
    new Set(reasonsOf(result.rejections)),
    new Set(['non-finite-value']),
    'a non-finite price is reported as such'
  );
  assert.equal(
    result.rejections.every((r) => r.epoch !== null),
    true,
    'the epoch is still reported when it could be read'
  );
});

test('D4 A2 — a numeric string price is accepted, because the provider sends strings', () => {
  const result = validateHistoryCandles(
    [{ epoch: 60, open: '1.1', high: '1.2', low: '1.0', close: '1.05' }],
    PERIOD
  );

  assert.equal(result.valid.length, 1, 'a numeric string is a number');
  assert.deepEqual(result.valid[0], { epoch: 60, open: 1.1, high: 1.2, low: 1.0, close: 1.05 });
  assert.equal(result.rejections.length, 0);
});

test('D4 A3 — the manager keeps a non-finite entry out of the trusted history', () => {
  const manager = new CandleManager();

  const summary = manager.seedHistory(
    SYMBOL,
    '1m',
    delivered([
      { epoch: 60, open: 1.1, high: NaN, low: 1.0, close: 1.05 },
      { epoch: 120, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    ])
  );

  assert.equal(summary.valid, 1);
  assert.equal(summary.admitted, 1);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.rejections[0].reason, 'non-finite-value');
  assert.deepEqual(
    manager.getHistory(SYMBOL, '1m').map((c) => c.epoch),
    [120],
    'only the valid period is in the trusted history'
  );
  assert.equal(
    manager.getHistory(SYMBOL, '1m').every((c) => Number.isFinite(c.high)),
    true,
    'the trusted history holds no non-finite price'
  );
});

// =============================================================================================
// B — a broken candle is rejected, not widened
// =============================================================================================

test('D4 B1 — a candle that breaks the OHLC invariants is rejected', () => {
  const broken: Delivered[] = [
    // The high sits below the open.
    { epoch: 60, open: 1.2, high: 1.1, low: 1.0, close: 1.15 },
    // The low sits above the close.
    { epoch: 120, open: 1.0, high: 1.2, low: 1.1, close: 1.05 },
    // The high sits below the low.
    { epoch: 180, open: 1.0, high: 1.05, low: 1.15, close: 1.1 },
  ];

  const result = validateHistoryCandles(broken, PERIOD);

  assert.equal(result.valid.length, 0, 'no broken candle is admitted');
  assert.deepEqual(
    new Set(reasonsOf(result.rejections)),
    new Set(['invalid-ohlc']),
    'a broken candle is reported as such'
  );
});

test('D4 B2 — a broken candle never overwrites the valid history of its period', () => {
  const manager = new CandleManager();
  manager.seedHistory(SYMBOL, '1m', delivered([{ epoch: 60, open: 1.0, high: 1.2, low: 0.9, close: 1.1 }]));

  const summary = manager.seedHistory(
    SYMBOL,
    '1m',
    delivered([{ epoch: 60, open: 1.1, high: 1.05, low: 1.0, close: 1.02 }])
  );

  assert.equal(summary.admitted, 0, 'the broken candle is not admitted');
  assert.equal(summary.rejected, 1);
  const history = manager.getHistory(SYMBOL, '1m');
  assert.equal(history.length, 1);
  assert.equal(history[0].high, 1.2, 'the valid high is not narrowed to the broken one');
  assert.equal(history[0].low, 0.9, 'the valid low is not raised to the broken one');
  assert.equal(history[0].close, 1.1, 'the valid close is not replaced');
});

// =============================================================================================
// C — an unusable or off-grid epoch is rejected
// =============================================================================================

test('D4 C1 — an unusable epoch is rejected', () => {
  const broken: Delivered[] = [
    { epoch: NaN, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    { epoch: Infinity, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    { epoch: -60, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    { epoch: 60.5, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    { epoch: 'soon', open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    { open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
  ];

  const result = validateHistoryCandles(broken, PERIOD);

  assert.equal(result.valid.length, 0, 'no entry with an unusable epoch is admitted');
  assert.deepEqual(
    new Set(reasonsOf(result.rejections)),
    new Set(['invalid-epoch']),
    'an unusable epoch is reported as such'
  );
});

test('D4 C2 — an epoch off the timeframe grid is rejected', () => {
  const result = validateHistoryCandles(
    [
      { epoch: 60, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 130, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 180, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    ],
    PERIOD
  );

  assert.deepEqual(
    result.valid.map((c) => c.epoch),
    [60, 180],
    'the off-grid period does not describe a period of this timeframe'
  );
  assert.deepEqual(reasonsOf(result.rejections), ['misaligned-epoch']);
  assert.equal(result.rejections[0].epoch, 130, 'the rejected period is named');
});

test('D4 C3 — the oldest entry may be the leading partial candle of the response', () => {
  // The provider adjusts the start of the first candle to the requested window
  // (adjust_start_time=1), so the oldest entry of a response may be off-grid.
  const result = validateHistoryCandles(
    [
      { epoch: 30, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 60, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 120, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    ],
    PERIOD
  );

  assert.equal(result.rejections.length, 0, 'the leading partial candle is tolerated');
  assert.deepEqual(
    result.valid.map((c) => c.epoch),
    [30, 60, 120]
  );
});

test('D4 C4 — the leading partial tolerance never hides an off-grid interior period', () => {
  const result = validateHistoryCandles(
    [
      { epoch: 30, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 60, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 140, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    ],
    PERIOD
  );

  assert.deepEqual(
    result.valid.map((c) => c.epoch),
    [30, 60],
    'only the oldest entry is exempt from the alignment rule'
  );
  assert.deepEqual(reasonsOf(result.rejections), ['misaligned-epoch']);
});

// =============================================================================================
// D — the initial seeding is not poisoned
// =============================================================================================

test('D4 D1 — a mixed response admits only its valid entries', () => {
  const manager = new CandleManager();

  const summary = manager.seedHistory(
    SYMBOL,
    '1m',
    delivered([
      { epoch: 60, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 120, open: 1.1, high: 1.2, low: 1.0, close: NaN },
      { epoch: 180, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    ])
  );

  assert.equal(summary.valid, 2);
  assert.equal(summary.admitted, 2);
  assert.equal(summary.rejected, 1);
  assert.deepEqual(
    manager.getHistory(SYMBOL, '1m').map((c) => c.epoch),
    [60, 180],
    'the valid periods are admitted, the broken one is not'
  );
  assert.equal(
    manager.getLastHistoryAdmission(SYMBOL, '1m')?.rejected,
    1,
    'the pair remembers what its last response contributed'
  );
});

test('D4 D2 — an all-invalid response admits nothing and keeps the valid history', () => {
  const manager = new CandleManager();
  manager.seedHistory(SYMBOL, '1m', delivered([{ epoch: 60, open: 1.1, high: 1.2, low: 1.0, close: 1.05 }]));

  const summary = manager.seedHistory(
    SYMBOL,
    '1m',
    delivered([{ epoch: 120, open: 1.1, high: 1.2, low: 1.0, close: NaN }])
  );

  assert.equal(summary.valid, 0);
  assert.equal(summary.admitted, 0, 'nothing is admitted');
  assert.equal(summary.rejected, 1);
  assert.deepEqual(
    manager.getHistory(SYMBOL, '1m').map((c) => c.epoch),
    [60],
    'the valid history survives an all-invalid response'
  );
});

test('D4 D3 — the rejection report is bounded', () => {
  const broken: Delivered[] = [];
  for (let i = 0; i < MAX_HISTORY_REJECTIONS_REPORTED * 3; i += 1) {
    broken.push({ epoch: 60 * (i + 1), open: 1.1, high: NaN, low: 1.0, close: 1.05 });
  }

  const validated = validateHistoryCandles(broken, PERIOD);
  assert.equal(validated.rejections.length, broken.length, 'every rejection is counted');
  const described = describeHistoryRejections(validated.rejections);
  assert.ok(described.includes('non-finite-value'), 'the reason is described');
  assert.ok(
    described.includes(`+${broken.length - MAX_HISTORY_REJECTIONS_REPORTED} more`),
    'the hidden rejections are counted, not dropped silently'
  );

  const manager = new CandleManager();
  const summary = manager.seedHistory(SYMBOL, '1m', delivered(broken));
  assert.equal(summary.rejected, broken.length, 'every rejection is counted');
  assert.equal(
    summary.rejections.length,
    MAX_HISTORY_REJECTIONS_REPORTED,
    'only a bounded number of details is kept'
  );
});

// =============================================================================================
// E — a reconnect recovery with an invalid required candle
// =============================================================================================

test('D4 E1 — an invalid required period cannot satisfy a recovery', () => {
  const closes: Candle[] = [];
  const manager = new CandleManager();
  manager.onCandleClose((_symbol, _timeframe, closed) => closes.push(closed));
  interruptPair(manager);

  const recovered = manager.recoverFromHistory(
    SYMBOL,
    '1m',
    delivered([
      { epoch: 60, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 120, open: 1.1, high: 1.2, low: 1.0, close: NaN },
      { epoch: 180, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 240, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 300, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    ])
  );

  assert.equal(recovered, false, 'a garbled response does not bridge the gap');
  assert.equal(manager.isRecoveryRequired(SYMBOL, '1m'), true, 'the pair stays blocked');

  const history = manager.getHistory(SYMBOL, '1m');
  assert.equal(
    history.some((c) => c.epoch === 120),
    false,
    'the invalid period is not admitted'
  );
  assert.equal(
    history.some((c) => c.epoch === INTERRUPTED_PERIOD),
    false,
    'the interrupted period is not admitted either'
  );
  assert.equal(history.length, 0, 'a refused recovery admits nothing at all');

  // D1: the interrupted candle is still not closed and still named.
  assert.equal(
    manager.getTimeframeState(SYMBOL, '1m')?.interruptedEpoch,
    INTERRUPTED_PERIOD,
    'the interrupted candle is still named'
  );

  // D3: the period is still missing, so the gap is still open.
  const requirement = manager.getRecoveryRequirement(SYMBOL, '1m');
  assert.ok(requirement, 'the pair still has a recovery requirement');
  assert.deepEqual(
    findMissingRequiredPeriods(requirement, [60, 180, 240, 300]),
    [120],
    'the invalid entry did not stand in for the missing period'
  );

  // The interrupted candle is still never closed, even after a later tick.
  manager.processTick(tick(1.25, 700));
  assert.equal(
    closes.some((c) => c.epoch === INTERRUPTED_PERIOD),
    false,
    'the interrupted candle is never closed'
  );

  // D2: the failed attempt consumed the bounded budget.
  assert.equal(
    manager.getRecoveryHistoryCount(SYMBOL, '1m', 100),
    200,
    'the next attempt asks for a wider window'
  );
});

test('D4 E2 — an all-invalid recovery response leaves the pair blocked', () => {
  const manager = new CandleManager();
  interruptPair(manager);

  const recovered = manager.recoverFromHistory(
    SYMBOL,
    '1m',
    delivered([
      { epoch: 60, open: 1.1, high: 1.2, low: 1.0, close: Infinity },
      { epoch: 120, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    ])
  );

  assert.equal(recovered, false, 'nothing admissible was delivered');
  assert.equal(manager.isRecoveryRequired(SYMBOL, '1m'), true, 'the pair stays blocked');
  assert.equal(manager.getHistory(SYMBOL, '1m').length, 0, 'the trusted history stays empty');
  assert.equal(
    manager.getRecoveryHistoryCount(SYMBOL, '1m', 100),
    200,
    'the failed attempt consumed the bounded budget'
  );
});

test('D4 E3 — a complete and valid recovery still succeeds', () => {
  const manager = new CandleManager();
  interruptPair(manager);

  const recovered = manager.recoverFromHistory(
    SYMBOL,
    '1m',
    delivered([
      { epoch: 60, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 120, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 180, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 240, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 300, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 360, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    ])
  );

  assert.equal(recovered, true, 'a valid, complete response bridges the gap');
  assert.equal(manager.isRecoveryRequired(SYMBOL, '1m'), false, 'the pair is whole again');
  assert.deepEqual(
    manager.getHistory(SYMBOL, '1m').map((c) => c.epoch),
    [60, 120, 180, 240, 300],
    'every recovered period is in the trusted history'
  );
  assert.equal(
    manager.getLastHistoryAdmission(SYMBOL, '1m')?.rejected,
    0,
    'a clean response reports no rejection'
  );
});

// =============================================================================================
// F — valid candles still work
// =============================================================================================

test('D4 F1 — a valid response is admitted completely', () => {
  const manager = new CandleManager();

  const summary = manager.seedHistory(
    SYMBOL,
    '1m',
    delivered([
      { epoch: 60, open: 1.0, high: 1.2, low: 0.9, close: 1.1 },
      { epoch: 120, open: 1.1, high: 1.3, low: 1.0, close: 1.2 },
    ])
  );

  assert.equal(summary.valid, 2);
  assert.equal(summary.admitted, 2);
  assert.equal(summary.rejected, 0);
  assert.deepEqual(summary.rejections, []);
  const history = manager.getHistory(SYMBOL, '1m');
  assert.deepEqual(history.map((c) => c.epoch), [60, 120]);
  assert.equal(history[0].high, 1.2, 'the delivered prices are kept as they are');
  assert.equal(history[1].close, 1.2);
});

test('D4 F2 — the seeding path is unchanged for a clean response', () => {
  const manager = new CandleManager();
  manager.seedHistory(SYMBOL, '1m', delivered([{ epoch: 60, open: 1.0, high: 1.2, low: 0.9, close: 1.1 }]));
  manager.seedHistory(SYMBOL, '1m', delivered([{ epoch: 60, open: 1.0, high: 1.2, low: 0.9, close: 1.1 }]));

  assert.equal(
    manager.getHistory(SYMBOL, '1m').length,
    1,
    're-seeding the same period does not duplicate the candle'
  );
});

// =============================================================================================
// G — the D1, D2 and D3 guarantees survive the validation layer
// =============================================================================================

/** A compact stand-in for the dashboard's history request path. */
class ResponseHarness {
  public readonly manager: CandleManager;
  public readonly controller: HistoryRecoveryController;
  public readonly responses: HistoryResponseApplication[] = [];

  constructor() {
    this.manager = new CandleManager();
    this.controller = new HistoryRecoveryController({
      policy: { maxAttempts: 3, delayMs: 5 },
      canRetry: () => true,
      onRetry: () => {
        // The retry action itself belongs to the request path; the harness only
        // observes the outcome the response produced.
      },
    });
  }

  public deliver(candles: HistoryCandleData[], outcome: HistoryRequestOutcome = 'success'): HistoryResponseApplication {
    const applied = applyHistoryResponse({
      manager: this.manager,
      controller: this.controller,
      symbol: SYMBOL,
      timeframe: '1m',
      candles,
      requestOutcome: outcome,
    });
    this.responses.push(applied);
    return applied;
  }
}

test('D4 G1 — a response that carries candles but admits none is a failure, not a success', () => {
  const harness = new ResponseHarness();

  const applied = harness.deliver(
    deliveredResponse([{ epoch: 60, open: 1.1, high: 1.2, low: 1.0, close: NaN }])
  );

  assert.equal(applied.outcome, 'failure', 'an unusable response is never a success');
  assert.equal(applied.admittedCandleCount, 0, 'nothing was admitted');
  assert.equal(applied.rejectedCandleCount, 1, 'the rejection is counted');
  assert.equal(applied.rejectedCandles[0].reason, 'non-finite-value');
  assert.equal(harness.manager.getHistory(SYMBOL, '1m').length, 0, 'the history stays empty');
});

test('D4 G2 — a response that admits part of its candles is a success with a report', () => {
  const harness = new ResponseHarness();

  const applied = harness.deliver(
    deliveredResponse([
      { epoch: 60, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 120, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 180, open: 1.1, high: 1.2, low: 1.0, close: Infinity },
    ])
  );

  assert.equal(applied.outcome, 'success', 'the usable part of the response is a success');
  assert.equal(applied.admittedCandleCount, 2);
  assert.equal(applied.rejectedCandleCount, 1);
  assert.deepEqual(
    harness.manager.getHistory(SYMBOL, '1m').map((c) => c.epoch),
    [60, 120],
    'the broken period never reaches the trusted history'
  );
});

test('D4 G3 — an unusable recovery response consumes the bounded budget and keeps the pair blocked', () => {
  const harness = new ResponseHarness();
  interruptPair(harness.manager);

  const applied = harness.deliver(
    deliveredResponse([
      { epoch: 60, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 120, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 180, open: 1.1, high: 1.2, low: 1.0, close: NaN },
      { epoch: 240, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 300, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 360, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    ])
  );

  assert.equal(applied.outcome, 'failure', 'the garbled recovery is not a success');
  assert.equal(applied.recoveryIncomplete, true, 'the gap was not bridged');
  assert.equal(applied.recoveryPending, true, 'the pair stays blocked');
  assert.equal(harness.manager.isRecoveryRequired(SYMBOL, '1m'), true);
  assert.equal(
    harness.manager.getRecoveryHistoryCount(SYMBOL, '1m', 100),
    200,
    'the failed attempt consumed the bounded budget'
  );
});

test('D4 G4 — the D3 completeness rule still refuses a response that skips a period', () => {
  const manager = new CandleManager();
  interruptPair(manager);

  const recovered = manager.recoverFromHistory(
    SYMBOL,
    '1m',
    delivered([
      { epoch: 60, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 120, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 240, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 300, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
      { epoch: 360, open: 1.1, high: 1.2, low: 1.0, close: 1.05 },
    ])
  );

  assert.equal(recovered, false, 'a valid but incomplete response is still refused');
  assert.equal(manager.isRecoveryRequired(SYMBOL, '1m'), true, 'the pair stays blocked');
  assert.equal(manager.getHistory(SYMBOL, '1m').length, 0, 'nothing is admitted');
});

test('D4 G5 — the validations hold for every timeframe', () => {
  const periods: Array<[Timeframe, number]> = [
    ['1m', 60],
    ['5m', 300],
    ['15m', 900],
    ['1H', 3600],
    ['1D', 86400],
  ];

  for (const [timeframe, periodSeconds] of periods) {
    const manager = new CandleManager();
    const base = Math.floor(1700000000 / periodSeconds) * periodSeconds;

    const summary = manager.seedHistory(
      SYMBOL,
      timeframe,
      delivered([
        { epoch: base, open: 1.0, high: 1.2, low: 0.9, close: 1.1 },
        { epoch: base + periodSeconds, open: 1.1, high: 1.3, low: 1.0, close: 1.2 },
        { epoch: base + periodSeconds + 1, open: 1.1, high: 1.3, low: 1.0, close: 1.2 },
      ])
    );

    assert.equal(summary.admitted, 2, `the valid periods are admitted for ${timeframe}`);
    assert.equal(summary.rejected, 1, `the off-grid period is rejected for ${timeframe}`);
    assert.equal(summary.rejections[0].reason, 'misaligned-epoch');
    assert.deepEqual(
      manager.getHistory(SYMBOL, timeframe).map((c) => c.epoch),
      [base, base + periodSeconds],
      `only whole periods of ${timeframe} are in the trusted history`
    );
  }
});
