import { Candle, Timeframe } from '../deriv/candles';
import { toPipUnits } from '../deriv/symbols';
import { BreakType } from './structure-breaks';
import {
  MarketStructureState,
  SwingPoint,
} from './market-structure';

export interface OrderBlock {
  id: string;
  type: 'BULLISH' | 'BEARISH';
  high: number;
  low: number;
  epoch: number;
  mitigated: boolean;
  refinedPips?: number;
  invalidated: boolean;
  mitigationEpoch?: number;
  invalidatedEpoch?: number;
}

export interface OrderBlockState {
  symbol: string;
  timeframe: Timeframe;
  bullishOrderBlocks: OrderBlock[];
  bearishOrderBlocks: OrderBlock[];
  status: 'WAITING FOR DATA' | 'ACTIVE';
}

export interface OrderBlockAnalyzerOptions {
  customTolerance?: number;
}

const W_MAX = 20;

const OB_TYPES: ReadonlySet<BreakType> = new Set<BreakType>([
  'BULLISH_BOS',
  'BULLISH_CHOCH',
  'BEARISH_BOS',
  'BEARISH_CHOCH',
]);

/**
 * Order Blocks analysis module (SMC).
 *
 * Rules:
 * 1. A bullish OB is the nearest preceding bearish (close < open) closed candle before a
 *    BULLISH_BOS / BULLISH_CHOCH; bearish OB is the nearest preceding bullish candle before a
 *    BEARISH_BOS / BEARISH_CHOCH.
 * 2. The search window is bounded below by the most recent origin swing (swing low for bullish,
 *    swing high for bearish). When no origin swing exists, at most W_MAX = 20 preceding
 *    eligible closed candles are examined.
 * 3. Mitigation (touch/return) and invalidation (close-through) are independent flags. Invariant:
 *    invalidated === true implies mitigated === true.
 */
export class OrderBlockAnalyzer {
  private customTolerance?: number;

  constructor(options: OrderBlockAnalyzerOptions = {}) {
    this.customTolerance = options.customTolerance;
  }

  public analyze(
    symbol: string,
    timeframe: Timeframe,
    candles: Candle[],
    structure: MarketStructureState
  ): OrderBlockState {
    const closedCandles = this.filterClosed(candles);
    const swings = [...structure.swings].sort(
      (a, b) => a.swingCandleEpoch - b.swingCandleEpoch
    );
    const breaks = [...structure.breaks].sort(
      (a, b) => a.breakCandleEpoch - b.breakCandleEpoch
    );

    const bullishOrderBlocks: OrderBlock[] = [];
    const bearishOrderBlocks: OrderBlock[] = [];
    const seen = new Set<string>();

    for (const breakEvent of breaks) {
      if (!OB_TYPES.has(breakEvent.type)) continue;

      const isBullish = breakEvent.direction === 'BULLISH';
      const breakIndex = closedCandles.findIndex(
        (c) => c.epoch === breakEvent.breakCandleEpoch
      );
      if (breakIndex < 0) continue;

      const sourceIndex = this.findSourceIndex(
        closedCandles,
        swings,
        breakIndex,
        breakEvent.breakCandleEpoch,
        isBullish
      );
      if (sourceIndex < 0) continue;

      const source = closedCandles[sourceIndex];
      const type: OrderBlock['type'] = isBullish ? 'BULLISH' : 'BEARISH';
      const dedupeKey = `${type}:${source.epoch}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const refinedPips = toPipUnits(symbol, source.high - source.low);
      const ob: OrderBlock = {
        id: `${symbol}:${timeframe}:OB:${type}:${source.epoch}`,
        type,
        high: source.high,
        low: source.low,
        epoch: source.epoch,
        mitigated: false,
        invalidated: false,
        ...(refinedPips !== undefined ? { refinedPips } : {}),
      };

      this.applyLifecycle(ob, closedCandles, sourceIndex + 1);

      if (type === 'BULLISH') {
        bullishOrderBlocks.push(ob);
      } else {
        bearishOrderBlocks.push(ob);
      }
    }

    bullishOrderBlocks.sort((a, b) => a.epoch - b.epoch);
    bearishOrderBlocks.sort((a, b) => a.epoch - b.epoch);

    return {
      symbol,
      timeframe,
      bullishOrderBlocks,
      bearishOrderBlocks,
      status: breaks.length > 0 ? 'ACTIVE' : 'WAITING FOR DATA',
    };
  }

  private findSourceIndex(
    candles: Candle[],
    swings: SwingPoint[],
    breakIndex: number,
    breakCandleEpoch: number,
    isBullish: boolean
  ): number {
    const origin = this.findOriginSwing(swings, breakCandleEpoch, isBullish);
    let lowerIndex: number;

    if (origin) {
      const originIndex = candles.findIndex((c) => c.epoch === origin.swingCandleEpoch);
      lowerIndex = originIndex >= 0 ? originIndex : Math.max(0, breakIndex - W_MAX);
    } else {
      lowerIndex = Math.max(0, breakIndex - W_MAX);
    }

    for (let j = breakIndex - 1; j >= lowerIndex; j--) {
      const candle = candles[j];
      const isBearishCandle = candle.close < candle.open;
      const isBullishCandle = candle.close > candle.open;
      if (isBullish && isBearishCandle) return j;
      if (!isBullish && isBullishCandle) return j;
    }

    return -1;
  }

  private findOriginSwing(
    swings: SwingPoint[],
    breakCandleEpoch: number,
    isBullish: boolean
  ): SwingPoint | null {
    let origin: SwingPoint | null = null;
    for (const swing of swings) {
      if (swing.swingCandleEpoch > breakCandleEpoch) break;
      if (isBullish && swing.type === 'LOW') origin = swing;
      if (!isBullish && swing.type === 'HIGH') origin = swing;
    }
    return origin;
  }

  private applyLifecycle(ob: OrderBlock, candles: Candle[], startIndex: number): void {
    for (let j = startIndex; j < candles.length; j++) {
      const candle = candles[j];

      if (ob.type === 'BULLISH') {
        if (candle.low <= ob.high) {
          if (!ob.mitigated) {
            ob.mitigated = true;
            ob.mitigationEpoch = candle.epoch;
          }
        }
        if (candle.close < ob.low) {
          if (!ob.invalidated) {
            ob.invalidated = true;
            ob.invalidatedEpoch = candle.epoch;
            if (!ob.mitigated) {
              ob.mitigated = true;
              ob.mitigationEpoch = candle.epoch;
            }
          }
        }
      } else {
        if (candle.high >= ob.low) {
          if (!ob.mitigated) {
            ob.mitigated = true;
            ob.mitigationEpoch = candle.epoch;
          }
        }
        if (candle.close > ob.high) {
          if (!ob.invalidated) {
            ob.invalidated = true;
            ob.invalidatedEpoch = candle.epoch;
            if (!ob.mitigated) {
              ob.mitigated = true;
              ob.mitigationEpoch = candle.epoch;
            }
          }
        }
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
