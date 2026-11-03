import { getPipValue } from '../deriv/symbols';
import type { EqualHighLow, LiquidityLevel } from '../analysis/liquidity';
import type { FairValueGap } from '../analysis/fvg';
import type { OrderBlock } from '../analysis/order-blocks';

/**
 * Pure, display-only helpers for the SMC Analysis Panel.
 *
 * These helpers never fabricate data. Missing prices, timestamps, or
 * symbol-relative pip units are rendered as an em dash (`—`) rather than a
 * guessed value. Analyzer states are always derived from the model's explicit
 * flags/status fields, never inferred from array lengths alone.
 */

export const DEFAULT_LIST_LIMIT = 5;
export const EM_DASH = '—';

export type AnalyzerStatus = 'WAITING FOR DATA' | 'ACTIVE';
export type CollectionState = 'WAITING FOR DATA' | 'NONE_DETECTED' | 'ACTIVE';
export type ObjectState = 'ACTIVE' | 'MITIGATED' | 'INVALIDATED' | 'SWEPT';

/**
 * Resolves how a collection should read at a high level.
 * `status` is the analyzer's own status field; `count` only distinguishes an
 * initialized-but-empty analyzer ("None detected") from a populated one.
 */
export function resolveCollectionState(
  status: AnalyzerStatus | null | undefined,
  count: number
): CollectionState {
  if (!status || status === 'WAITING FOR DATA') return 'WAITING FOR DATA';
  if (count <= 0) return 'NONE_DETECTED';
  return 'ACTIVE';
}

export function collectionStateLabel(state: CollectionState): string {
  switch (state) {
    case 'ACTIVE':
      return 'Active';
    case 'NONE_DETECTED':
      return 'None detected';
    default:
      return 'WAITING FOR DATA';
  }
}

export function objectStateLabel(state: ObjectState): string {
  switch (state) {
    case 'SWEPT':
      return 'Swept';
    case 'MITIGATED':
      return 'Mitigated';
    case 'INVALIDATED':
      return 'Invalidated';
    default:
      return 'Active';
  }
}

export function liquidityLevelState(level: Pick<LiquidityLevel, 'swept'>): ObjectState {
  return level.swept ? 'SWEPT' : 'ACTIVE';
}

export function fvgState(fvg: Pick<FairValueGap, 'mitigated'>): ObjectState {
  return fvg.mitigated ? 'MITIGATED' : 'ACTIVE';
}

export function orderBlockState(ob: Pick<OrderBlock, 'invalidated' | 'mitigated'>): ObjectState {
  if (ob.invalidated) return 'INVALIDATED';
  if (ob.mitigated) return 'MITIGATED';
  return 'ACTIVE';
}

/** Formats a price with a fixed decimal count derived from the symbol's pip size. */
export function formatPrice(value: number | null | undefined, decimals = 5): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const places = Number.isInteger(decimals) && decimals >= 0 ? decimals : 5;
  return value.toFixed(places);
}

/**
 * Formats a raw price distance in symbol-relative pip units.
 * Unsupported symbols (no configured pip value) render as an em dash so a raw
 * price distance is never presented as if it were a pip measurement.
 */
export function formatPips(
  distance: number | null | undefined,
  symbolId: string,
  decimals = 1
): string {
  if (distance === null || distance === undefined || !Number.isFinite(distance)) return EM_DASH;
  const pipValue = getPipValue(symbolId);
  if (pipValue === undefined || pipValue <= 0) return EM_DASH;
  const places = Number.isInteger(decimals) && decimals >= 0 ? decimals : 1;
  return `${(distance / pipValue).toFixed(places)} pips`;
}

/** Formats a UTC epoch (seconds) as `HH:MM:SS`. Missing epochs render as an em dash. */
export function formatTimestamp(epoch: number | null | undefined): string {
  if (epoch === null || epoch === undefined || !Number.isFinite(epoch)) return EM_DASH;
  return new Date(epoch * 1000).toISOString().slice(11, 19);
}

export function signedDistance(
  referencePrice: number | null | undefined,
  price: number
): number | null {
  if (
    referencePrice === null ||
    referencePrice === undefined ||
    !Number.isFinite(referencePrice) ||
    !Number.isFinite(price)
  ) {
    return null;
  }
  return price - referencePrice;
}

