/**
 * Session closures for the instrument categories the terminal supports.
 *
 * A recovery response legitimately does NOT contain candles for the periods in
 * which the market was closed. This module is the single source of truth for
 * those closure windows, so the same closure is never reported as a data
 * defect in one place and as a benign gap in another:
 *
 * - `lib/deriv/candles.ts` uses it to decide whether a missing period in a
 *   recovery response is a genuine data gap or a period in which the market
 *   simply did not trade.
 * - `test/verification-lib.ts` re-exports it, so the offline verification
 *   helpers keep their public API and stay consistent with the live check.
 *
 * The windows are deliberately generous (they cover broker and DST variation)
 * and they are the same windows the project already used for offline gap
 * classification. They are NOT a market calendar: holidays are not
 * enumerable here, so a gap that spans a holiday is not excused by this
 * module (see `lib/deriv/candles.ts` for the consequences).
 */

import { InstrumentCategory } from './symbols';

/** The UTC day of the week (0 = Sunday ... 6 = Saturday) of an epoch. */
export function utcDayOfWeek(epoch: number): number {
  return new Date(epoch * 1000).getUTCDay();
}

/** The UTC hour (0-23) of an epoch. */
export function utcHour(epoch: number): number {
  return new Date(epoch * 1000).getUTCHours();
}

/**
 * True for the categories that trade continuously: synthetic indices and the
 * Crash/Boom indices have no weekly close and no intraday halt.
 */
export function isContinuousCategory(category: InstrumentCategory): boolean {
  return category === 'Synthetics' || category === 'Crash/Boom';
}

/**
 * True when the given period boundary falls inside a legitimate weekend market
 * closure. Only applies to continuously-traded categories with a weekly close
 * (Forex, Metals). Synthetics and Crash/Boom trade 24/7 and never qualify.
 *
 * The window is deliberately generous (Fri >= 20:00 UTC through Sun < 22:00 UTC)
 * so that broker/DST variation and both the 21:00 and 22:00 reopens are never
 * misreported as a data defect.
 */
export function isWeekendClosureBoundary(epoch: number, category: InstrumentCategory): boolean {
  if (isContinuousCategory(category)) {
    return false;
  }
  const day = utcDayOfWeek(epoch);
  const hour = utcHour(epoch);
  if (day === 6) return true; // Saturday
  if (day === 5 && hour >= 20) return true; // Friday evening
  if (day === 0 && hour < 22) return true; // Sunday before reopen
  return false;
}

/**
 * True when a period boundary falls inside a legitimate intraday maintenance
 * closure. Metals (gold) halt for a short window each day around the CME
 * session break — observed at 21:00-22:00 UTC, widened to 21:00-23:00 UTC to
 * cover DST/broker variation. Other categories trade with no intraday halt.
 */
export function isDailyMaintenanceBoundary(epoch: number, category: InstrumentCategory): boolean {
  if (category !== 'Metals') return false;
  const hour = utcHour(epoch);
  return hour === 21 || hour === 22;
}

/**
 * True when the given period boundary falls inside ANY documented closure of
 * the instrument's category (weekly close or daily maintenance halt).
 *
 * A period inside a closure window legitimately has no candle, so a recovery
 * response that omits it is not incomplete.
 */
export function isClosurePeriod(epoch: number, category: InstrumentCategory): boolean {
  return isWeekendClosureBoundary(epoch, category) || isDailyMaintenanceBoundary(epoch, category);
}
