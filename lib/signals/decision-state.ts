/**
 * The dashboard's trading-decision state and the transitions that keep it
 * honest.
 *
 * The dashboard shows ONE decision: the result of the latest evaluation of the
 * selected pair, plus the most recent genuine signal retained for that pair.
 * Both are derived from the pair's closed-candle history, so both lose their
 * foundation the moment a discontinuity interrupts that history.
 *
 * This module owns the state as ONE value so an invalidation can never clear
 * only half of it: the displayed decision and the retained signal of the
 * affected pair are dropped together. Every transition is a pure function, so
 * the behaviour can be tested without a browser and without a socket.
 *
 * The module never decides whether a setup qualifies: it only carries the
 * engine's own evaluation output and removes it when the data it was derived
 * from was interrupted.
 */

import { TIMEFRAMES, type CandleManager, type Timeframe } from '../deriv/candles';
import type { SMCAnalysisResult } from '../analysis/smc';
import type { SignalDirection, SignalOutput } from './signal-engine';
import type { PairEvaluation } from './signal-eval';
import {
  getGeneratedSignal,
  recordGeneratedSignal,
  removeGeneratedSignal,
  signalPairKey,
} from './signal-history';

/** A pair the dashboard can evaluate and display. */
export interface PairRef {
  symbolId: string;
  timeframe: Timeframe;
}

/**
 * The dashboard's decision state.
 *
 * `analysis` / `signal` / `direction` / `evaluatedAt` describe the DISPLAYED
 * decision (the selected pair). `retained` holds the genuine signals per
 * `symbol:timeframe` that the panel may present as history.
 */
export interface DecisionState {
  analysis: SMCAnalysisResult | null;
  signal: SignalOutput | null;
  direction: SignalDirection | null;
  evaluatedAt: Date | null;
  retained: Map<string, SignalOutput>;
}

/** A state that presents nothing as a current decision. */
export function createDecisionState(): DecisionState {
  return {
    analysis: null,
    signal: null,
    direction: null,
    evaluatedAt: null,
    retained: new Map(),
  };
}

/**
 * Clears the displayed decision while keeping the retained signals.
 *
 * Used when a pair was not evaluated at all (it has no closed candles, or its
 * history must be recovered first): nothing may be presented as a current
 * decision, but the retained history of the other pairs is untouched.
 */
export function clearDecision(state: DecisionState): DecisionState {
  return {
    ...state,
    analysis: null,
    signal: null,
    direction: null,
    evaluatedAt: null,
  };
}

/**
 * Applies an evaluation result: the displayed decision becomes the result, and
 * a genuine LONG/SHORT is retained for the pair. A NO_TRADE (including
 * DUPLICATE) leaves the retained signal of the pair untouched.
 */
export function applyEvaluation(
  state: DecisionState,
  pair: PairRef,
  evaluation: PairEvaluation
): DecisionState {
  return {
    analysis: evaluation.analysis,
    signal: evaluation.signal,
    direction: evaluation.direction,
    evaluatedAt: evaluation.evaluatedAt,
    retained: recordGeneratedSignal(
      state.retained,
      signalPairKey(pair.symbolId, pair.timeframe),
      evaluation.signal
    ),
  };
}

/**
 * Invalidates the decision of one pair whose market data was interrupted.
 *
 * - The displayed decision is cleared when it belongs to the affected pair: it
 *   was derived from data that was never observed, so it must not stay on
 *   screen as a valid, current trading opportunity.
 * - The retained signal of the affected pair is dropped as well: it would
 *   otherwise repopulate the panel with the pre-discontinuity decision, and no
 *   later recovery response would remove it.
 * - Every other pair keeps its decision and its retained signal.
 */
export function invalidatePairDecision(
  state: DecisionState,
  affected: PairRef,
  displayed: PairRef
): DecisionState {
  const retained = removeGeneratedSignal(
    state.retained,
    signalPairKey(affected.symbolId, affected.timeframe)
  );
  const isDisplayed =
    affected.symbolId === displayed.symbolId && affected.timeframe === displayed.timeframe;
  if (!isDisplayed) {
    return { ...state, retained };
  }
  return {
    analysis: null,
    signal: null,
    direction: null,
    evaluatedAt: null,
    retained,
  };
}

/**
 * The pairs a discontinuity interrupted: every tracked pair whose history the
 * manager now blocks until it has been recovered. A pair that is not blocked
 * was not affected and keeps its decision.
 */
export function collectAffectedPairs(
  manager: Pick<CandleManager, 'getTrackedSymbols' | 'isRecoveryRequired'>
): PairRef[] {
  const affected: PairRef[] = [];
  for (const symbolId of manager.getTrackedSymbols()) {
    for (const timeframe of TIMEFRAMES) {
      if (manager.isRecoveryRequired(symbolId, timeframe)) {
        affected.push({ symbolId, timeframe });
      }
    }
  }
  return affected;
}

/**
 * Invalidates every decision the affected pairs produced. The affected pairs
 * are passed in (instead of read from the manager) so the transition stays a
 * pure function of its input.
 */
export function invalidateDecisionsForDiscontinuity(
  state: DecisionState,
  affectedPairs: readonly PairRef[],
  displayed: PairRef
): DecisionState {
  let next = state;
  for (const affected of affectedPairs) {
    next = invalidatePairDecision(next, affected, displayed);
  }
  return next;
}

/** The retained signal of one pair, or `null` when none is retained. */
export function getRetainedSignal(
  state: DecisionState,
  pair: PairRef
): SignalOutput | null {
  return getGeneratedSignal(state.retained, signalPairKey(pair.symbolId, pair.timeframe));
}
