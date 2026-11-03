import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isClosurePeriod,
  isContinuousCategory,
  isDailyMaintenanceBoundary,
  isWeekendClosureBoundary,
} from '../lib/deriv/session-closures';
import {
  findMissingRequiredPeriods,
  isRecoveryCovered,
  validateHistoryCandles,
  type RecoveryRequirement,
} from '../lib/deriv/candles';

const HOUR = 3600;
const MINUTE = 60;

function utc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0
): number {
  return Date.UTC(year, month, day, hour, minute) / 1000;
}

function candle(epoch: number) {
  return { epoch, open: 1, high: 1, low: 1, close: 1 };
}

function requirement(
  overrides: Partial<RecoveryRequirement> &
    Pick<RecoveryRequirement, 'recoveryEpoch' | 'liveEpoch' | 'periodSeconds'>
): RecoveryRequirement {
  return {
    interruptedEpoch: null,
    requiredCount: 0,
    ...overrides,
  };
}

test('C2 closure — Forex weekend starts Friday 20:00 UTC and ends Sunday 22:00 UTC', () => {
  assert.equal(isWeekendClosureBoundary(utc(2024, 0, 5, 19, 59), 'Forex'), false);
  assert.equal(isWeekendClosureBoundary(utc(2024, 0, 5, 20, 0), 'Forex'), true);
  assert.equal(isWeekendClosureBoundary(utc(2024, 0, 5, 20, 1), 'Forex'), true);
  assert.equal(isWeekendClosureBoundary(utc(2024, 0, 6, 12, 0), 'Forex'), true);
  assert.equal(isWeekendClosureBoundary(utc(2024, 0, 7, 21, 59), 'Forex'), true);
  assert.equal(isWeekendClosureBoundary(utc(2024, 0, 7, 22, 0), 'Forex'), false);
  assert.equal(isWeekendClosureBoundary(utc(2024, 0, 8, 0, 0), 'Forex'), false);
});

test('C2 closure — Metals weekend uses the same window and adds no Forex daily halt', () => {
  assert.equal(isWeekendClosureBoundary(utc(2024, 0, 6, 12, 0), 'Metals'), true);
  assert.equal(isWeekendClosureBoundary(utc(2024, 0, 7, 22, 0), 'Metals'), false);
  assert.equal(isDailyMaintenanceBoundary(utc(2024, 0, 3, 21, 0), 'Forex'), false);
  assert.equal(isDailyMaintenanceBoundary(utc(2024, 0, 3, 21, 0), 'Synthetics'), false);
});

test('C2 closure — the Metals daily halt covers 21:00 and 22:00 UTC exactly', () => {
  assert.equal(isDailyMaintenanceBoundary(utc(2024, 0, 3, 20, 59), 'Metals'), false);
  assert.equal(isDailyMaintenanceBoundary(utc(2024, 0, 3, 21, 0), 'Metals'), true);
  assert.equal(isDailyMaintenanceBoundary(utc(2024, 0, 3, 21, 30), 'Metals'), true);
  assert.equal(isDailyMaintenanceBoundary(utc(2024, 0, 3, 22, 59), 'Metals'), true);
  assert.equal(isDailyMaintenanceBoundary(utc(2024, 0, 3, 23, 0), 'Metals'), false);
});

test('C2 closure — Synthetics and Crash/Boom are continuous and never have a closure', () => {
  for (const category of ['Synthetics', 'Crash/Boom'] as const) {
    assert.equal(isContinuousCategory(category), true);
    assert.equal(isClosurePeriod(utc(2024, 0, 5, 20, 0), category), false);
    assert.equal(isClosurePeriod(utc(2024, 0, 6, 12, 0), category), false);
    assert.equal(isClosurePeriod(utc(2024, 0, 3, 21, 0), category), false);
  }
  assert.equal(isContinuousCategory('Forex'), false);
  assert.equal(isContinuousCategory('Metals'), false);
});

test('C2 coverage — a weekend closure is excused but a weekday holiday gap is not', () => {
  const recoveryEpoch = utc(2024, 0, 5, 19);
  const liveEpoch = utc(2024, 0, 8, 2);
  const req = requirement({
    recoveryEpoch,
    liveEpoch,
    periodSeconds: HOUR,
    category: 'Forex',
  });

  const complete = [
    utc(2024, 0, 5, 19),
    utc(2024, 0, 7, 22),
    utc(2024, 0, 7, 23),
    utc(2024, 0, 8, 0),
    utc(2024, 0, 8, 1),
  ];
  assert.deepEqual(findMissingRequiredPeriods(req, complete), []);
  assert.equal(isRecoveryCovered(req, complete), true);

  const holiday = complete.filter((epoch) => epoch !== utc(2024, 0, 8, 0));
  assert.deepEqual(findMissingRequiredPeriods(req, holiday), [utc(2024, 0, 8, 0)]);
  assert.equal(isRecoveryCovered(req, holiday), false);
});

