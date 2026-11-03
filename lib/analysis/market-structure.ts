import { Candle, Timeframe } from '../deriv/candles';
import { getSymbolConfig, getTickSize } from '../deriv/symbols';
import {
  StructureBreak,
  BreakType,
  StructureBreakState,
  StructureBreakDetector,
} from './structure-breaks';

export type { StructureBreak, BreakType, StructureBreakState };
export { StructureBreakDetector };

export type SwingType = 'HIGH' | 'LOW';

export type StructurePointType = 'HH' | 'HL' | 'LH' | 'LL' | 'EQH' | 'EQL';

export type StructuralBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface SwingPoint {
  id: string; // Deterministic stable key: symbol:timeframe:candleEpoch:type
  symbol: string;
  timeframe: Timeframe;
  type: SwingType;
  candleEpoch: number; // Timestamp of the swing pivot candle
  swingCandleEpoch: number; // Exact timestamp alias conforming to SMC Phase 1 spec
  confirmedAtEpoch: number; // Timestamp when swing was objectively confirmed (no look-ahead bias)
  price: number;
  candleIndex: number;
  structureType: StructurePointType;
}

export interface MarketStructureState {
  symbol: string;
  timeframe: Timeframe;
  structuralBias: StructuralBias;
  swings: SwingPoint[]; // Chronologically ordered confirmed swings
  latestSwingHigh: SwingPoint | null;
  latestSwingLow: SwingPoint | null;
  latestHH: SwingPoint | null;
  latestHL: SwingPoint | null;
  latestLH: SwingPoint | null;
  latestLL: SwingPoint | null;
  latestEQH: SwingPoint | null;
  latestEQL: SwingPoint | null;
  recentStructureSequence: StructurePointType[]; // Recent sequence, e.g. ['HL', 'HH', 'HL', 'HH']
  lastAnalyzedEpoch: number;
  // Phase 2: BOS & CHoCH Break Properties
  breaks: StructureBreak[];
  latestBOS: StructureBreak | null;
  latestCHoCH: StructureBreak | null;
  protectedHigh: SwingPoint | null;
  protectedLow: SwingPoint | null;
}

export interface SwingDetectorOptions {
  leftBars?: number;
  rightBars?: number;
  customTolerance?: number;
}

/**
 * Symbol-aware tolerance calculator for Equal Highs (EQH) and Equal Lows (EQL).
 * Adapts to pip sizes across Forex (EURUSD, GBPUSD, USDJPY, AUDUSD),
 * Synthetics (V75, V10), and Crash/Boom (BOOM1000, CRASH1000).
 */
export function getSymbolEqualityTolerance(
  symbolId: string,
  price: number,
  customTolerance?: number
): number {
  if (customTolerance !== undefined && customTolerance >= 0) {
    return customTolerance;
  }
  const config = getSymbolConfig(symbolId);
  if (!config) {
    // Default fallback: 0.02% of price
    return price * 0.0002;
  }
  const tickSize = getTickSize(symbolId) ?? Math.pow(10, -config.pipSize);
  // Tolerates within 3 ticks or 0.015% of price, whichever is appropriate
  return Math.max(3 * tickSize, price * 0.00015);
}

/**
 * Classifies a new swing high relative to the previous swing high.
 * - new high > previous high (beyond tolerance) -> HH
 * - new high < previous high (beyond tolerance) -> LH
 * - price difference <= tolerance -> EQH
 */
export function classifySwingHigh(
  newHigh: number,
  previousHigh: number | null,
  tolerance = 0
): StructurePointType {
  if (previousHigh === null) {
    return 'HH';
  }
  const diff = newHigh - previousHigh;
  if (Math.abs(diff) <= tolerance) {
    return 'EQH';
  }
  return newHigh > previousHigh ? 'HH' : 'LH';
}

/**
 * Classifies a new swing low relative to the previous swing low.
 * - new low > previous low (beyond tolerance) -> HL
 * - new low < previous low (beyond tolerance) -> LL
 * - price difference <= tolerance -> EQL
 */
export function classifySwingLow(
  newLow: number,
  previousLow: number | null,
  tolerance = 0
): StructurePointType {
  if (previousLow === null) {
    return 'LL';
  }
  const diff = newLow - previousLow;
  if (Math.abs(diff) <= tolerance) {
    return 'EQL';
  }
  return newLow > previousLow ? 'HL' : 'LL';
}

