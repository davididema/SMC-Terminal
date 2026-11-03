import { Candle, Timeframe } from '../deriv/candles';
import { MarketStructureAnalyzer, MarketStructureState } from './market-structure';
import { LiquidityAnalyzer, LiquidityState } from './liquidity';
import { FVGAnalyzer, FVGState } from './fvg';
import { OrderBlockAnalyzer, OrderBlockState } from './order-blocks';

export type PremiumDiscountZone = 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' | 'WAITING FOR DATA';

export interface SMCAnalysisResult {
  symbol: string;
  timeframe: Timeframe;
  marketStructure: MarketStructureState;
  liquidity: LiquidityState;
  fvg: FVGState;
  orderBlocks: OrderBlockState;
  zone: PremiumDiscountZone;
  analyzedAt: number;
}

/**
 * SMC Engine (Smart Money Concepts Aggregator).
 * Coordinates structure, liquidity, FVGs, and Order Blocks.
 */
export class SMCEngine {
  private structureAnalyzer = new MarketStructureAnalyzer();
  private liquidityAnalyzer = new LiquidityAnalyzer();
  private fvgAnalyzer = new FVGAnalyzer();
  private orderBlockAnalyzer = new OrderBlockAnalyzer();

  public getStructureAnalyzer(): MarketStructureAnalyzer {
    return this.structureAnalyzer;
  }

  public analyze(symbol: string, timeframe: Timeframe, candles: Candle[]): SMCAnalysisResult {
    const marketStructure = this.structureAnalyzer.analyze(symbol, timeframe, candles);
    return {
      symbol,
      timeframe,
      marketStructure,
      liquidity: this.liquidityAnalyzer.analyze(symbol, timeframe, candles, marketStructure),
      fvg: this.fvgAnalyzer.analyze(symbol, timeframe, candles),
      orderBlocks: this.orderBlockAnalyzer.analyze(symbol, timeframe, candles, marketStructure),
      zone: this.computePremiumDiscountZone(marketStructure, candles),
      analyzedAt: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Premium/discount classification relative to the latest confirmed dealing range.
   * Range endpoints are the latest confirmed swing high and swing low; equilibrium is their
   * midpoint and the middle 10% of the range is the equilibrium zone. The analysis price is the
   * close of the most recent closed candle.
   */
  private computePremiumDiscountZone(
    structure: MarketStructureState,
    candles: Candle[]
  ): PremiumDiscountZone {
    const latestHigh = structure.latestSwingHigh;
    const latestLow = structure.latestSwingLow;
    if (!latestHigh || !latestLow) {
      return 'WAITING FOR DATA';
    }

    const rangeHigh = Math.max(latestHigh.price, latestLow.price);
    const rangeLow = Math.min(latestHigh.price, latestLow.price);
    const range = rangeHigh - rangeLow;
    if (!(range > 0)) {
      return 'WAITING FOR DATA';
    }

    let lastClosed: Candle | null = null;
    for (const candle of candles) {
      if (candle.isClosed === false) continue;
      if (!lastClosed || candle.epoch > lastClosed.epoch) {
        lastClosed = candle;
      }
    }
    if (!lastClosed) {
      return 'WAITING FOR DATA';
    }

    const equilibrium = (rangeHigh + rangeLow) / 2;
    const band = 0.05 * range;
    const price = lastClosed.close;

    if (price > equilibrium + band) return 'PREMIUM';
    if (price < equilibrium - band) return 'DISCOUNT';
    return 'EQUILIBRIUM';
  }
}
