/**
 * Phase 4A — G1: the recovery anchor must be closure-aware.
 *
 * The confirmed defect: when a seeded pair had no forming candle during a
 * market closure, `computeGapAnchor` selected the period right after the last
 * known candle. For a Forex pair seeded before a weekend that period is a
 * documented closure period, which can never appear in a history response.
 * `isRecoveryCovered` still demanded that exact epoch, so the pair could never
 * be released: valid history was returned, the requirement stayed open, and the
 * retry budget was spent while the pair remained permanently blocked.
 *
 * These tests use synthetic epochs and an in-memory stand-in for the provider.
 * No socket, no network, and no fabricated market data: the candles are
 * deterministic fixtures whose only purpose is to describe periods.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CandleManager,
  MAX_RECOVERY_HISTORY_COUNT,
  findMissingRequiredPeriods,
  isRecoveryCovered,
  type RecoveryRequirement,
  type TickData,
  type Timeframe,
} from '../lib/deriv/candles';
import {
  MAX_RECOVERY_CHUNKS,
  RecoveryChunkCoordinator,
  planRecoveryChunks,
  type RecoveryCycleResult,
} from '../lib/deriv/history-chunks';
import { HistoryRecoveryController } from '../lib/deriv/history-recovery';
import { isClosurePeriod } from '../lib/deriv/session-closures';
import type { HistoryCandleData, HistoryRequestOutcome } from '../lib/deriv/history-requests';

// --- The fixtures ---------------------------------------------------------------
// 2024-01-05 is a Friday and 2024-01-07 is a Sunday. The documented Forex
// weekend closure runs from Friday 20:00 UTC through Sunday 22:00 UTC.
const FRIDAY_1900 = 1704481200;
const FRIDAY_1957 = 1704484620;
const FRIDAY_1958 = 1704484680;
const FRIDAY_1959 = 1704484740;
const FRIDAY_2000 = 1704484800;
const FRIDAY_2100 = 1704488400;
const SUNDAY_2200 = 1704664800;
const SUNDAY_2300 = 1704668400;
const THURSDAY_2200 = 1705010400;

// 2024-01-09 is a Tuesday. The documented Metals daily halt is 21:00-22:59 UTC.
const TUESDAY_2000 = 1704830400;
const TUESDAY_2058 = 1704833880;
const TUESDAY_2059 = 1704833940;
const TUESDAY_2100 = 1704834000;
const TUESDAY_2300 = 1704841200;
const TUESDAY_2301 = 1704841260;

const PERIOD = 60;

function candle(epoch: number, close = 1.1): HistoryCandleData {
  return { epoch, open: close, high: close, low: close, close };
}

function candles(epochs: readonly number[]): HistoryCandleData[] {
  return epochs.map((epoch) => candle(epoch));
}

function tick(symbol: string, price: number, epoch: number): TickData {
  return { symbol, derivSymbol: symbol, price, epoch };
}

// =============================================================================================
// A — Forex weekend anchor
// =============================================================================================

test('G1 A — a pair seeded before the weekend recovers instead of staying blocked', () => {
  const manager = new CandleManager();
  const seeded = candles([FRIDAY_1958, FRIDAY_1959]);
  manager.seedHistory('EURUSD', '1m', seeded);

  assert.equal(
    manager.getCurrentCandle('EURUSD', '1m'),
    null,
    'the pair has no forming candle (it was seeded while the market was closed)'
  );

  manager.markDiscontinuity('EURUSD');
  const requirement = manager.getRecoveryRequirement('EURUSD', '1m');

  assert.ok(requirement, 'the discontinuity is recorded');
  assert.equal(requirement.category, 'Forex', 'the documented closure applies');
  assert.equal(
    requirement.recoveryEpoch,
    SUNDAY_2200,
    'the anchor skips the weekend closure and lands on the first recoverable period'
  );
  assert.equal(
    isClosurePeriod(requirement.recoveryEpoch, 'Forex'),
    false,
    'the anchor is not itself a closure period'
  );
  assert.equal(requirement.interruptedEpoch, null, 'no candle was interrupted');
  assert.equal(requirement.requiredCount, 1, 'the anchor is the only required period');

  // Control: a response that only re-states the pre-closure history does not
  // prove that the first post-closure period exists. The pair must stay blocked.
  assert.equal(
    manager.recoverFromHistory('EURUSD', '1m', seeded),
    false,
    'a closure alone does not release the pair'
  );
  assert.equal(
    manager.isRecoveryRequired('EURUSD', '1m'),
    true,
    'the pair is still blocked after a pre-closure-only response'
  );

  // A response that spans the closure (the first period after it included)
  // completes the recovery.
  const spanning = [...seeded, candle(SUNDAY_2200)];
  assert.equal(
    manager.recoverFromHistory('EURUSD', '1m', spanning),
    true,
    'the recovery completes once the first post-closure period is covered'
  );
  assert.equal(
    manager.isRecoveryRequired('EURUSD', '1m'),
    false,
    'the pair is released'
  );
  assert.equal(
    manager.getHistory('EURUSD', '1m').some((c) => c.epoch === SUNDAY_2200),
    true,
    'the post-closure period is part of the trusted history'
  );
});

test('G1 A2 — the same anchor defect does not exist for an unknown category', () => {
  const manager = new CandleManager();
  manager.seedHistory('UNKNOWN', '1m', candles([FRIDAY_1958, FRIDAY_1959]));
  manager.markDiscontinuity('UNKNOWN');

  const requirement = manager.getRecoveryRequirement('UNKNOWN', '1m');
  assert.ok(requirement);
  assert.equal(requirement.category, undefined, 'an unknown symbol has no documented closure');
  assert.equal(
    requirement.recoveryEpoch,
    FRIDAY_2000,
    'without a documented closure nothing is skipped (fail safe)'
  );
});

// =============================================================================================
// B — Metals daily closure
// =============================================================================================

test('G1 B — a Metals closure anchor is never a mandatory epoch', () => {
  // A requirement whose INITIAL anchor falls inside the documented daily halt.
  const requirement: RecoveryRequirement = {
    recoveryEpoch: TUESDAY_2100,
    interruptedEpoch: null,
    liveEpoch: TUESDAY_2100,
    periodSeconds: 3600,
    requiredCount: 1,
    category: 'Metals',
  };

  assert.equal(
    isClosurePeriod(requirement.recoveryEpoch, 'Metals'),
    true,
    'the fixture anchor is inside the documented Metals halt'
  );
  assert.deepEqual(
    findMissingRequiredPeriods(requirement, []),
    [],
    'the halt period is not a missing period'
  );
  assert.equal(
    isRecoveryCovered(requirement, [TUESDAY_2000]),
    true,
    'the last pre-halt candle reaches the live edge, so the pair may be released'
  );

  // The same anchor is NOT exempt for a category without that closure.
  assert.equal(
    isRecoveryCovered({ ...requirement, category: 'Forex' }, [TUESDAY_2000]),
    false,
    'a closure of another category excuses nothing'
  );
});

test('G1 B2 — a Metals pair anchors after the halt and releases with post-halt data', () => {
  const manager = new CandleManager();
  const seeded = candles([TUESDAY_2058, TUESDAY_2059]);
  manager.seedHistory('XAUUSD', '1m', seeded);
  manager.markDiscontinuity('XAUUSD');

  const requirement = manager.getRecoveryRequirement('XAUUSD', '1m');
  assert.ok(requirement);
  assert.equal(requirement.category, 'Metals');
  assert.equal(requirement.recoveryEpoch, TUESDAY_2300, 'the anchor skips the daily halt');
  assert.equal(
    isClosurePeriod(requirement.recoveryEpoch, 'Metals'),
    false,
    'the anchor is a recoverable period'
  );

  assert.equal(
    manager.recoverFromHistory('XAUUSD', '1m', seeded),
    false,
    'the pre-halt history alone does not cover the anchor'
  );
  assert.equal(
    manager.recoverFromHistory('XAUUSD', '1m', [...seeded, candle(TUESDAY_2300)]),
    true,
    'the post-halt period completes the recovery'
  );
});

// =============================================================================================
// C — a missing trading period outside the closure still blocks
// =============================================================================================

test('G1 C — an unresolvable closure anchor does not excuse a missing trading period', () => {
  const requirement: RecoveryRequirement = {
    recoveryEpoch: FRIDAY_2100,
    interruptedEpoch: null,
    liveEpoch: SUNDAY_2300,
    periodSeconds: 3600,
    requiredCount: 26,
    category: 'Forex',
  };

  assert.deepEqual(
    findMissingRequiredPeriods(requirement, [SUNDAY_2300]),
    [SUNDAY_2200],
    'the post-closure trading period is still required'
  );
  assert.equal(
    isRecoveryCovered(requirement, [SUNDAY_2300]),
    false,
    'a closure anchor never hides a missing trading period'
  );
  assert.equal(
    isRecoveryCovered(requirement, [SUNDAY_2200, SUNDAY_2300]),
    true,
    'the complete trading history is accepted'
  );
});

test('G1 C2 — a hole in the post-closure history keeps the pair blocked', () => {
  const manager = new CandleManager();
  const seeded = candles([FRIDAY_1958, FRIDAY_1959]);
  manager.seedHistory('EURUSD', '1m', seeded);
  manager.markDiscontinuity('EURUSD');

  // The live edge moves into the reopened market; the anchor stays at the first
  // post-closure period.
  manager.processTick(tick('EURUSD', 1.1, SUNDAY_2200 + 4 * PERIOD));
  const requirement = manager.getRecoveryRequirement('EURUSD', '1m');
  assert.ok(requirement);
  assert.equal(requirement.recoveryEpoch, SUNDAY_2200);
  assert.equal(requirement.liveEpoch, SUNDAY_2200 + 4 * PERIOD);

  const withHole = candles([
    SUNDAY_2200,
    SUNDAY_2200 + PERIOD,
    SUNDAY_2200 + 3 * PERIOD,
  ]);
  assert.deepEqual(
    findMissingRequiredPeriods(requirement, withHole.map((c) => c.epoch)),
    [SUNDAY_2200 + 2 * PERIOD],
    'the skipped period is reported'
  );
  assert.equal(
    manager.recoverFromHistory('EURUSD', '1m', [...seeded, ...withHole]),
    false,
    'the pair stays blocked'
  );
  assert.equal(
    manager.recoverFromHistory(
      'EURUSD',
      '1m',
      [
        ...seeded,
        candle(SUNDAY_2200),
        candle(SUNDAY_2200 + PERIOD),
        candle(SUNDAY_2200 + 2 * PERIOD),
        candle(SUNDAY_2200 + 3 * PERIOD),
      ]
    ),
    true,
    'the complete post-closure history releases the pair'
  );
});

// =============================================================================================
// D — the interrupted candle stays mandatory
// =============================================================================================

test('G1 D — a closure anchor does not release an unresolved interrupted candle', () => {
  const requirement: RecoveryRequirement = {
    recoveryEpoch: TUESDAY_2100,
    interruptedEpoch: TUESDAY_2301,
    liveEpoch: TUESDAY_2301,
    periodSeconds: PERIOD,
    requiredCount: 121,
    category: 'Metals',
  };

  const withoutInterrupted = candles([TUESDAY_2059, TUESDAY_2300]);
  assert.deepEqual(
    findMissingRequiredPeriods(requirement, withoutInterrupted.map((c) => c.epoch)),
    [],
    'no trading period is missing (the halt is exempt and 23:00 is present)'
  );
  assert.equal(
    isRecoveryCovered(requirement, withoutInterrupted.map((c) => c.epoch)),
    false,
    'D1 still requires the interrupted candle, even though the anchor is a closure'
  );
  assert.equal(
    isRecoveryCovered(
      requirement,
      [...withoutInterrupted, candle(TUESDAY_2301)].map((c) => c.epoch)
    ),
    true,
    're-deriving the interrupted candle completes the recovery'
  );
});

test('G1 D2 — a Metals pair whose forming candle is interrupted still needs it', () => {
  const manager = new CandleManager();
  manager.processTick(tick('XAUUSD', 1.1, TUESDAY_2059 + 30));
  manager.markDiscontinuity('XAUUSD');

  const requirement = manager.getRecoveryRequirement('XAUUSD', '1m');
  assert.ok(requirement);
  assert.equal(requirement.recoveryEpoch, TUESDAY_2059, 'the interrupted candle is the anchor');
  assert.equal(requirement.interruptedEpoch, TUESDAY_2059);

  assert.equal(
    manager.recoverFromHistory('XAUUSD', '1m', [candle(TUESDAY_2300)]),
    false,
    'a post-halt response cannot stand in for the interrupted candle'
  );
  assert.equal(
    manager.recoverFromHistory('XAUUSD', '1m', [candle(TUESDAY_2059), candle(TUESDAY_2300)]),
    true,
    'the interrupted candle is re-derived and the pair is released'
  );
});

// =============================================================================================
// E — D3 interior completeness still applies
// =============================================================================================

test('G1 E — D3 still rejects an incomplete trading history', () => {
  const requirement: RecoveryRequirement = {
    recoveryEpoch: SUNDAY_2200,
    interruptedEpoch: null,
    liveEpoch: SUNDAY_2200 + 4 * PERIOD,
    periodSeconds: PERIOD,
    requiredCount: 5,
    category: 'Forex',
  };

  const incomplete = candles([
    SUNDAY_2200,
    SUNDAY_2200 + PERIOD,
    SUNDAY_2200 + 3 * PERIOD,
  ]);
  assert.deepEqual(
    findMissingRequiredPeriods(requirement, incomplete.map((c) => c.epoch)),
    [SUNDAY_2200 + 2 * PERIOD]
  );
  assert.equal(
    isRecoveryCovered(requirement, incomplete.map((c) => c.epoch)),
    false
  );
  assert.equal(
    isRecoveryCovered(
      requirement,
      candles([
        SUNDAY_2200,
        SUNDAY_2200 + PERIOD,
        SUNDAY_2200 + 2 * PERIOD,
        SUNDAY_2200 + 3 * PERIOD,
      ]).map((c) => c.epoch)
    ),
    true
  );
});

test('G1 E2 — the D3 closure exemptions are unchanged inside a gap', () => {
  // The weekend between Friday 19:00 and Sunday 22:00 is still exempt end to end.
  const requirement: RecoveryRequirement = {
    recoveryEpoch: FRIDAY_1900,
    interruptedEpoch: null,
    liveEpoch: SUNDAY_2200,
    periodSeconds: 3600,
    requiredCount: 52,
    category: 'Forex',
  };
  const closureOnly = candles([FRIDAY_1900, SUNDAY_2200]);
  assert.deepEqual(
    findMissingRequiredPeriods(requirement, closureOnly.map((c) => c.epoch)),
    [],
    'closed periods are not missing periods'
  );
  assert.equal(
    isRecoveryCovered(requirement, closureOnly.map((c) => c.epoch)),
    true,
    'the weekend is bridged without a candle for every closed hour'
  );
});

// =============================================================================================
// F — chunked recovery near a closure
// =============================================================================================

interface ProviderRequest {
  symbol: string;
  timeframe: Timeframe;
  count: number;
  end: number | null;
}

/** An in-memory stand-in for the provider's bounded history window. */
class FakeProvider {
  public readonly requests: ProviderRequest[] = [];