/**
 * Evaluates high-level structural bias from the sequence of confirmed structure points.
 *
 * Deterministic Rules:
 * 1. BULLISH:
 *    - Dual confirmation: latest high is HH and latest low is HL.
 *    - OR latest confirmed swing point is HH (bullish expansion).
 *    - OR latest confirmed swing point is HL following a prior HH without an intervening LH.
 * 2. BEARISH:
 *    - Dual confirmation: latest high is LH and latest low is LL.
 *    - OR latest confirmed swing point is LL (bearish expansion).
 *    - OR latest confirmed swing point is LH following a prior LL without an intervening HL.
 * 3. NEUTRAL:
 *    - Consolidating structure (EQH/EQL), mixed non-conforming signals, or insufficient swings (< 2 swings).
 */
export function evaluateStructuralBias(swings: SwingPoint[]): StructuralBias {
  if (swings.length < 2) {
    return 'NEUTRAL';
  }

  const latestHigh = [...swings].reverse().find((s) => s.type === 'HIGH');
  const latestLow = [...swings].reverse().find((s) => s.type === 'LOW');

  if (!latestHigh || !latestLow) {
    return 'NEUTRAL';
  }

  // Dual confirmation
  if (latestHigh.structureType === 'HH' && latestLow.structureType === 'HL') {
    return 'BULLISH';
  }
  if (latestHigh.structureType === 'LH' && latestLow.structureType === 'LL') {
    return 'BEARISH';
  }

  // Recency momentum
  const mostRecent = swings[swings.length - 1];
  if (mostRecent.structureType === 'HH') {
    return 'BULLISH';
  }
  if (mostRecent.structureType === 'LL') {
    return 'BEARISH';
  }
  if (mostRecent.structureType === 'HL' && latestHigh.structureType !== 'LH') {
    return 'BULLISH';
  }
  if (mostRecent.structureType === 'LH' && latestLow.structureType !== 'HL') {
    return 'BEARISH';
  }

  return 'NEUTRAL';
}

/**
 * Reusable, deterministic Market Structure & Swing Detection Engine.
 * Logically isolated per symbol and timeframe.
 */
export class MarketStructureAnalyzer {
  private states = new Map<string, Map<Timeframe, MarketStructureState>>();
  private leftBars: number;
  private rightBars: number;
  private customTolerance?: number;
  private breakDetector: StructureBreakDetector;

  constructor(options: SwingDetectorOptions = {}) {
    this.leftBars = options.leftBars ?? 2;
    this.rightBars = options.rightBars ?? 2;
    this.customTolerance = options.customTolerance;
    this.breakDetector = new StructureBreakDetector({ customTolerance: options.customTolerance });
  }

  public getBreakDetector(): StructureBreakDetector {
    return this.breakDetector;
  }

  /**
   * Get cached structure state for a specific symbol and timeframe.
   */
  public getState(symbol: string, timeframe: Timeframe): MarketStructureState | undefined {
    return this.states.get(symbol)?.get(timeframe);
  }

