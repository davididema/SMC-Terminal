import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIST_LIMIT,
  absoluteDistance,
  capList,
  clamp01,
  collectionStateLabel,
  computeDealingRange,
  countByState,
  distanceToZone,
  findNearestByPrice,
  formatCountSummary,
  formatPips,
  formatPrice,
  formatTimestamp,
  fvgState,
  liquidityLevelState,
  midpoint,
  objectStateLabel,
  orderBlockState,
  rangePosition,
  resolveCollectionState,
  signedDistance,
} from '../lib/ui/smc-view';

test('VIEW 1 — Collection state distinguishes waiting, none, and active', () => {
  assert.equal(resolveCollectionState(undefined, 0), 'WAITING FOR DATA');
  assert.equal(resolveCollectionState(null, 5), 'WAITING FOR DATA');
  assert.equal(resolveCollectionState('WAITING FOR DATA', 5), 'WAITING FOR DATA');
  assert.equal(resolveCollectionState('ACTIVE', 0), 'NONE_DETECTED');
  assert.equal(resolveCollectionState('ACTIVE', 3), 'ACTIVE');
});

test('VIEW 2 — Collection state is never inferred from array length alone', () => {
  // Populated arrays under a WAITING status must stay WAITING.
  assert.equal(resolveCollectionState('WAITING FOR DATA', 9), 'WAITING FOR DATA');
  // An initialized analyzer with no objects is "None detected", not WAITING.
  assert.equal(resolveCollectionState('ACTIVE', 0), 'NONE_DETECTED');
});

test('VIEW 3 — State labels are human readable', () => {
  assert.equal(collectionStateLabel('WAITING FOR DATA'), 'WAITING FOR DATA');
  assert.equal(collectionStateLabel('NONE_DETECTED'), 'None detected');
  assert.equal(collectionStateLabel('ACTIVE'), 'Active');
  assert.equal(objectStateLabel('ACTIVE'), 'Active');
  assert.equal(objectStateLabel('MITIGATED'), 'Mitigated');
  assert.equal(objectStateLabel('INVALIDATED'), 'Invalidated');
  assert.equal(objectStateLabel('SWEPT'), 'Swept');
});

test('VIEW 4 — Object states use explicit model flags', () => {
  assert.equal(liquidityLevelState({ swept: false }), 'ACTIVE');
  assert.equal(liquidityLevelState({ swept: true }), 'SWEPT');
  assert.equal(fvgState({ mitigated: false }), 'ACTIVE');
  assert.equal(fvgState({ mitigated: true }), 'MITIGATED');
  assert.equal(orderBlockState({ invalidated: false, mitigated: false }), 'ACTIVE');
  assert.equal(orderBlockState({ invalidated: false, mitigated: true }), 'MITIGATED');
  assert.equal(orderBlockState({ invalidated: true, mitigated: true }), 'INVALIDATED');
  // The invariant (invalidated implies mitigated) must never downgrade to MITIGATED.
  assert.equal(orderBlockState({ invalidated: true, mitigated: false }), 'INVALIDATED');
});

test('VIEW 5 — countByState tallies each explicit state', () => {
  const levels = [{ swept: false }, { swept: true }, { swept: true }];
  assert.deepEqual(countByState(levels, liquidityLevelState), {
    ACTIVE: 1,
    MITIGATED: 0,
    INVALIDATED: 0,
    SWEPT: 2,
  });
});

test('VIEW 6 — Price formatting is fixed-precision and never fabricates', () => {
  assert.equal(formatPrice(1.105, 5), '1.10500');
  assert.equal(formatPrice(1.105, 3), '1.105');
  assert.equal(formatPrice(1.1234, 2), '1.12');
  assert.equal(formatPrice(null), '—');
  assert.equal(formatPrice(undefined), '—');
  assert.equal(formatPrice(NaN), '—');
  assert.equal(formatPrice(Infinity), '—');
});

test('VIEW 7 — Pip formatting is symbol relative', () => {
  assert.equal(formatPips(0.001, 'EURUSD'), '10.0 pips');
  assert.equal(formatPips(0.1, 'USDJPY'), '10.0 pips');
  assert.equal(formatPips(null, 'EURUSD'), '—');
  assert.equal(formatPips(0.001, 'UNKNOWN_SYMBOL'), '—');
});

