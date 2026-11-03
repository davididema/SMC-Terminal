/**
 * Active-selection guarding for market-data events.
 *
 * Candle events (close / update) are emitted by the candle manager for every
 * supported timeframe of a symbol. Listener callbacks must only mutate the
 * active chart's state when the event belongs to the currently selected
 * symbol AND timeframe; otherwise an event from a non-selected pair could
 * overwrite the active view.
 */

import { Timeframe } from './candles';

/** Stable identity comparison for a symbol/timeframe pair. */
export function isSelectedPair(
  eventSymbolId: string,
  eventTimeframe: Timeframe,
  selectedSymbolId: string,
  selectedTimeframe: Timeframe
): boolean {
  return (
    eventSymbolId === selectedSymbolId &&
    eventTimeframe === selectedTimeframe
  );
}
