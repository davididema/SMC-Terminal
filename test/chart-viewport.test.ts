import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createViewport,
  clampViewport,
  clampCount,
  clampPriceScale,
  panViewport,
  zoomViewport,
  zoomViewportAt,
  resetViewport,
  resumeLive,
  viewportRange,
  viewportSummary,
  indexToX,
  xToIndex,
  MIN_VISIBLE_CANDLES,
  MAX_VISIBLE_CANDLES,
  DEFAULT_VISIBLE_CANDLES,
} from '../lib/ui/chart-viewport';

test('createViewport pins a following window to the most recent candles', () => {
  const vp = createViewport(200, 60);
  assert.deepEqual(vp, { start: 140, count: 60, following: true });
});

test('createViewport never produces a negative start for short histories', () => {
  const vp = createViewport(12, 60);
  assert.equal(vp.start, 0);
  assert.equal(vp.count, 60);
  assert.equal(vp.following, true);
});

test('clampCount bounds the visible count and rejects invalid input', () => {
  assert.equal(clampCount(5), MIN_VISIBLE_CANDLES);
  assert.equal(clampCount(10000), MAX_VISIBLE_CANDLES);
  assert.equal(clampCount(60), 60);
  assert.equal(clampCount(60.4), 60);
  assert.equal(clampCount(NaN), DEFAULT_VISIBLE_CANDLES);
  assert.equal(clampCount(0), DEFAULT_VISIBLE_CANDLES);
  assert.equal(clampCount(-3), DEFAULT_VISIBLE_CANDLES);
});

test('clampPriceScale bounds the vertical zoom factor', () => {
  assert.equal(clampPriceScale(0.01), 0.25);
  assert.equal(clampPriceScale(100), 4);
  assert.equal(clampPriceScale(1), 1);
  assert.equal(clampPriceScale(NaN), 1);
  assert.equal(clampPriceScale(-2), 1);
});

test('clampViewport keeps a following viewport pinned to the right edge', () => {
  const vp = clampViewport({ start: 0, count: 60, following: true }, 200);
  assert.deepEqual(vp, { start: 140, count: 60, following: true });

  // Following viewport stays pinned even if a stale start is supplied.
  const stale = clampViewport({ start: 5, count: 50, following: true }, 100);
  assert.equal(stale.start, 50);
});

test('clampViewport bounds a paused (non-following) viewport without pinning it', () => {
  const past = clampViewport({ start: -20, count: 60, following: false }, 200);
  assert.deepEqual(past, { start: 0, count: 60, following: false });

  const future = clampViewport({ start: 999, count: 60, following: false }, 200);
  assert.deepEqual(future, { start: 140, count: 60, following: false });
});

test('panViewport moves the window and unpins it', () => {
  const following = createViewport(200, 60); // start 140, following
  const panned = panViewport(following, -10, 200);
  assert.deepEqual(panned, { start: 130, count: 60, following: false });
});

test('panViewport rounds fractional deltas and clamps at both edges', () => {
  const vp = { start: 100, count: 60, following: false };
  assert.equal(panViewport(vp, -2.6, 200).start, 97);
  assert.equal(panViewport(vp, -1000, 200).start, 0);
  assert.equal(panViewport(vp, 1000, 200).start, 140);
});

test('zoomViewportAt keeps the anchor candle fixed when paused', () => {
  const vp = { start: 100, count: 60, following: false };
  // Anchor at the left edge (ratio 0) -> start stays put while count shrinks.
  const zoomed = zoomViewportAt(vp, 0.5, 0, 200);
  assert.equal(zoomed.count, 30);
  assert.equal(zoomed.start, 100);
  assert.equal(zoomed.following, false);

  // Anchor at the right edge (ratio 1) -> the right edge stays put.
  const right = zoomViewportAt(vp, 0.5, 1, 200);
  assert.equal(right.count, 30);
  assert.equal(right.start, 130);
});

test('zoomViewport while following stays pinned to the latest candle', () => {
  const following = createViewport(200, 60); // start 140
  const zoomedIn = zoomViewport(following, 0.5, 200);
  assert.deepEqual(zoomedIn, { start: 170, count: 30, following: true });

  const zoomedOut = zoomViewport(following, 2, 200);
  assert.deepEqual(zoomedOut, { start: 80, count: 120, following: true });
});

test('zoom clamps the count to the supported range', () => {
  const vp = { start: 0, count: MAX_VISIBLE_CANDLES, following: false };
  assert.equal(zoomViewport(vp, 4, 1000).count, MAX_VISIBLE_CANDLES);

  const tight = { start: 0, count: MIN_VISIBLE_CANDLES, following: false };
  assert.equal(zoomViewport(tight, 0.01, 1000).count, MIN_VISIBLE_CANDLES);
});

test('resetViewport returns a fresh following window', () => {
  assert.deepEqual(resetViewport(200), { start: 140, count: 60, following: true });
});

test('resumeLive re-pins while preserving the zoom level', () => {
  const panned = { start: 20, count: 30, following: false };
  const live = resumeLive(panned, 200);
  assert.deepEqual(live, { start: 170, count: 30, following: true });
});

test('viewportRange resolves the concrete [start, end) slice', () => {
  assert.deepEqual(viewportRange({ start: 100, count: 60, following: false }, 200), {
    start: 100,
    end: 160,
  });
  // Clamps a window that would run past the history back to the right edge.
  assert.deepEqual(viewportRange({ start: 180, count: 60, following: false }, 200), {
    start: 140,
    end: 200,
  });
});

test('viewportSummary reports following state and candles behind', () => {
  const live = viewportSummary(createViewport(200, 60), 200);
  assert.equal(live.following, true);
  assert.equal(live.candlesBehind, 0);

  const historical = viewportSummary({ start: 100, count: 60, following: false }, 200);
  assert.equal(historical.following, false);
  assert.equal(historical.candlesBehind, 40);
});

test('indexToX and xToIndex round-trip across the viewport', () => {
  const vp = { start: 100, count: 60, following: false };
  const left = 10;
  const width = 600; // 10px per candle slot

  assert.equal(indexToX(vp, 100, left, width, 200), 15); // first slot center
  assert.equal(indexToX(vp, 159, left, width, 200), 605); // last slot center

  for (const index of [100, 120, 145, 159]) {
    const x = indexToX(vp, index, left, width, 200);
    assert.equal(xToIndex(vp, x, left, width, 200), index);
  }
});

test('xToIndex returns null outside the plot area or the history', () => {
  const vp = { start: 100, count: 60, following: false };
  assert.equal(xToIndex(vp, 5, 10, 600, 200), null); // left of plot
  assert.equal(xToIndex(vp, 620, 10, 600, 200), null); // right of 60 slots
  assert.equal(xToIndex(vp, NaN, 10, 600, 200), null);
  assert.equal(xToIndex(vp, 15, 10, 0, 200), null);
});

test('viewport helpers never emit NaN for malformed input', () => {
  const bad = { start: NaN, count: NaN, following: false };
  const clamped = clampViewport(bad, NaN);
  assert.ok(Number.isFinite(clamped.start));
  assert.ok(Number.isFinite(clamped.count));

  const panned = panViewport(bad, NaN, NaN);
  assert.ok(Number.isFinite(panned.start));

  const zoomed = zoomViewportAt(bad, NaN, NaN, NaN);
  assert.ok(Number.isFinite(zoomed.start));
  assert.ok(Number.isFinite(zoomed.count));

  const x = indexToX(bad, NaN, 0, 600, NaN);
  assert.ok(Number.isFinite(x));
});
