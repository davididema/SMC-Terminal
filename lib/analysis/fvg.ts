import { Candle, Timeframe } from '../deriv/candles';
import { getSymbolEqualityTolerance } from './market-structure';

export interface FairValueGap {
  id: string;
  type: 'BULLISH' | 'BEARISH';
  topPrice: number;
  bottomPrice: number;
  epoch: number;
  mitigated: boolean;
  mitigationEpoch?: number;
}

export interface FVGState {
  symbol: string;
  timeframe: Timeframe;
  bullishFVGs: FairValueGap[];
  bearishFVGs: FairValueGap[];
  unmitigatedCount: number;
  status: 'WAITING FOR DATA' | 'ACTIVE';
}

export interface FVGAnalyzerOptions {
  customTolerance?: number;
}

/**
 * Fair Value Gap (FVG) analysis module (SMC).
 * Detects 3-candle imbalances over closed candles and tracks full-fill mitigation.
 *
 * Rules:
 * 1. Closed candles only, deduplicated by epoch and sorted chronologically.
 * 2. For consecutive closed candles a=i-2, b=i-1, c=i:
 *    - Bullish FVG: c.low > a.high -> [bottom = a.high, top = c.low].
 *    - Bearish FVG: c.high < a.low -> [bottom = c.high, top = a.low].
 * 3. Gaps with size <= tolerance are ignored.
 * 4. Full-fill mitigation is scanned from candle i+1 onward (the creation/confirmation
 *    candle cannot mitigate its own FVG):
 *    - Bullish mitigated when a later closed candle's low <= bottomPrice.
 *    - Bearish mitigated when a later closed candle's high >= topPrice.
 */
export class FVGAnalyzer {
  private customTolerance?: number;

  constructor(options: FVGAnalyzerOptions = {}) {
    this.customTolerance = options.customTolerance;
  }

  public analyze(symbol: string, timeframe: Timeframe, candles: Candle[]): FVGState {
    const closedCandles = this.filterClosed(candles);

    if (closedCandles.length < 3) {
      return {
        symbol,
        timeframe,
        bullishFVGs: [],
        bearishFVGs: [],
        unmitigatedCount: 0,
        status: 'WAITING FOR DATA',
      };
    }

    const bullishFVGs: FairValueGap[] = [];
    const bearishFVGs: FairValueGap[] = [];

    for (let i = 2; i < closedCandles.length; i++) {
      const a = closedCandles[i - 2];
      const c = closedCandles[i];

      if (c.low > a.high) {
        const bottomPrice = a.high;
        const topPrice = c.low;
        const tolerance = getSymbolEqualityTolerance(symbol, topPrice, this.customTolerance);
        if (topPrice - bottomPrice > tolerance) {
          const fvg: FairValueGap = {
            id: `${symbol}:${timeframe}:FVG:BULLISH:${c.epoch}`,
            type: 'BULLISH',
            topPrice,
            bottomPrice,
            epoch: c.epoch,
            mitigated: false,
          };
          this.applyMitigation(fvg, closedCandles, i + 1);
          bullishFVGs.push(fvg);
        }
      } else if (c.high < a.low) {
        const topPrice = a.low;
        const bottomPrice = c.high;
        const tolerance = getSymbolEqualityTolerance(symbol, topPrice, this.customTolerance);
        if (topPrice - bottomPrice > tolerance) {
          const fvg: FairValueGap = {
            id: `${symbol}:${timeframe}:FVG:BEARISH:${c.epoch}`,
            type: 'BEARISH',
            topPrice,
            bottomPrice,
            epoch: c.epoch,
            mitigated: false,
          };
          this.applyMitigation(fvg, closedCandles, i + 1);
          bearishFVGs.push(fvg);
        }
      }
    }

    const unmitigatedCount =
      bullishFVGs.filter((f) => !f.mitigated).length +
      bearishFVGs.filter((f) => !f.mitigated).length;

    return {
      symbol,
      timeframe,
      bullishFVGs,
      bearishFVGs,
      unmitigatedCount,
      status: 'ACTIVE',
    };
  }

  private applyMitigation(fvg: FairValueGap, candles: Candle[], startIndex: number): void {
    for (let j = startIndex; j < candles.length; j++) {
      const candle = candles[j];
      if (fvg.type === 'BULLISH' && candle.low <= fvg.bottomPrice) {
        fvg.mitigated = true;
        fvg.mitigationEpoch = candle.epoch;
        return;
      }
      if (fvg.type === 'BEARISH' && candle.high >= fvg.topPrice) {
        fvg.mitigated = true;
        fvg.mitigationEpoch = candle.epoch;
        return;
      }
    }
  }

  private filterClosed(candles: Candle[]): Candle[] {
    const epochMap = new Map<number, Candle>();
    for (const c of candles) {
      if (c.isClosed !== false) {
        epochMap.set(c.epoch, c);
      }
    }
    return Array.from(epochMap.values()).sort((a, b) => a.epoch - b.epoch);
  }
}