  private readonly liveEpoch: number;

  constructor(liveEpoch: number) {
    this.liveEpoch = liveEpoch;
  }

  public fetch(
    symbol: string,
    timeframe: Timeframe,
    count: number,
    end: number | null,
    callback: (candles: HistoryCandleData[], outcome: HistoryRequestOutcome) => void
  ): void {
    const request: ProviderRequest = { symbol, timeframe, count, end };
    this.requests.push(request);
    callback(this.epochsOf(request).map((epoch) => candle(epoch)), 'success');
  }

  public epochsOf(request: ProviderRequest): number[] {
    const newest = request.end === null ? this.liveEpoch : request.end;
    const oldest = newest - (request.count - 1) * PERIOD;
    const epochs: number[] = [];
    for (let epoch = oldest; epoch <= newest; epoch += PERIOD) epochs.push(epoch);
    return epochs;
  }
}

test('G1 F — a chunk plan counts the anchor that the manager actually stores', () => {
  const closureAnchor: RecoveryRequirement = {
    recoveryEpoch: FRIDAY_2100,
    interruptedEpoch: null,
    liveEpoch: THURSDAY_2200,
    periodSeconds: PERIOD,
    requiredCount: 0,
    category: 'Forex',
  };
  const closurePlan = planRecoveryChunks(closureAnchor);
  const advancedPlan = planRecoveryChunks({ ...closureAnchor, recoveryEpoch: SUNDAY_2200 });

  assert.equal(closurePlan.from, FRIDAY_2100, 'the plan starts at the requirement anchor');
  assert.equal(advancedPlan.from, SUNDAY_2200, 'the closure-aware anchor is the plan start');
  assert.equal(
    closurePlan.requiredCount - advancedPlan.requiredCount,
    2940,
    'the skipped weekend is exactly the difference in the counted periods'
  );
  assert.equal(closurePlan.size, 'chunked');
  assert.equal(advancedPlan.size, 'chunked');
  assert.ok(advancedPlan.requiredCount <= advancedPlan.capacity, 'the plan stays inside the budget');
});

