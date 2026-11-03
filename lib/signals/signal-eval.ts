/**
 * Dashboard glue that produces an honest Trade Signal panel state for a
 * (symbol, timeframe) pair from the in-memory closed-candle history.
 *
 * This is the SINGLE evaluation entry point for the dashboard: on historical
 * backfill completion, symbol/timeframe switching, and candle close. It exists
 * so the panel can never display a stale signal from a previous selection, and
 * so it distinguishes "no evaluation yet" (no closed candles) from a genuine
 * rejected (NO_TRADE) or approved (LONG/SHORT) outcome. It never fabricates
 * candles, prices, zones, sweeps, confidence, or setups.
 */

import { CandleManager, Timeframe } from '../deriv/candles';
import { SMCEngine, SMCAnalysisResult } from '../analysis/smc';
import {
  SignalEngine,
  SignalOutput,
  SignalDirection,
  resolveTrigger,
  DEFAULT_SIGNAL_ENGINE_CONFIG,
} from './signal-engine';
import { SignalDiagnostics } from './signal-diagnostics';

export interface PairEvaluation {
  analysis: SMCAnalysisResult;
  /**
   * `null` ⟺ the pair has no closed candles yet (nothing to evaluate). A
   * rejected evaluation is a real `SignalOutput` with `decision: 'NO_TRADE'`.
   */
  signal: SignalOutput | null;
  /**
   * Intended trade direction when a directional context was actually resolved
   * (including rejections that occur after context, e.g. ZONE_MISALIGNED).
   * `null` when no direction was determined.
   */
  direction: SignalDirection | null;
  /** Wall-clock time of this evaluation; `null` when nothing was evaluated. */
  evaluatedAt: Date | null;
  closedCandleCount: number;
}

/**
 * Evaluate a pair from its closed-candle history. When the pair has no closed
 * candles, the signal/direction/evaluatedAt are cleared (`null`) rather than
 * leaving a previous selection's signal on screen. Time-to-evaluate uses the
 * exact same inputs as `SignalEngine.evaluate` (same analysis, same last closed
 * candle's epoch), so the reported resolution matches the engine's gates.
 */
export function evaluateSignalForPair(
  candleManager: Pick<CandleManager, 'getHistory'>,
  smcEngine: SMCEngine,
  signalEngine: SignalEngine,
  symbolId: string,
  timeframe: Timeframe,
  diagnostics?: SignalDiagnostics
): PairEvaluation {
  const closed = candleManager.getHistory(symbolId, timeframe);
  const analysis = smcEngine.analyze(symbolId, timeframe, closed);

  if (closed.length === 0) {
    // Reliable "skipped" signal: an evaluation was attempted but there were no
    // closed candles to evaluate. This is NOT counted as a completed NO_TRADE.
    if (diagnostics) {
      diagnostics.incrementSkippedEvaluation(symbolId, timeframe);
    }
    return {
      analysis,
      signal: null,
      direction: null,
      evaluatedAt: null,
      closedCandleCount: 0,
    };
  }

  const lastClosed = closed[closed.length - 1];
  const signal = signalEngine.evaluate(analysis, { lastClosedCandle: lastClosed });
  const triggerRes = resolveTrigger(
    analysis.marketStructure.breaks,
    analysis.marketStructure.structuralBias,
    lastClosed.epoch,
    timeframe,
    DEFAULT_SIGNAL_ENGINE_CONFIG
  );

  const evaluatedAt = new Date();
  const evaluation: PairEvaluation = {
    analysis,
    signal,
    direction: triggerRes.direction,
    evaluatedAt,
    closedCandleCount: closed.length,
  };

  if (diagnostics) {
    diagnostics.incrementCompletedEvaluation({
      symbolId,
      timeframe,
      signal,
      evaluatedAt,
      skipped: false,
    });
  }

  return evaluation;
}