import { Candle, Timeframe } from '../deriv/candles';
import { SwingPoint, StructuralBias, getSymbolEqualityTolerance } from './market-structure';

export type BreakType =
  | 'BULLISH_BOS'
  | 'BEARISH_BOS'
  | 'BULLISH_CHOCH'
  | 'BEARISH_CHOCH'
  | 'INITIAL_BULLISH_BREAK'
  | 'INITIAL_BEARISH_BREAK';

export interface StructureBreak {
  id: string; // Deterministic stable key: symbol:timeframe:type:breakCandleEpoch:brokenSwingEpoch
  type: BreakType;
  symbol: string;
  timeframe: Timeframe;
  breakCandleEpoch: number; // Timestamp of the closed candle that broke the swing
  brokenSwingEpoch: number; // Timestamp of the broken swing pivot candle
  brokenPrice: number; // Price level of the broken swing
  confirmationPrice: number; // Close price of the break candle that confirmed the break
  confirmedAtEpoch: number; // Timestamp when the break was confirmed (close epoch of break candle)
  direction: 'BULLISH' | 'BEARISH';
  sourceStructure: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export interface StructureBreakState {
  symbol: string;
  timeframe: Timeframe;
  breaks: StructureBreak[];
  latestBOS: StructureBreak | null;
  latestCHoCH: StructureBreak | null;
  protectedHigh: SwingPoint | null;
  protectedLow: SwingPoint | null;
}

export interface StructureBreakDetectorOptions {
  customTolerance?: number;
}

/**
 * Reusable, deterministic BOS (Break of Structure) & CHoCH (Change of Character) Detector.
 *
 * Rules:
 * 1. Closed Candle Confirmation:
 *    Only closed candles (isClosed !== false) can confirm a break. Wick crosses without close are rejected.
 * 2. Symbol-aware tolerance buffer:
 *    close > brokenPrice + tolerance for bullish break
 *    close < brokenPrice - tolerance for bearish break
 * 3. BOS vs CHoCH:
 *    - BULLISH_BOS: In BULLISH structure, price closes above the latest unbroken Swing High.
 *    - BEARISH_BOS: In BEARISH structure, price closes below the latest unbroken Swing Low.
 *    - BEARISH_CHOCH: In BULLISH structure, price closes below the protected Swing Low (relevant HL).
 *    - BULLISH_CHOCH: In BEARISH structure, price closes above the protected Swing High (relevant LH).
 *    - INITIAL_BULLISH_BREAK / INITIAL_BEARISH_BREAK: In NEUTRAL structure, price breaks a confirmed swing.
 * 4. Protected Swing Logic:
 *    - For bullish structure: protected low = relevant HL supporting the current bullish leg.
 *    - For bearish structure: protected high = relevant LH supporting the current bearish leg.
 * 5. Already Broken Protection:
 *    A swing level that has produced a break is consumed and cannot repeatedly emit duplicate breaks.
 * 6. Historical / Incremental Equivalence:
 *    Evaluated strictly chronologically; batch and candle-by-candle produce identical events.
 */
export class StructureBreakDetector {
  private states = new Map<string, Map<Timeframe, StructureBreakState>>();
  private customTolerance?: number;

  constructor(options: StructureBreakDetectorOptions = {}) {
    this.customTolerance = options.customTolerance;
  }

  public getState(symbol: string, timeframe: Timeframe): StructureBreakState | undefined {
    return this.states.get(symbol)?.get(timeframe);
  }

