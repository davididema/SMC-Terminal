import { Candle, Timeframe } from '../deriv/candles';
import { toPipUnits } from '../deriv/symbols';
import {
  MarketStructureState,
  SwingPoint,
  getSymbolEqualityTolerance,
} from './market-structure';

export interface LiquidityLevel {
  id: string;
  price: number;
  type: 'BUY_SIDE' | 'SELL_SIDE';
  swept: boolean;
  epoch: number;
  sweptEpoch?: number;
}

export interface EqualHighLow {
  id: string;
  price: number;
  count: number;
  type: 'EQH' | 'EQL';
  tolerancePips?: number;
  epoch: number;
}

export interface LiquidityState {
  symbol: string;
  timeframe: Timeframe;
  buySideLiquidity: LiquidityLevel[];
  sellSideLiquidity: LiquidityLevel[];
  equalHighs: EqualHighLow[];
  equalLows: EqualHighLow[];
  status: 'WAITING FOR DATA' | 'ACTIVE';
}

export interface LiquidityAnalyzerOptions {
  customTolerance?: number;
}

/**
 * Liquidity analysis module (SMC).
 *
 * Rules:
 * 1. One LiquidityLevel per confirmed swing: swing high -> BUY_SIDE, swing low -> SELL_SIDE.
 * 2. Sweep-on-rejection: a level is swept when a later closed candle penetrates it by more
 *    than the symbol tolerance AND closes back on the origin side. A touch alone is not a
 *    sweep. The first qualifying candle wins and the sweep is retained.
 * 3. EQH/EQL clustering is fixed-anchor: each swing is compared only to the cluster's first
 *    member (no transitive chaining).
 */
export class LiquidityAnalyzer {
  private customTolerance?: number;

  constructor(options: LiquidityAnalyzerOptions = {}) {
    this.customTolerance = options.customTolerance;
  }

  public analyze(
    symbol: string,
    timeframe: Timeframe,
    candles: Candle[],
    structure: MarketStructureState
  ): LiquidityState {
    const closedCandles = this.filterClosed(candles);
    const swings = [...structure.swings].sort((a, b) => {
      if (a.swingCandleEpoch !== b.swingCandleEpoch) {
        return a.swingCandleEpoch - b.swingCandleEpoch;
      }
      return a.type === 'HIGH' ? -1 : 1;
    });

    const buySideLiquidity: LiquidityLevel[] = [];
    const sellSideLiquidity: LiquidityLevel[] = [];

    for (const swing of swings) {
      if (swing.type === 'HIGH') {
        const level: LiquidityLevel = {
          id: `${symbol}:${timeframe}:LIQ:BUY_SIDE:${swing.swingCandleEpoch}`,
          price: swing.price,
          type: 'BUY_SIDE',
          swept: false,
          epoch: swing.swingCandleEpoch,
        };
        this.applySweep(symbol, level, closedCandles);
        buySideLiquidity.push(level);
      } else {
        const level: LiquidityLevel = {
          id: `${symbol}:${timeframe}:LIQ:SELL_SIDE:${swing.swingCandleEpoch}`,
          price: swing.price,
          type: 'SELL_SIDE',
          swept: false,
          epoch: swing.swingCandleEpoch,
        };
        this.applySweep(symbol, level, closedCandles);
        sellSideLiquidity.push(level);
      }
    }

    const equalHighs = this.cluster(
      swings.filter((s) => s.type === 'HIGH'),
      'EQH',
      symbol,
      timeframe
    );
    const equalLows = this.cluster(
      swings.filter((s) => s.type === 'LOW'),
      'EQL',
      symbol,
      timeframe
    );

    return {
      symbol,
      timeframe,
      buySideLiquidity,
      sellSideLiquidity,
      equalHighs,
      equalLows,
      status: swings.length > 0 ? 'ACTIVE' : 'WAITING FOR DATA',
    };
  }

  private applySweep(symbol: string, level: LiquidityLevel, candles: Candle[]): void {
    const tolerance = getSymbolEqualityTolerance(symbol, level.price, this.customTolerance);
    for (const candle of candles) {
      if (candle.epoch <= level.epoch) continue;
      if (level.type === 'BUY_SIDE') {
        if (candle.high - level.price > tolerance && candle.close < level.price) {
          level.swept = true;
          level.sweptEpoch = candle.epoch;
          return;
        }
      } else {
        if (level.price - candle.low > tolerance && candle.close > level.price) {
          level.swept = true;
          level.sweptEpoch = candle.epoch;
          return;
        }
      }
    }
  }

  private cluster(
    swings: SwingPoint[],
    type: 'EQH' | 'EQL',
    symbol: string,
    timeframe: Timeframe
  ): EqualHighLow[] {
    const clusters: EqualHighLow[] = [];

    let anchorPrice: number | null = null;
    let firstEpoch = 0;
    let lastEpoch = 0;
    let count = 0;
    let extreme = 0;

    const flush = (): void => {
      if (count >= 2 && anchorPrice !== null) {
        const tolerance = getSymbolEqualityTolerance(
          symbol,
          anchorPrice,
          this.customTolerance
        );
        const tolerancePips = toPipUnits(symbol, tolerance);
        clusters.push({
          id: `${symbol}:${timeframe}:LIQ:${type}:${firstEpoch}`,
          price: extreme,
          count,
          type,
          ...(tolerancePips !== undefined ? { tolerancePips } : {}),
          epoch: lastEpoch,
        });
      }
    };

    for (const swing of swings) {
      if (anchorPrice === null) {
        anchorPrice = swing.price;
        firstEpoch = swing.swingCandleEpoch;
        lastEpoch = firstEpoch;
        count = 1;
        extreme = swing.price;
        continue;
      }

      const tolerance = getSymbolEqualityTolerance(
        symbol,
        anchorPrice,
        this.customTolerance
      );

      if (Math.abs(swing.price - anchorPrice) <= tolerance) {
        count += 1;
        lastEpoch = swing.swingCandleEpoch;
        extreme = type === 'EQH' ? Math.max(extreme, swing.price) : Math.min(extreme, swing.price);
      } else {
        flush();
        anchorPrice = swing.price;
        firstEpoch = swing.swingCandleEpoch;
        lastEpoch = firstEpoch;
        count = 1;
        extreme = swing.price;
      }
    }

    flush();
    return clusters;
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