  /**
   * Analyze candles for a symbol and timeframe.
   * Only uses closed candles. Current forming candle is ignored to prevent repainting.
   */
  public analyze(
    symbol: string,
    timeframe: Timeframe,
    candles: Candle[]
  ): MarketStructureState {
    // 1. Filter out unclosed / forming candle to prevent repainting and deduplicate by epoch
    const epochMap = new Map<number, Candle>();
    for (const c of candles) {
      if (c.isClosed !== false) {
        epochMap.set(c.epoch, c);
      }
    }
    const closedCandles = Array.from(epochMap.values()).sort((a, b) => a.epoch - b.epoch);

    const swings: SwingPoint[] = [];
    const swingIdSet = new Set<string>();

    let lastHigh: SwingPoint | null = null;
    let lastLow: SwingPoint | null = null;
    let latestHH: SwingPoint | null = null;
    let latestHL: SwingPoint | null = null;
    let latestLH: SwingPoint | null = null;
    let latestLL: SwingPoint | null = null;
    let latestEQH: SwingPoint | null = null;
    let latestEQL: SwingPoint | null = null;

    // 2. Pivot Fractal Detection (leftBars = 2, rightBars = 2)
    // Candle candidate at index i is confirmed ONLY when i + rightBars has closed.
    const n = closedCandles.length;
    for (let i = this.leftBars; i < n - this.rightBars; i++) {
      const candidate = closedCandles[i];
      const confirmedAtBar = closedCandles[i + this.rightBars];
      const confirmedAtEpoch = confirmedAtBar.epoch;

      // Check Swing High: candidate.high > left 2 bars AND candidate.high > right 2 bars
      let isHigh = true;
      for (let l = 1; l <= this.leftBars; l++) {
        if (candidate.high <= closedCandles[i - l].high) {
          isHigh = false;
          break;
        }
      }
      if (isHigh) {
        for (let r = 1; r <= this.rightBars; r++) {
          if (candidate.high <= closedCandles[i + r].high) {
            isHigh = false;
            break;
          }
        }
      }

      // Check Swing Low: candidate.low < left 2 bars AND candidate.low < right 2 bars
      let isLow = true;
      for (let l = 1; l <= this.leftBars; l++) {
        if (candidate.low >= closedCandles[i - l].low) {
          isLow = false;
          break;
        }
      }
      if (isLow) {
        for (let r = 1; r <= this.rightBars; r++) {
          if (candidate.low >= closedCandles[i + r].low) {
            isLow = false;
            break;
          }
        }
      }

      // 3. Process Confirmed Swing High
      if (isHigh) {
        const id = `${symbol}:${timeframe}:${candidate.epoch}:HIGH`;
        if (!swingIdSet.has(id)) {
          swingIdSet.add(id);

          const tolerance = getSymbolEqualityTolerance(
            symbol,
            candidate.high,
            this.customTolerance
          );

          const structureType = classifySwingHigh(
            candidate.high,
            lastHigh ? lastHigh.price : null,
            tolerance
          );

          const point: SwingPoint = {
            id,
            symbol,
            timeframe,
            type: 'HIGH',
            candleEpoch: candidate.epoch,
            swingCandleEpoch: candidate.epoch,
            confirmedAtEpoch,
            price: candidate.high,
            candleIndex: i,
            structureType,
          };

          swings.push(point);
          lastHigh = point;

          if (structureType === 'HH') latestHH = point;
          else if (structureType === 'LH') latestLH = point;
          else if (structureType === 'EQH') latestEQH = point;
        }
      }

      // 4. Process Confirmed Swing Low
      if (isLow) {
        const id = `${symbol}:${timeframe}:${candidate.epoch}:LOW`;
        if (!swingIdSet.has(id)) {
          swingIdSet.add(id);

          const tolerance = getSymbolEqualityTolerance(
            symbol,
            candidate.low,
            this.customTolerance
          );

          const structureType = classifySwingLow(
            candidate.low,
            lastLow ? lastLow.price : null,
            tolerance
          );

          const point: SwingPoint = {
            id,
            symbol,
            timeframe,
            type: 'LOW',
            candleEpoch: candidate.epoch,
            swingCandleEpoch: candidate.epoch,
            confirmedAtEpoch,
            price: candidate.low,
            candleIndex: i,
            structureType,
          };

          swings.push(point);
          lastLow = point;

          if (structureType === 'HL') latestHL = point;
          else if (structureType === 'LL') latestLL = point;
          else if (structureType === 'EQL') latestEQL = point;
        }
      }
    }

    // 5. Sort swings strictly by candleEpoch ASC (with secondary stable sort for tie-breakers)
    swings.sort((a, b) => {
      if (a.candleEpoch !== b.candleEpoch) {
        return a.candleEpoch - b.candleEpoch;
      }
      return a.type === 'HIGH' ? -1 : 1;
    });

    // 6. Build Recent Structure Sequence
    const recentStructureSequence = swings.slice(-6).map((s) => s.structureType);

    // 7. Evaluate Structural Bias (final, for reporting)
    const structuralBias = evaluateStructuralBias(swings);

    // 8. Analyze BOS & CHoCH Structure Breaks (Phase 2).
    // Analysis always starts NEUTRAL; the detector's trend then evolves only from
    // confirmed structural breaks, so no future information is used.
    const breakState = this.breakDetector.analyze(
      symbol,
      timeframe,
      closedCandles,
      swings,
      'NEUTRAL'
    );

    const state: MarketStructureState = {
      symbol,
      timeframe,
      structuralBias,
      swings,
      latestSwingHigh: lastHigh,
      latestSwingLow: lastLow,
      latestHH,
      latestHL,
      latestLH,
      latestLL,
      latestEQH,
      latestEQL,
      recentStructureSequence,
      lastAnalyzedEpoch: closedCandles[closedCandles.length - 1]?.epoch ?? 0,
      breaks: breakState.breaks,
      latestBOS: breakState.latestBOS,
      latestCHoCH: breakState.latestCHoCH,
      protectedHigh: breakState.protectedHigh,
      protectedLow: breakState.protectedLow,
    };

    // 9. Cache in isolated symbol/timeframe map
    let symMap = this.states.get(symbol);
    if (!symMap) {
      symMap = new Map<Timeframe, MarketStructureState>();
      this.states.set(symbol, symMap);
    }
    symMap.set(timeframe, state);

    return state;
  }

  /**
   * Clear state. If symbol and timeframe are provided, clears that combination.
   * If only symbol is provided, clears all timeframes for that symbol.
   * If neither is provided, clears all states.
   */
  public clear(symbol?: string, timeframe?: Timeframe): void {
    this.breakDetector.clear(symbol, timeframe);
    if (symbol && timeframe) {
      this.states.get(symbol)?.delete(timeframe);
    } else if (symbol) {
      this.states.delete(symbol);
    } else {
      this.states.clear();
    }
  }
}