  /**
   * Detects confirmed structural breaks across closed candles using confirmed swings.
   */
  public analyze(
    symbol: string,
    timeframe: Timeframe,
    candles: Candle[],
    swings: SwingPoint[],
    initialBias: StructuralBias = 'NEUTRAL'
  ): StructureBreakState {
    // 1. Filter out unclosed / forming candles and deduplicate by epoch
    const epochMap = new Map<number, Candle>();
    for (const c of candles) {
      if (c.isClosed !== false) {
        epochMap.set(c.epoch, c);
      }
    }
    const closedCandles = Array.from(epochMap.values()).sort((a, b) => a.epoch - b.epoch);

    // 2. Sort confirmed swings by candleEpoch ASC
    const sortedSwings = [...swings].sort((a, b) => a.candleEpoch - b.candleEpoch);

    const breaks: StructureBreak[] = [];
    const breakIdSet = new Set<string>();
    const brokenSwingEpochs = new Set<string>();
    const swingKey = (s: SwingPoint): string => `${s.type}:${s.candleEpoch}`;

    let currentTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = initialBias;
    let latestBOS: StructureBreak | null = null;
    let latestCHoCH: StructureBreak | null = null;

    // Helper: Determine protected low and protected high given currently confirmed swings
    function getProtectedSwings(confirmedSwings: SwingPoint[], trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL') {
      let protLow: SwingPoint | null = null;
      let protHigh: SwingPoint | null = null;

      if (trend === 'BULLISH') {
        // Protected low: relevant HL supporting the current bullish leg.
        // We look for the most recent confirmed HL among unbroken swing lows.
        const candidateHLs = confirmedSwings.filter(
          (s) => s.type === 'LOW' && s.structureType === 'HL' && !brokenSwingEpochs.has(swingKey(s))
        );
        if (candidateHLs.length > 0) {
          protLow = candidateHLs[candidateHLs.length - 1];
        } else {
          // Fallback to most recent unbroken swing low
          const unbrokenLows = confirmedSwings.filter(
            (s) => s.type === 'LOW' && !brokenSwingEpochs.has(swingKey(s))
          );
          if (unbrokenLows.length > 0) {
            protLow = unbrokenLows[unbrokenLows.length - 1];
          }
        }
      } else if (trend === 'BEARISH') {
        // Protected high: relevant LH supporting the current bearish leg.
        const candidateLHs = confirmedSwings.filter(
          (s) => s.type === 'HIGH' && s.structureType === 'LH' && !brokenSwingEpochs.has(swingKey(s))
        );
        if (candidateLHs.length > 0) {
          protHigh = candidateLHs[candidateLHs.length - 1];
        } else {
          // Fallback to most recent unbroken swing high
          const unbrokenHighs = confirmedSwings.filter(
            (s) => s.type === 'HIGH' && !brokenSwingEpochs.has(swingKey(s))
          );
          if (unbrokenHighs.length > 0) {
            protHigh = unbrokenHighs[unbrokenHighs.length - 1];
          }
        }
      }

      return { protLow, protHigh };
    }

    // 3. Process closed candles chronologically to preserve strict causality
    for (const candle of closedCandles) {
      // Find swings that were confirmed at or before this candle's close
      const availableSwings = sortedSwings.filter(
        (s) => s.confirmedAtEpoch <= candle.epoch
      );

      if (availableSwings.length === 0) continue;

      const tolerance = getSymbolEqualityTolerance(
        symbol,
        candle.close,
        this.customTolerance
      );

      const { protLow, protHigh } = getProtectedSwings(availableSwings, currentTrend);

      // Unbroken swing highs and lows that occurred BEFORE this candle
      const availableHighs = availableSwings.filter(
        (s) => s.type === 'HIGH' && s.candleEpoch < candle.epoch && !brokenSwingEpochs.has(swingKey(s))
      );
      const availableLows = availableSwings.filter(
        (s) => s.type === 'LOW' && s.candleEpoch < candle.epoch && !brokenSwingEpochs.has(swingKey(s))
      );

      let breakOccurred = false;

      // --- CHECK BULLISH BREAKS (Close > swing level + tolerance) ---
      // In BEARISH trend: Check if breaking protected high (CHoCH)
      if (currentTrend === 'BEARISH' && protHigh && candle.close > protHigh.price + tolerance) {
        const type: BreakType = 'BULLISH_CHOCH';
        const id = `${symbol}:${timeframe}:${type}:${candle.epoch}:${protHigh.candleEpoch}`;
        if (!breakIdSet.has(id)) {
          breakIdSet.add(id);
          const breakEvent: StructureBreak = {
            id,
            type,
            symbol,
            timeframe,
            breakCandleEpoch: candle.epoch,
            brokenSwingEpoch: protHigh.candleEpoch,
            brokenPrice: protHigh.price,
            confirmationPrice: candle.close,
            confirmedAtEpoch: candle.epoch,
            direction: 'BULLISH',
            sourceStructure: currentTrend,
          };
          breaks.push(breakEvent);
          latestCHoCH = breakEvent;
          brokenSwingEpochs.add(swingKey(protHigh));
          currentTrend = 'BULLISH';
          breakOccurred = true;

          // Consume any lower unbroken highs surpassed by this candle (Section 13)
          for (const h of availableHighs) {
            if (h.price <= protHigh.price) {
              brokenSwingEpochs.add(swingKey(h));
            }
          }
        }
      } else if (availableHighs.length > 0) {
        // Nearest unbroken relevant swing high (most recent high)
        const targetHigh = availableHighs[availableHighs.length - 1];
        if (candle.close > targetHigh.price + tolerance) {
          let type: BreakType | null = null;
          if (currentTrend === 'BULLISH') {
            type = 'BULLISH_BOS';
          } else if (currentTrend === 'NEUTRAL') {
            type = 'INITIAL_BULLISH_BREAK';
          } else {
            // BEARISH trend with no protected high broken - cannot confirm CHOCH without protected level
            type = null;
          }
          if (type === null) {
            // Do not force CHoCH without required structural evidence
          } else {

          const id = `${symbol}:${timeframe}:${type}:${candle.epoch}:${targetHigh.candleEpoch}`;
          if (!breakIdSet.has(id)) {
            breakIdSet.add(id);
            const breakEvent: StructureBreak = {
              id,
              type,
              symbol,
              timeframe,
              breakCandleEpoch: candle.epoch,
              brokenSwingEpoch: targetHigh.candleEpoch,
              brokenPrice: targetHigh.price,
              confirmationPrice: candle.close,
              confirmedAtEpoch: candle.epoch,
              direction: 'BULLISH',
              sourceStructure: currentTrend,
            };
            breaks.push(breakEvent);
            if (type === 'BULLISH_BOS' || type === 'INITIAL_BULLISH_BREAK') latestBOS = breakEvent;

            brokenSwingEpochs.add(swingKey(targetHigh));
            currentTrend = 'BULLISH';
            breakOccurred = true;

            // Mark superseded lower highs broken
            for (const h of availableHighs) {
              if (h.price <= targetHigh.price) {
                brokenSwingEpochs.add(swingKey(h));
              }
            }
          }
        }
      } else if (availableHighs.length > 0 && !breakOccurred) {
        // If we reached here, means type was null (bearish trend without protected high)
        // Skip emitting break - insufficient evidence
      }
      }

      // --- CHECK BEARISH BREAKS (Close < swing level - tolerance) ---
      if (!breakOccurred) {
        // In BULLISH trend: Check if breaking protected low (CHoCH)
        if (currentTrend === 'BULLISH' && protLow && candle.close < protLow.price - tolerance) {
          const type: BreakType = 'BEARISH_CHOCH';
          const id = `${symbol}:${timeframe}:${type}:${candle.epoch}:${protLow.candleEpoch}`;
          if (!breakIdSet.has(id)) {
            breakIdSet.add(id);
            const breakEvent: StructureBreak = {
              id,
              type,
              symbol,
              timeframe,
              breakCandleEpoch: candle.epoch,
              brokenSwingEpoch: protLow.candleEpoch,
              brokenPrice: protLow.price,
              confirmationPrice: candle.close,
              confirmedAtEpoch: candle.epoch,
              direction: 'BEARISH',
              sourceStructure: currentTrend,
            };
            breaks.push(breakEvent);
            latestCHoCH = breakEvent;
            brokenSwingEpochs.add(swingKey(protLow));
            currentTrend = 'BEARISH';

            // Consume any higher unbroken lows surpassed by this candle (Section 13)
            for (const l of availableLows) {
              if (l.price >= protLow.price) {
                brokenSwingEpochs.add(swingKey(l));
              }
            }
          }
        } else if (availableLows.length > 0) {
          // Nearest unbroken relevant swing low (most recent low)
          const targetLow = availableLows[availableLows.length - 1];
          if (candle.close < targetLow.price - tolerance) {
            let type: BreakType | null = null;
            if (currentTrend === 'BEARISH') {
              type = 'BEARISH_BOS';
            } else if (currentTrend === 'NEUTRAL') {
              type = 'INITIAL_BEARISH_BREAK';
            } else {
              // BULLISH trend without protected low broken
              type = null;
            }
            if (type === null) {
              // skip
            } else {

            const id = `${symbol}:${timeframe}:${type}:${candle.epoch}:${targetLow.candleEpoch}`;
            if (!breakIdSet.has(id)) {
              breakIdSet.add(id);
              const breakEvent: StructureBreak = {
                id,
                type,
                symbol,
                timeframe,
                breakCandleEpoch: candle.epoch,
                brokenSwingEpoch: targetLow.candleEpoch,
                brokenPrice: targetLow.price,
                confirmationPrice: candle.close,
                confirmedAtEpoch: candle.epoch,
                direction: 'BEARISH',
                sourceStructure: currentTrend,
              };
              breaks.push(breakEvent);
              if (type === 'BEARISH_BOS' || type === 'INITIAL_BEARISH_BREAK') latestBOS = breakEvent;

              brokenSwingEpochs.add(swingKey(targetLow));
              currentTrend = 'BEARISH';

              // Mark superseded higher lows broken
              for (const l of availableLows) {
                if (l.price >= targetLow.price) {
                  brokenSwingEpochs.add(swingKey(l));
                }
              }
            }
          }
        } else if (availableLows.length > 0 && !breakOccurred) {
          // insufficient evidence
        }
      }
    }
    }

    // Sort breaks chronologically by breakCandleEpoch ASC
    breaks.sort((a, b) => a.breakCandleEpoch - b.breakCandleEpoch);

    // Compute final protected high and protected low
    const { protLow: finalProtLow, protHigh: finalProtHigh } = getProtectedSwings(
      sortedSwings,
      currentTrend
    );

    const state: StructureBreakState = {
      symbol,
      timeframe,
      breaks,
      latestBOS,
      latestCHoCH,
      protectedHigh: finalProtHigh,
      protectedLow: finalProtLow,
    };

    // Cache state in isolated symbol/timeframe map
    let symMap = this.states.get(symbol);
    if (!symMap) {
      symMap = new Map<Timeframe, StructureBreakState>();
      this.states.set(symbol, symMap);
    }
    symMap.set(timeframe, state);

    return state;
  }

  public clear(symbol?: string, timeframe?: Timeframe): void {
    if (symbol && timeframe) {
      this.states.get(symbol)?.delete(timeframe);
    } else if (symbol) {
      this.states.delete(symbol);
    } else {
      this.states.clear();
    }
  }
}

