import { TickData } from './candles';
import { getSymbolIdFromDerivSymbol } from './symbols';

/**
 * Pure helpers for parsing Deriv tick payloads and classifying the health of a
 * symbol's live feed. Kept free of WebSocket/browser APIs so they can be unit
 * tested directly.
 *
 * These helpers never fabricate prices: any message that fails validation is
 * rejected (returns `null`) rather than coerced into a tick.
 */

/** Health of a single symbol's live market-data feed. */
export type FeedState =
  | 'IDLE'
  | 'PENDING'
  | 'LIVE'
  | 'STALE'
  | 'CLOSED'
  | 'UNAVAILABLE';

export interface FeedStatus {
  symbol: string;
  state: FeedState;
  errorCode?: string;
  errorMessage?: string;
  lastTickEpoch?: number;
}

export interface FeedStatusSignals {
  hasTick: boolean;
  isStale: boolean;
  errorCode?: string | null;
}

/**
 * Maps a Deriv subscription error code to a feed state.
 * `MarketIsClosed` is an expected, benign condition (weekend/holiday) and is
 * distinguished from genuinely unavailable/invalid symbols.
 */
export function classifySubscriptionError(code: string | null | undefined): FeedState {
  if (!code) return 'UNAVAILABLE';
  if (code === 'MarketIsClosed') return 'CLOSED';
  return 'UNAVAILABLE';
}

/**
 * Derives the feed state from explicit signals. A symbol is only `LIVE` after a
 * valid tick has actually been received; a healthy socket alone is never enough.
 */
export function deriveFeedState(signals: FeedStatusSignals): FeedState {
  if (signals.errorCode) return classifySubscriptionError(signals.errorCode);
  if (!signals.hasTick) return 'PENDING';
  return signals.isStale ? 'STALE' : 'LIVE';
}

export function feedStateLabel(state: FeedState): string {
  switch (state) {
    case 'LIVE':
      return 'Live';
    case 'STALE':
      return 'Stalled';
    case 'PENDING':
      return 'Waiting';
    case 'CLOSED':
      return 'Market closed';
    case 'UNAVAILABLE':
      return 'Unavailable';
    default:
      return 'Idle';
  }
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parses and validates a raw Deriv `tick` object.
 *
 * Returns `null` (never a fake tick) when the payload is malformed or carries a
 * non-finite / non-positive quote or epoch. The returned `symbol` is the app's
 * internal symbol ID, resolved from the Deriv instrument identifier.
 */
export function parseTick(rawTick: unknown): TickData | null {
  if (!rawTick || typeof rawTick !== 'object') return null;
  const raw = rawTick as Record<string, unknown>;

  const derivSymbol = raw.symbol;
  if (typeof derivSymbol !== 'string' || derivSymbol.length === 0) return null;

  const price = Number(raw.quote);
  if (!Number.isFinite(price) || price <= 0) return null;

  const epoch = Number(raw.epoch);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;

  const symbolId = getSymbolIdFromDerivSymbol(derivSymbol) || derivSymbol;

  return {
    symbol: symbolId,
    derivSymbol,
    price,
    epoch,
    pipSize: toOptionalNumber(raw.pip_size),
    bid: toOptionalNumber(raw.bid),
    ask: toOptionalNumber(raw.ask),
  };
}

/**
 * Identifies the internal symbol a subscription error belongs to, if any.
 * Only tick-subscription errors are relevant here; candle-history errors must
 * not affect live feed health.
 */
export function symbolFromSubscriptionError(
  echoReq: unknown
): { symbol: string; isTickSubscription: boolean } | null {
  if (!echoReq || typeof echoReq !== 'object') return null;
  const echo = echoReq as Record<string, unknown>;
  if (typeof echo.ticks !== 'string' || echo.ticks.length === 0) return null;
  return {
    symbol: getSymbolIdFromDerivSymbol(echo.ticks) || echo.ticks,
    isTickSubscription: true,
  };
}