test('G1 F2 — a chunked recovery that starts after a closure completes', () => {
  const manager = new CandleManager(30000);
  const provider = new FakeProvider(THURSDAY_2200);
  const results: RecoveryCycleResult[] = [];
  const controller = new HistoryRecoveryController({
    policy: { maxAttempts: 3, delayMs: 5 },
    canRetry: () => true,
    onRetry: (symbol, timeframe) => coordinator.start(symbol, timeframe),
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

  manager.seedHistory('EURUSD', '1m', candles([FRIDAY_1958, FRIDAY_1959]));
  manager.markDiscontinuity('EURUSD');
  manager.processTick(tick('EURUSD', 1.1, THURSDAY_2200 + 30));

  const requirement = manager.getRecoveryRequirement('EURUSD', '1m');
  assert.ok(requirement);
  assert.equal(requirement.recoveryEpoch, SUNDAY_2200, 'the gap starts after the weekend');
  assert.equal(requirement.liveEpoch, THURSDAY_2200);

  const start = coordinator.start('EURUSD', '1m');
  assert.equal(start.kind, 'chunked', 'a four-day post-closure gap needs bounded windows');
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), false, 'the pair is released');
  assert.equal(results.length, 1);
  assert.equal(results[0].recoveryComplete, true);
  assert.equal(results[0].recoveryPending, false);
  assert.ok(
    provider.requests.length <= MAX_RECOVERY_CHUNKS,
    'the cycle stayed inside its bounded request budget'
  );
  assert.equal(
    provider.requests.every((r) => r.count <= MAX_RECOVERY_HISTORY_COUNT),
    true,
    'every request stays inside the provider limit'
  );
  assert.equal(
    manager.getHistory('EURUSD', '1m').some((c) => c.epoch === SUNDAY_2200),
    true,
    'the first post-closure period is part of the trusted history'
  );
});

