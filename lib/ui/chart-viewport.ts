/**
 * Pure, dependency-free math for the candlestick chart viewport (zoom & pan).
 *
 * A viewport describes which slice of the full, ordered candle history is
 * visible. It never mutates the history and never returns NaN/Infinity: every
 * public helper clamps its inputs and outputs to sane, finite values.
 */

export interface ChartViewport {
  /** Index (into the full history) of the first visible candle. */
  start: number;
  /** Number of visible candle slots. */
  count: number;
  /** When true, the viewport is pinned to the most recent candle. */
  following: boolean;
}

export interface ViewportSummary {
  start: number;
  end: number;
  count: number;
  following: boolean;
  candlesBehind: number;
}

export const MIN_VISIBLE_CANDLES = 10;
export const MAX_VISIBLE_CANDLES = 400;
export const DEFAULT_VISIBLE_CANDLES = 60;

export const MIN_PRICE_SCALE = 0.25;
export const MAX_PRICE_SCALE = 4;
export const DEFAULT_PRICE_SCALE = 1;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/** Rounds and bounds a candle count to the supported visible range. */
export function clampCount(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return DEFAULT_VISIBLE_CANDLES;
  return Math.max(MIN_VISIBLE_CANDLES, Math.min(MAX_VISIBLE_CANDLES, Math.round(count)));
}

/** Bounds the vertical price zoom factor. */
export function clampPriceScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return DEFAULT_PRICE_SCALE;
  return Math.max(MIN_PRICE_SCALE, Math.min(MAX_PRICE_SCALE, scale));
}

function nonNegativeInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

/** Creates a following viewport showing the most recent `count` candles. */
export function createViewport(
  total: number,
  count: number = DEFAULT_VISIBLE_CANDLES
): ChartViewport {
  const totalCandles = nonNegativeInt(total);
  const visibleCount = clampCount(count);
  return {
    start: Math.max(0, totalCandles - visibleCount),
    count: visibleCount,
    following: true,
  };
}

/** Clamps a viewport to a valid range for the given history length. */
export function clampViewport(viewport: ChartViewport, total: number): ChartViewport {
  const totalCandles = nonNegativeInt(total);
  const count = clampCount(viewport.count);
  const maxStart = Math.max(0, totalCandles - count);

  if (viewport.following) {
    return { start: maxStart, count, following: true };
  }

  const start = Math.max(0, Math.min(maxStart, nonNegativeInt(viewport.start)));
  return { start, count, following: false };
}

/** Pans by a (possibly fractional) number of candles; always unpins. */
export function panViewport(
  viewport: ChartViewport,
  deltaCandles: number,
  total: number
): ChartViewport {
  const base = clampViewport(viewport, total);
  const maxStart = Math.max(0, nonNegativeInt(total) - base.count);
  const delta = Number.isFinite(deltaCandles) ? deltaCandles : 0;
  const start = Math.max(0, Math.min(maxStart, Math.round(base.start + delta)));
  return { start, count: base.count, following: false };
}

/**
 * Zooms around a horizontal anchor expressed as a ratio (0 = left edge,
 * 1 = right edge). While following, the viewport stays pinned to the right.
 */
export function zoomViewportAt(
  viewport: ChartViewport,
  factor: number,
  anchorRatio: number,
  total: number
): ChartViewport {
  const base = clampViewport(viewport, total);
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const newCount = clampCount(base.count * safeFactor);

  if (base.following) {
    return clampViewport({ start: 0, count: newCount, following: true }, total);
  }

  const ratio = clamp01(anchorRatio);
  const anchorIndex = base.start + ratio * base.count;
  const start = Math.round(anchorIndex - ratio * newCount);
  return clampViewport({ start, count: newCount, following: false }, total);
}

/** Zooms around the vertical center of the viewport. */
export function zoomViewport(
  viewport: ChartViewport,
  factor: number,
  total: number
): ChartViewport {
  const base = clampViewport(viewport, total);
  const ratio = base.following ? 1 : 0.5;
  return zoomViewportAt(base, factor, ratio, total);
}

/** Resets to the default following viewport (most recent candles). */
export function resetViewport(total: number): ChartViewport {
  return createViewport(total, DEFAULT_VISIBLE_CANDLES);
}

/** Re-pins the viewport to the most recent candle, keeping the current zoom. */
export function resumeLive(viewport: ChartViewport, total: number): ChartViewport {
  return clampViewport({ start: 0, count: viewport.count, following: true }, total);
}

/** Resolves the concrete `[start, end)` candle index range being shown. */
export function viewportRange(viewport: ChartViewport, total: number): { start: number; end: number } {
  const clamped = clampViewport(viewport, total);
  const end = Math.min(nonNegativeInt(total), clamped.start + clamped.count);
  return { start: clamped.start, end };
}

/** Human-facing summary used for the LIVE/HISTORICAL badge. */
export function viewportSummary(viewport: ChartViewport, total: number): ViewportSummary {
  const clamped = clampViewport(viewport, total);
  const { start, end } = viewportRange(clamped, total);
  const candlesBehind = Math.max(0, nonNegativeInt(total) - end);
  return {
    start,
    end,
    count: clamped.count,
    following: clamped.following && candlesBehind === 0,
    candlesBehind,
  };
}

/** Maps a candle index to its horizontal center pixel. */
export function indexToX(
  viewport: ChartViewport,
  index: number,
  chartLeft: number,
  chartWidth: number,
  total: number
): number {
  const clamped = clampViewport(viewport, total);
  const left = Number.isFinite(chartLeft) ? chartLeft : 0;
  const width = Number.isFinite(chartWidth) ? chartWidth : 0;
  const slot = width / clamped.count;
  const idx = Number.isFinite(index) ? index : clamped.start;
  return left + (idx - clamped.start + 0.5) * slot;
}

/** Maps an x pixel to a candle index, or null when outside the plot area. */
export function xToIndex(
  viewport: ChartViewport,
  x: number,
  chartLeft: number,
  chartWidth: number,
  total: number
): number | null {
  if (!Number.isFinite(x) || chartWidth <= 0) return null;
  const clamped = clampViewport(viewport, total);
  const slot = chartWidth / clamped.count;
  const rel = Math.floor((x - chartLeft) / slot);
  if (rel < 0 || rel >= clamped.count) return null;
  const index = clamped.start + rel;
  if (index < 0 || index >= nonNegativeInt(total)) return null;
  return index;
}