test('C2 coverage — the same weekend periods are required when the category is unknown', () => {
  const recoveryEpoch = utc(2024, 0, 5, 19);
  const liveEpoch = utc(2024, 0, 8, 2);
  const complete = [
    utc(2024, 0, 5, 19),
    utc(2024, 0, 7, 22),
    utc(2024, 0, 7, 23),
    utc(2024, 0, 8, 0),
    utc(2024, 0, 8, 1),
  ];

  const req = requirement({
    recoveryEpoch,
    liveEpoch,
    periodSeconds: HOUR,
  });
  assert.ok(findMissingRequiredPeriods(req, complete).length > 0);
  assert.equal(isRecoveryCovered(req, complete), false);
});

test('C2 coverage — the Metals halt is excused for Metals and required for Forex', () => {
  const metals = requirement({
    recoveryEpoch: utc(2024, 0, 3, 20),
    liveEpoch: utc(2024, 0, 4, 0),
    periodSeconds: HOUR,
    category: 'Metals',
  });
  const recovered = [utc(2024, 0, 3, 20), utc(2024, 0, 3, 23)];
  assert.deepEqual(findMissingRequiredPeriods(metals, recovered), []);
  assert.equal(isRecoveryCovered(metals, recovered), true);

  const forex = { ...metals, category: 'Forex' as const };
  assert.deepEqual(findMissingRequiredPeriods(forex, recovered), [
    utc(2024, 0, 3, 21),
    utc(2024, 0, 3, 22),
  ]);
  assert.equal(isRecoveryCovered(forex, recovered), false);
});

test('C2 validation — only the oldest entry may be off-grid, in any order', () => {
  const entries = [candle(100), candle(120), candle(180)];
  const forward = validateHistoryCandles(entries, MINUTE);
  assert.equal(forward.rejections.length, 0);
  assert.deepEqual(
    forward.valid.map((c) => c.epoch),
    [100, 120, 180]
  );

  const reverse = validateHistoryCandles([...entries].reverse(), MINUTE);
  assert.equal(reverse.rejections.length, 0);
  assert.deepEqual(
    reverse.valid.map((c) => c.epoch),
    [180, 120, 100]
  );

  const misaligned = validateHistoryCandles(
    [candle(60), candle(100), candle(120)],
    MINUTE
  );
  assert.equal(misaligned.rejections.length, 1);
  assert.equal(misaligned.rejections[0].reason, 'misaligned-epoch');
  assert.equal(misaligned.rejections[0].epoch, 100);
  assert.deepEqual(
    misaligned.valid.map((c) => c.epoch),
    [60, 120]
  );
});

test('C2 coverage — duplicate epochs never stand in for a missing period', () => {
  const req = requirement({
    recoveryEpoch: 60,
    liveEpoch: 180,
    periodSeconds: MINUTE,
    category: 'Synthetics',
  });

  assert.deepEqual(findMissingRequiredPeriods(req, [60, 60, 120]), []);
  assert.equal(isRecoveryCovered(req, [60, 60, 120]), true);
  assert.deepEqual(findMissingRequiredPeriods(req, [60, 60]), [120]);
  assert.equal(isRecoveryCovered(req, [60, 60]), false);
});

test('C2 coverage — a forming live-edge candle may be included, but is not required', () => {
  const req = requirement({
    recoveryEpoch: 60,
    liveEpoch: 180,
    periodSeconds: MINUTE,
    category: 'Synthetics',
  });

  assert.equal(isRecoveryCovered(req, [60, 120]), true);
  assert.equal(isRecoveryCovered(req, [60, 120, 180]), true);
});

test('C2 coverage — a history that stops short of the live edge is refused', () => {
  const req = requirement({
    recoveryEpoch: 60,
    liveEpoch: 240,
    periodSeconds: MINUTE,
    category: 'Synthetics',
  });

  assert.deepEqual(findMissingRequiredPeriods(req, [60, 120]), [180]);
  assert.equal(isRecoveryCovered(req, [60, 120]), false);
});

test('C2 coverage — the interrupted candle must be re-derived by the same response', () => {
  const req = requirement({
    recoveryEpoch: 60,
    interruptedEpoch: 180,
    liveEpoch: 180,
    periodSeconds: MINUTE,
    category: 'Synthetics',
  });

  assert.equal(isRecoveryCovered(req, [60, 120]), false);
  assert.equal(isRecoveryCovered(req, [60, 120, 180]), true);
});

test('C2 coverage — an empty response never covers an open gap', () => {
  const req = requirement({
    recoveryEpoch: 60,
    liveEpoch: 120,
    periodSeconds: MINUTE,
    category: 'Synthetics',
  });
  assert.equal(isRecoveryCovered(req, []), false);
});