// =============================================================================================
// G — pair isolation
// =============================================================================================

test('G1 G — resolving one pair does not release another pair', () => {
  const manager = new CandleManager(30000);
  manager.seedHistory('EURUSD', '1m', candles([FRIDAY_1958, FRIDAY_1959]));
  manager.seedHistory('GBPUSD', '1m', candles([FRIDAY_1958, FRIDAY_1959]));
  manager.seedHistory('XAUUSD', '1m', candles([TUESDAY_2058, TUESDAY_2059]));

  manager.markDiscontinuity('EURUSD');
  manager.markDiscontinuity('GBPUSD');
  manager.markDiscontinuity('XAUUSD');

  // Resolve EURUSD across the weekend.
  assert.equal(
    manager.recoverFromHistory('EURUSD', '1m', [
      candle(FRIDAY_1959),
      candle(SUNDAY_2200),
    ]),
    true,
    'EURUSD recovers across its closure'
  );
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), false, 'EURUSD is released');
  assert.equal(manager.isRecoveryRequired('GBPUSD', '1m'), true, 'GBPUSD is untouched');
  assert.equal(manager.isRecoveryRequired('XAUUSD', '1m'), true, 'XAUUSD is untouched');

  // GBPUSD still needs its own post-closure period.
  assert.equal(
    manager.recoverFromHistory('GBPUSD', '1m', [candle(FRIDAY_1959)]),
    false,
    'a pre-closure-only response leaves GBPUSD blocked'
  );
  assert.equal(manager.isRecoveryRequired('GBPUSD', '1m'), true);

  // XAUUSD is released only by its own post-halt data.
  assert.equal(
    manager.recoverFromHistory('XAUUSD', '1m', [candle(TUESDAY_2300)]),
    true,
    'XAUUSD recovers after its daily halt'
  );
  assert.equal(manager.isRecoveryRequired('XAUUSD', '1m'), false);
  assert.equal(manager.isRecoveryRequired('GBPUSD', '1m'), true, 'GBPUSD is still blocked');
});