test('VIEW 8 — Timestamp formatting is UTC and unavailable epochs are em dash', () => {
  assert.equal(formatTimestamp(1700000000), '22:13:20');
  assert.equal(formatTimestamp(0), '00:00:00');
  assert.equal(formatTimestamp(null), '—');
  assert.equal(formatTimestamp(undefined), '—');
  assert.equal(formatTimestamp(NaN), '—');
});

test('VIEW 9 — Signed and absolute distance require a reference price', () => {
  assert.equal(signedDistance(100, 101.5), 1.5);
  assert.equal(signedDistance(100, 98), -2);
  assert.equal(absoluteDistance(100, 98), 2);
  assert.equal(signedDistance(null, 100), null);
  assert.equal(absoluteDistance(undefined, 100), null);
  assert.equal(absoluteDistance(100, NaN), null);
});

test('VIEW 10 — Nearest object selection is stable and reference-bound', () => {
  const items = [{ p: 1 }, { p: 5 }, { p: 10 }];
  assert.deepEqual(findNearestByPrice(items, 4, (i) => i.p), { p: 5 });
  assert.deepEqual(findNearestByPrice(items, 100, (i) => i.p), { p: 10 });
  assert.equal(findNearestByPrice(items, null, (i) => i.p), null);
  assert.equal(findNearestByPrice([], 4, (i: { p: number }) => i.p), null);
  // Exact tie resolves to the first encountered object.
  assert.deepEqual(findNearestByPrice([{ p: 2 }, { p: 3 }], 2.5, (i) => i.p), { p: 2 });
});

test('VIEW 10b — Distance to a zone is zero inside and nearest edge outside', () => {
  assert.equal(distanceToZone(100, 95, 105), 0);
  assert.equal(distanceToZone(101, 95, 105), 0);
  assert.equal(distanceToZone(90, 95, 105), 5);
  assert.equal(distanceToZone(110, 95, 105), 5);
  assert.equal(distanceToZone(null, 95, 105), null);
  assert.equal(distanceToZone(100, NaN, 105), null);
});

test('VIEW 11 — Dealing range derives endpoints, size, and midpoint', () => {
  assert.deepEqual(computeDealingRange(110, 100), {
    low: 100,
    high: 110,
    midpoint: 105,
    size: 10,
  });
  assert.deepEqual(computeDealingRange(100, 110), {
    low: 100,
    high: 110,
    midpoint: 105,
    size: 10,
  });
  assert.equal(computeDealingRange(null, 100), null);
  assert.equal(computeDealingRange(100, undefined), null);
  assert.equal(computeDealingRange(100, 100), null);
  assert.equal(computeDealingRange(NaN, 100), null);
});

test('VIEW 12 — Midpoint is the arithmetic mean', () => {
  assert.equal(midpoint(100, 110), 105);
  assert.equal(midpoint(-3, 3), 0);
});

test('VIEW 13 — Range positioning maps price into the dealing range', () => {
  const range = computeDealingRange(110, 100);
  assert.equal(rangePosition(105, range), 0.5);
  assert.equal(rangePosition(100, range), 0);
  assert.equal(rangePosition(110, range), 1);
  assert.equal(rangePosition(90, range), -1);
  assert.equal(rangePosition(null, range), null);
  assert.equal(rangePosition(105, null), null);
  assert.equal(rangePosition(105, computeDealingRange(100, 100)), null);
});

test('VIEW 14 — clamp01 bounds values to the unit interval', () => {
  assert.equal(clamp01(-2), 0);
  assert.equal(clamp01(0.42), 0.42);
  assert.equal(clamp01(3), 1);
  assert.equal(clamp01(NaN), 0);
  assert.equal(clamp01(Infinity), 1);
});

test('VIEW 15 — List capping reports displayed versus available counts', () => {
  const many = [1, 2, 3, 4, 5, 6, 7, 8];
  const capped = capList(many, 5);
  assert.deepEqual(capped.items, [1, 2, 3, 4, 5]);
  assert.equal(capped.total, 8);
  assert.equal(capped.hidden, 3);

  const short = capList([1, 2], 5);
  assert.equal(short.total, 2);
  assert.equal(short.hidden, 0);

  const none = capList([1, 2, 3], 0);
  assert.deepEqual(none.items, []);
  assert.equal(none.total, 3);
  assert.equal(none.hidden, 3);

  assert.equal(DEFAULT_LIST_LIMIT, 5);
});

test('VIEW 16 — Count summary renders shown-of-total only when capped', () => {
  assert.equal(formatCountSummary(0, 0), '0');
  assert.equal(formatCountSummary(3, 3), '3');
  assert.equal(formatCountSummary(5, 8), '5 of 8');
});