export function absoluteDistance(
  referencePrice: number | null | undefined,
  price: number
): number | null {
  const distance = signedDistance(referencePrice, price);
  return distance === null ? null : Math.abs(distance);
}

/**
 * Distance from the reference price to a price zone `[low, high]`.
 * Returns 0 when the reference price is inside the zone, otherwise the distance
 * to the nearest edge. Returns null when the reference price or edges are invalid.
 */
export function distanceToZone(
  referencePrice: number | null | undefined,
  low: number,
  high: number
): number | null {
  if (
    referencePrice === null ||
    referencePrice === undefined ||
    !Number.isFinite(referencePrice)
  ) {
    return null;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  const zoneLow = Math.min(low, high);
  const zoneHigh = Math.max(low, high);
  if (referencePrice < zoneLow) return zoneLow - referencePrice;
  if (referencePrice > zoneHigh) return referencePrice - zoneHigh;
  return 0;
}

/**
 * Selects the object whose price is closest to the reference price.
 * Ties are resolved by iteration order (the first encountered wins) so the
 * result is deterministic for a stable input ordering.
 */
export function findNearestByPrice<T>(
  items: readonly T[],
  referencePrice: number | null | undefined,
  getPrice: (item: T) => number
): T | null {
  if (
    referencePrice === null ||
    referencePrice === undefined ||
    !Number.isFinite(referencePrice)
  ) {
    return null;
  }
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const item of items) {
    const price = getPrice(item);
    if (!Number.isFinite(price)) continue;
    const distance = Math.abs(price - referencePrice);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  }
  return best;
}

export interface DealingRange {
  low: number;
  high: number;
  midpoint: number;
  size: number;
}

/**
 * Builds the premium/discount dealing range from the latest confirmed swing
 * high and low. Returns null when either endpoint is unavailable or the range
 * collapses, matching the analysis engine's "WAITING FOR DATA" condition.
 */
export function computeDealingRange(
  latestHigh: number | null | undefined,
  latestLow: number | null | undefined
): DealingRange | null {
  if (latestHigh === null || latestHigh === undefined) return null;
  if (latestLow === null || latestLow === undefined) return null;
  if (!Number.isFinite(latestHigh) || !Number.isFinite(latestLow)) return null;

  const high = Math.max(latestHigh, latestLow);
  const low = Math.min(latestHigh, latestLow);
  const size = high - low;
  if (!(size > 0)) return null;

  return { low, high, midpoint: (high + low) / 2, size };
}

export function midpoint(a: number, b: number): number {
  return (a + b) / 2;
}

/**
 * Fractional position of `price` within the dealing range (0 at the low, 1 at
 * the high). Values outside [0, 1] are returned unclamped so callers can decide
 * how to display out-of-range prices.
 */
export function rangePosition(
  price: number | null | undefined,
  range: DealingRange | null | undefined
): number | null {
  if (!range || !(range.size > 0)) return null;
  if (price === null || price === undefined || !Number.isFinite(price)) return null;
  return (price - range.low) / range.size;
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export interface CappedList<T> {
  items: T[];
  total: number;
  hidden: number;
}

/** Caps a list for display while retaining the total/available count. */
export function capList<T>(items: readonly T[], limit = DEFAULT_LIST_LIMIT): CappedList<T> {
  const total = items.length;
  const safeLimit =
    Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_LIST_LIMIT;
  const shown = total <= safeLimit ? items.slice() : items.slice(0, safeLimit);
  return { items: shown, total, hidden: total - shown.length };
}

/** Renders "shown of total" when capped, otherwise just the total. */
export function formatCountSummary(shown: number, total: number): string {
  if (total <= 0) return '0';
  if (shown >= total) return `${total}`;
  return `${shown} of ${total}`;
}

/** Counts the unmitigated/invalidated/swept members of a collection. */
export function countByState<T>(
  items: readonly T[],
  getState: (item: T) => ObjectState
): Record<ObjectState, number> {
  const counts: Record<ObjectState, number> = {
    ACTIVE: 0,
    MITIGATED: 0,
    INVALIDATED: 0,
    SWEPT: 0,
  };
  for (const item of items) {
    counts[getState(item)] += 1;
  }
  return counts;
}

export type { EqualHighLow, FairValueGap, LiquidityLevel, OrderBlock };
