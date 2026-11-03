export type InstrumentCategory = 'Forex' | 'Metals' | 'Synthetics' | 'Crash/Boom';

export interface DerivSymbolConfig {
  id: string;
  /** Exact instrument identifier returned by Deriv's `active_symbols` feed. */
  derivSymbol: string;
  displayName: string;
  category: InstrumentCategory;
  /**
   * Decimal places the instrument is quoted to. Also the display precision, so
   * it is used for `toFixed` and as the base for the default tick/pip scaling.
   */
  pipSize: number;
  description: string;
  /** Deriv market classification (from `active_symbols`), when known. */
  market?: string;
  /** Deriv submarket classification (from `active_symbols`), when known. */
  submarket?: string;
  /** `pip_size` reported by Deriv for the instrument, when known (informational). */
  derivPipSize?: number;
  /** Smallest price increment. Defaults to `10^-pipSize`. */
  tickSize?: number;
  /**
   * Symbol-consistent price-distance unit used for pip displays. Defaults to
   * `10^-(pipSize-1)`. This is NOT a broker pip; it is only used to express
   * distances on a scale appropriate to the instrument.
   */
  pipValue?: number;
}

export const SUPPORTED_SYMBOLS: DerivSymbolConfig[] = [
  {
    id: 'EURUSD',
    derivSymbol: 'frxEURUSD',
    displayName: 'EUR/USD',
    category: 'Forex',
    pipSize: 5,
    description: 'Euro / US Dollar',
  },
  {
    id: 'GBPUSD',
    derivSymbol: 'frxGBPUSD',
    displayName: 'GBP/USD',
    category: 'Forex',
    pipSize: 5,
    description: 'British Pound / US Dollar',
  },
  {
    id: 'USDJPY',
    derivSymbol: 'frxUSDJPY',
    displayName: 'USD/JPY',
    category: 'Forex',
    pipSize: 3,
    description: 'US Dollar / Japanese Yen',
  },
  {
    id: 'AUDUSD',
    derivSymbol: 'frxAUDUSD',
    displayName: 'AUD/USD',
    category: 'Forex',
    pipSize: 5,
    description: 'Australian Dollar / US Dollar',
  },
  {
    // Verified via Deriv `active_symbols`: underlying_symbol "frxXAUUSD",
    // market "commodities" / submarket "metals", pip_size 0.01 (2 decimals).
    id: 'XAUUSD',
    derivSymbol: 'frxXAUUSD',
    displayName: 'XAU/USD',
    category: 'Metals',
    pipSize: 2,
    description: 'Gold / US Dollar',
    market: 'commodities',
    submarket: 'metals',
    derivPipSize: 0.01,
  },
  {
    id: 'V75',
    derivSymbol: 'R_75',
    displayName: 'Volatility 75',
    category: 'Synthetics',
    pipSize: 4,
    description: 'Volatility 75 Index',
  },
  {
    id: 'V10',
    derivSymbol: 'R_10',
    displayName: 'Volatility 10',
    category: 'Synthetics',
    pipSize: 3,
    description: 'Volatility 10 Index',
  },
  {
    id: 'BOOM1000',
    derivSymbol: 'BOOM1000',
    displayName: 'Boom 1000',
    category: 'Crash/Boom',
    pipSize: 4,
    description: 'Boom 1000 Index',
  },
  {
    id: 'CRASH1000',
    derivSymbol: 'CRASH1000',
    displayName: 'Crash 1000',
    category: 'Crash/Boom',
    pipSize: 4,
    description: 'Crash 1000 Index',
  },
];

export const SYMBOL_MAP = new Map<string, DerivSymbolConfig>(
  SUPPORTED_SYMBOLS.map((s) => [s.id, s])
);

export const DERIV_TO_ID_MAP = new Map<string, string>(
  SUPPORTED_SYMBOLS.map((s) => [s.derivSymbol, s.id])
);

export function getSymbolConfig(symbolId: string): DerivSymbolConfig | undefined {
  return SYMBOL_MAP.get(symbolId);
}

/**
 * Smallest price increment for a supported instrument.
 *
 * Uses an explicit `tickSize` when configured; otherwise falls back to
 * `10^-pipSize` (one unit in the last quoted decimal). Returns `undefined` for
 * unconfigured symbols so callers never substitute a default that could distort
 * instrument-specific calculations.
 */
export function getTickSize(symbolId: string): number | undefined {
  const config = SYMBOL_MAP.get(symbolId);
  if (!config) return undefined;
  if (config.tickSize !== undefined && config.tickSize > 0) {
    return config.tickSize;
  }
  if (config.pipSize < 1) return undefined;
  return Math.pow(10, -config.pipSize);
}

/**
 * One pip unit of price for a supported instrument.
 *
 * Uses an explicit `pipValue` when configured; otherwise `10^-(pipSize - 1)`.
 *
 * - Forex majors (`pipSize` 5): `1e-4` — a conventional FX pip (4th decimal).
 * - JPY pairs (`pipSize` 3): `1e-2` — a conventional FX pip (2nd decimal).
 * - Gold (`pipSize` 2): `1e-1` — the conventional gold point/pip scale.
 * - Synthetic / Crash-Boom indices: a price-scaled unit one decimal below the quoted
 *   precision. This is NOT a broker "pip"; it is only used to express distances on a
 *   symbol-consistent scale.
 *
 * Returns `undefined` when the symbol is not configured, so callers never mistake a raw
 * price distance for a pip measurement.
 */
export function getPipValue(symbolId: string): number | undefined {
  const config = SYMBOL_MAP.get(symbolId);
  if (!config) return undefined;
  if (config.pipValue !== undefined && config.pipValue > 0) {
    return config.pipValue;
  }
  if (config.pipSize < 1) return undefined;
  return Math.pow(10, -(config.pipSize - 1));
}

/**
 * Converts a raw price distance into pip units for a supported symbol.
 *
 * Returns `undefined` for unsupported symbols (no misleading fallback). The result is not
 * rounded; consumers are responsible for display rounding. Actual price-tolerance
 * comparisons are unaffected by this helper.
 */
export function toPipUnits(symbolId: string, distance: number): number | undefined {
  const pipValue = getPipValue(symbolId);
  return pipValue === undefined ? undefined : distance / pipValue;
}

export function getSymbolIdFromDerivSymbol(derivSymbol: string): string | undefined {
  return DERIV_TO_ID_MAP.get(derivSymbol);
}
