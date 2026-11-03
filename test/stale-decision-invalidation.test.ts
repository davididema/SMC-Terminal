/**
 * Phase 3A — D7: a discontinuity must invalidate the displayed decision
 * immediately.
 *
 * The confirmed defect: when the connection dropped, the dashboard marked every
 * tracked symbol as interrupted but left the previously displayed decision on
 * screen, and the signal it had generated stayed retained as the pair's "last
 * generated signal". The old decision therefore remained visible - and the
 * panel could even be repopulated from the retained signal - while the pair's
 * history was still unrecovered, so an outdated decision looked like a current
 * trading opportunity.
 *
 * These tests drive the dashboard's own decision-state transitions
 * (`lib/signals/decision-state.ts`) against the real candle manager, the real
 * recovery path and the real signal pipeline, and they render the real signal
 * panel. No socket, no network, no fabricated market data: the candles are
 * deterministic fixtures whose only purpose is to describe periods, and the
 * genuine LONG comes from the real signal engine over the project's
 * established constructed analysis.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  CandleManager,
  type Candle,
  type TickData,
  type Timeframe,
} from '../lib/deriv/candles';
import {
  applyHistoryResponse,
  type HistoryResponseApplication,
} from '../lib/deriv/history-recovery';
import type { HistoryCandleData } from '../lib/deriv/history-requests';
import { SMCEngine } from '../lib/analysis/smc';
import { SignalEngine, type SignalOutput } from '../lib/signals/signal-engine';
import { evaluateSignalForPair, type PairEvaluation } from '../lib/signals/signal-eval';
import {
  applyEvaluation,
  clearDecision,
  collectAffectedPairs,
  createDecisionState,
  getRetainedSignal,
  invalidateDecisionsForDiscontinuity,
  invalidatePairDecision,
  type DecisionState,
  type PairRef,
} from '../lib/signals/decision-state';
import { SignalPanel } from '../components/SignalPanel';
import {
  constructedLongSignal,
  genuineLongAnalysis,
} from './signal-replay-harness';

const EURUSD = 'EURUSD';
const GBPUSD = 'GBPUSD';
const MINUTE = 60;

/** The epoch of the genuine LONG the constructed analysis confirms. */
const LONG_EPOCH = 1750000000;

/** A deterministic closed 1m candle for one period. */
function historyCandle(epoch: number, close = 1.1): HistoryCandleData {
  return { epoch, open: close, high: close, low: close, close };
}

/** A deterministic closed-candle series, one period apart. */
function series(firstEpoch: number, count: number, close = 1.1): HistoryCandleData[] {
  const out: HistoryCandleData[] = [];
  for (let i = 0; i < count; i++) out.push(historyCandle(firstEpoch + i * MINUTE, close));
  return out;
}

function tick(symbol: string, price: number, epoch: number): TickData {
  return { symbol, derivSymbol: symbol, price, epoch };
}

/**
 * The dashboard's decision state and the operations the dashboard performs on
 * it. Every step uses the production transitions of
 * `lib/signals/decision-state.ts`; only the React state updates of the page
 * are replaced by plain assignments, because the project has no interactive
 * React test harness (and no dependency may be added for one).
 */
class Dashboard {
  public state: DecisionState = createDecisionState();
  public readonly manager = new CandleManager();
  public displayed: PairRef;

  private readonly smc = new SMCEngine();
  private readonly signalEngine = new SignalEngine();

  constructor(displayed: PairRef) {
    this.displayed = displayed;
  }

  /** The dashboard's evaluation path (app/dashboard/page.tsx). */
  public evaluate(symbolId: string, timeframe: Timeframe): PairEvaluation | null {
    // The dashboard only ever evaluates the selected pair.
    if (!this.isDisplayed(symbolId, timeframe)) return null;
    if (this.manager.isRecoveryRequired(symbolId, timeframe)) {
      this.state = clearDecision(this.state);
      return null;
    }
    const result = evaluateSignalForPair(
      this.manager,
      this.smc,
      this.signalEngine,
      symbolId,
      timeframe
    );
    this.state = applyEvaluation(this.state, { symbolId, timeframe }, result);
    return result;
  }

  /**
   * The dashboard's discontinuity path (app/dashboard/page.tsx): the tracked
   * symbols are marked as interrupted and the affected decisions are
   * invalidated immediately.
   */
  public disconnect(symbolIds?: string[]): void {
    for (const symbolId of symbolIds ?? this.manager.getTrackedSymbols()) {
      this.manager.markDiscontinuity(symbolId);
    }
    const affected = collectAffectedPairs(this.manager);
    this.state = invalidateDecisionsForDiscontinuity(this.state, affected, this.displayed);
  }

  /** The dashboard's history-response path (app/dashboard/page.tsx). */
  public deliverHistory(
    symbolId: string,
    timeframe: Timeframe,
    candles: HistoryCandleData[]
  ): HistoryResponseApplication {
    const applied = applyHistoryResponse({
      manager: this.manager,
      controller: null,
      symbol: symbolId,
      timeframe,
      candles,
    });
    this.evaluate(symbolId, timeframe);
    return applied;
  }

  /** The retained signal the panel would show for a pair. */
  public retained(symbolId: string, timeframe: Timeframe): SignalOutput | null {
    return getRetainedSignal(this.state, { symbolId, timeframe });
  }

  /** The props the dashboard passes to the signal panel. */
  public panelProps(): Record<string, unknown> {
    return {
      signal: this.state.signal,
      lastGeneratedSignal: this.retained(this.displayed.symbolId, this.displayed.timeframe),
      symbolId: this.displayed.symbolId,
      displayName: 'EUR/USD',
      timeframe: this.displayed.timeframe,
      marketBias: this.state.analysis?.marketStructure?.structuralBias ?? null,
      region: this.state.analysis?.zone ?? null,
      direction: this.state.direction,
      evaluatedAt: this.state.evaluatedAt,
      hasClosedCandles: true,
      feedState: 'LIVE',
      lastClosedCandleEpoch: null,
    };
  }

  /** The rendered signal panel, exactly as the dashboard renders it. */
  public renderPanel(): string {
    return renderToStaticMarkup(React.createElement(SignalPanel, this.panelProps()));
  }

  private isDisplayed(symbolId: string, timeframe: Timeframe): boolean {
    return (
      symbolId === this.displayed.symbolId && timeframe === this.displayed.timeframe
    );
  }
}

/**
 * A genuine LONG, produced by the real signal engine over the project's
 * established constructed analysis, and the evaluation the dashboard would
 * display for it.
 */
function genuineLongEvaluation(symbolId: string, timeframe: Timeframe): PairEvaluation {
  const analysis = genuineLongAnalysis(symbolId, timeframe, LONG_EPOCH);
  const signal = constructedLongSignal(symbolId, timeframe, LONG_EPOCH, 1.1);
  return {
    analysis,
    signal,
    direction: 'BULLISH',
    evaluatedAt: new Date('2026-01-01T00:00:00.000Z'),
    closedCandleCount: 30,
  };
}

/** A dashboard whose pair holds a seeded history and a displayed decision. */
function dashboardWithDecision(
  symbolId = EURUSD,
  timeframe: Timeframe = '1m'
): Dashboard {
  const dash = new Dashboard({ symbolId, timeframe });
  dash.manager.seedHistory(symbolId, timeframe, series(60, 30));
  // A live tick gives the pair a live edge (and a forming candle).
  dash.manager.processTick(tick(symbolId, 1.1, 60 + 30 * MINUTE));
  dash.state = applyEvaluation(
    dash.state,
    { symbolId, timeframe },
    genuineLongEvaluation(symbolId, timeframe)
  );
  return dash;
}

// =============================================================================================
// A — The displayed decision is invalidated immediately
// =============================================================================================

test('D7 A — a discontinuity invalidates the displayed decision immediately', () => {
  const dash = dashboardWithDecision();

  // Precondition: a genuine decision is on screen.
  assert.equal(dash.state.signal?.decision, 'LONG');
  assert.ok(dash.state.evaluatedAt instanceof Date);
  assert.match(dash.renderPanel(), /LONG/);

  // The market data is interrupted.
  dash.disconnect();

  // The decision is invalid NOW - without waiting for the next evaluation.
  assert.equal(dash.state.signal, null, 'the displayed signal is invalidated');
  assert.equal(dash.state.direction, null, 'the displayed direction is invalidated');
  assert.equal(dash.state.evaluatedAt, null, 'the evaluation timestamp is invalidated');
  assert.equal(dash.state.analysis, null, 'the analysis behind it is invalidated');

  const html = dash.renderPanel();
  assert.doesNotMatch(html, /LONG/, 'no stale decision is shown');
  assert.doesNotMatch(html, /1\.0983/, 'no stale stop loss is shown');
  assert.doesNotMatch(html, /1\.105/, 'no stale take profit is shown');
});

test('D7 A — the invalidation happens without any signal evaluation', () => {
  const dash = dashboardWithDecision();
  const evaluationsBefore = dash.state.evaluatedAt;

  dash.disconnect();

  assert.notEqual(dash.state.evaluatedAt, evaluationsBefore);
  assert.equal(dash.state.evaluatedAt, null, 'no evaluation produced the invalidation');
  assert.equal(dash.manager.isRecoveryRequired(EURUSD, '1m'), true, 'the pair is blocked');
});

// =============================================================================================
// B — A retained signal cannot repopulate the panel
// =============================================================================================

test('D7 B — the retained signal of the affected pair is dropped with the decision', () => {
  const dash = dashboardWithDecision();

  // Precondition: the genuine LONG is retained for its pair, and the panel
  // actually renders the historical retained-signal block. This positive
  // control proves the negative assertion below is non-vacuous: the same
  // markup check fails while the retained signal is present.
  assert.equal(dash.retained(EURUSD, '1m')?.decision, 'LONG');
  const beforeHtml = dash.renderPanel();
  assert.match(beforeHtml, /LAST GENERATED SIGNAL/, 'the historical block is rendered');
  assert.match(
    beforeHtml,
    /Direction:<\/span><span[^>]*>LONG<\/span>/,
    'the retained LONG is shown as a historical direction'
  );
  assert.doesNotMatch(
    beforeHtml,
    /No signal has been generated for this pair yet\./,
    'the historical block is not empty while a signal is retained'
  );

  dash.disconnect();

  // The retained signal is gone: it cannot repopulate the panel.
  assert.equal(dash.retained(EURUSD, '1m'), null, 'the retained signal is dropped');
  const html = dash.renderPanel();
  assert.doesNotMatch(html, /LONG/, 'the panel is not repopulated by the retained signal');
  assert.doesNotMatch(html, /1\.0983/, 'no stale stop loss is shown');
  // The historical block still renders (the panel always shows it), but it must
  // now present the empty state - no historical Direction row and the explicit
  // "no signal yet" note - so the dropped decision cannot reappear as history.
  assert.doesNotMatch(
    html,
    /Direction:<\/span><span[^>]*>(LONG|SHORT)<\/span>/,
    'no historical direction entry is shown'
  );
  assert.doesNotMatch(html, /1\.105/, 'no stale historical take profit is shown');
  assert.match(
    html,
    /LAST GENERATED SIGNAL[\s\S]*No signal has been generated for this pair yet\./,
    'the historical block shows the empty state instead of the retained signal'
  );
});

// =============================================================================================
// C — The decision stays invalid while the recovery is pending
// =============================================================================================

test('D7 C — the decision stays invalidated while the recovery is pending', () => {
  const dash = dashboardWithDecision();

  dash.disconnect();
  assert.equal(dash.manager.isRecoveryRequired(EURUSD, '1m'), true);

  // The recovery is pending: the pair is blocked, so the evaluation path
  // refuses to evaluate it and clears the decision instead.
  for (let attempt = 0; attempt < 3; attempt++) {
    const evaluation = dash.evaluate(EURUSD, '1m');
    assert.equal(evaluation, null, 'a blocked pair is never evaluated');
    assert.equal(dash.state.signal, null, 'the decision stays invalidated');
    assert.equal(dash.state.evaluatedAt, null);
    assert.equal(dash.retained(EURUSD, '1m'), null, 'no signal is retained meanwhile');
  }
});

// =============================================================================================
// D — A recovery response cannot resurrect the stale decision
// =============================================================================================

test('D7 D — a recovery response that does not bridge the gap cannot restore the decision', () => {
  const dash = dashboardWithDecision();
  dash.disconnect();

  // A response for a period that does not cover the interrupted one.
  const applied = dash.deliverHistory(EURUSD, '1m', series(60 + 40 * MINUTE, 2));

  assert.equal(applied.recoveryIncomplete, true, 'the recovery is still incomplete');
  assert.equal(applied.recoveryComplete, false);
  assert.equal(dash.manager.isRecoveryRequired(EURUSD, '1m'), true, 'the pair stays blocked');
  assert.equal(dash.state.signal, null, 'the stale decision is not restored');
  assert.equal(dash.state.evaluatedAt, null);
  assert.equal(dash.retained(EURUSD, '1m'), null, 'the stale signal is not restored');
  assert.doesNotMatch(dash.renderPanel(), /LONG/);
});

test('D7 D — unrelated dashboard updates cannot restore the stale decision', () => {
  const dash = dashboardWithDecision();
  dash.disconnect();

  // A tick for another symbol, and an evaluation of the blocked pair.
  dash.manager.processTick(tick(GBPUSD, 1.2, 60 + 30 * MINUTE));
  dash.evaluate(GBPUSD, '1m');
  dash.evaluate(EURUSD, '1m');

  assert.equal(dash.state.signal, null, 'the affected pair keeps its invalid decision');
  assert.equal(dash.retained(EURUSD, '1m'), null);
  assert.doesNotMatch(dash.renderPanel(), /LONG/);
});

// =============================================================================================
// E — After the recovery, the pipeline decides again
// =============================================================================================

test('D7 E — after a completed recovery the pipeline produces a fresh decision', () => {
  const dash = dashboardWithDecision();
  dash.disconnect();

  // The interrupted period is re-derived, so the gap is bridged.
  const applied = dash.deliverHistory(EURUSD, '1m', series(60 + 30 * MINUTE, 1));

  assert.equal(applied.recoveryComplete, true, 'the recovery completed');
  assert.equal(dash.manager.isRecoveryRequired(EURUSD, '1m'), false, 'the pair is released');

  // The evaluation pipeline ran again on the recovered history.
  assert.ok(dash.state.evaluatedAt instanceof Date, 'a fresh evaluation ran');
  assert.ok(dash.state.signal, 'the pipeline returned its own decision');
  assert.notEqual(dash.state.signal?.decision, 'LONG', 'the stale LONG is not reused');
  assert.equal(dash.retained(EURUSD, '1m'), null, 'the stale signal was not retained again');
});

test('D7 E — a fresh genuine decision is displayed and retained after the recovery', () => {
  const dash = dashboardWithDecision();
  dash.disconnect();

  // The recovery completed and the pipeline evaluated the pair again.
  dash.deliverHistory(EURUSD, '1m', series(60 + 30 * MINUTE, 1));
  assert.equal(dash.manager.isRecoveryRequired(EURUSD, '1m'), false);

  // The pair qualifies again (a new, genuine signal - not the old one).
  const fresh = genuineLongEvaluation(EURUSD, '1m');
  dash.state = applyEvaluation(dash.state, { symbolId: EURUSD, timeframe: '1m' }, fresh);

  assert.equal(dash.state.signal?.decision, 'LONG');
  assert.equal(dash.retained(EURUSD, '1m')?.decision, 'LONG', 'the fresh signal is retained');
  assert.match(dash.renderPanel(), /LONG/);
});

// =============================================================================================
// F — The invalidation is scoped to the affected pair
// =============================================================================================

test('D7 F — invalidating one pair does not erase an unrelated pair', () => {
  const dash = new Dashboard({ symbolId: EURUSD, timeframe: '1m' });

  // The user visited three pairs; each kept its own retained signal.
  for (const [symbolId, timeframe] of [
    [EURUSD, '1m'],
    [EURUSD, '5m'],
    [GBPUSD, '1m'],
  ] as Array<[string, Timeframe]>) {
    dash.manager.seedHistory(symbolId, timeframe, series(60, 30));
    dash.manager.processTick(tick(symbolId, 1.1, 60 + 30 * MINUTE));
    dash.state = applyEvaluation(
      dash.state,
      { symbolId, timeframe },
      genuineLongEvaluation(symbolId, timeframe)
    );
  }

  const before = dash.state;
  assert.equal(dash.retained(EURUSD, '1m')?.decision, 'LONG');
  assert.equal(dash.retained(EURUSD, '5m')?.decision, 'LONG');
  assert.equal(dash.retained(GBPUSD, '1m')?.decision, 'LONG');

  // A discontinuity is per SYMBOL: marking EURUSD interrupts every one of its
  // timeframes, not just the displayed one. The affected set is derived the
  // same way production derives it (the full collectAffectedPairs), so the
  // invalidation it drives covers every affected EURUSD pair.
  dash.manager.markDiscontinuity(EURUSD);
  const affected = collectAffectedPairs(dash.manager);
  const affectedEur = affected.filter((p) => p.symbolId === EURUSD);
  assert.ok(
    affectedEur.some((p) => p.timeframe === '1m'),
    'the displayed EURUSD timeframe is affected'
  );
  assert.ok(
    affectedEur.some((p) => p.timeframe === '5m'),
    'the other EURUSD timeframe is affected too (symbol-level discontinuity)'
  );
  assert.ok(
    !affected.some((p) => p.symbolId === GBPUSD),
    'the unrelated symbol is not affected'
  );
  dash.state = invalidateDecisionsForDiscontinuity(dash.state, affected, dash.displayed);

  assert.equal(dash.retained(EURUSD, '1m'), null, 'the affected pair loses its signal');
  assert.equal(
    dash.retained(EURUSD, '5m'),
    null,
    'every affected timeframe of the interrupted symbol loses its signal'
  );
  assert.equal(
    dash.retained(GBPUSD, '1m')?.decision,
    'LONG',
    'the unrelated symbol keeps its signal'
  );
  assert.equal(dash.state.signal, null, 'the displayed decision of the affected pair is gone');
  assert.notEqual(before.retained, dash.state.retained, 'the store really changed');
});

test('D7 F — invalidating a pair that is not displayed leaves the displayed decision', () => {
  const dash = new Dashboard({ symbolId: EURUSD, timeframe: '1m' });
  dash.manager.seedHistory(EURUSD, '1m', series(60, 30));
  dash.manager.processTick(tick(EURUSD, 1.1, 60 + 30 * MINUTE));
  dash.state = applyEvaluation(
    dash.state,
    { symbolId: EURUSD, timeframe: '1m' },
    genuineLongEvaluation(EURUSD, '1m')
  );

  // A different pair is interrupted.
  dash.manager.seedHistory(GBPUSD, '1m', series(60, 30));
  dash.manager.processTick(tick(GBPUSD, 1.2, 60 + 30 * MINUTE));
  dash.manager.markDiscontinuity(GBPUSD);
  const affected = collectAffectedPairs(dash.manager).filter((p) => p.symbolId === GBPUSD);
  dash.state = invalidateDecisionsForDiscontinuity(dash.state, affected, dash.displayed);

  assert.equal(dash.state.signal?.decision, 'LONG', 'the displayed decision survives');
  assert.equal(dash.retained(EURUSD, '1m')?.decision, 'LONG');
  assert.match(dash.renderPanel(), /LONG/);
});

// =============================================================================================
// G — Ordinary operation
// =============================================================================================

test('D7 G — without a discontinuity the decision is evaluated, displayed and retained', () => {
  const dash = new Dashboard({ symbolId: EURUSD, timeframe: '1m' });
  dash.manager.seedHistory(EURUSD, '1m', series(60, 30));
  dash.manager.processTick(tick(EURUSD, 1.1, 60 + 30 * MINUTE));

  const evaluation = dash.evaluate(EURUSD, '1m');
  assert.ok(evaluation, 'the pair was evaluated');
  assert.ok(dash.state.evaluatedAt instanceof Date);
  assert.ok(dash.state.signal, 'the pipeline returned its own decision');

  // A genuine signal is displayed and retained.
  dash.state = applyEvaluation(
    dash.state,
    { symbolId: EURUSD, timeframe: '1m' },
    genuineLongEvaluation(EURUSD, '1m')
  );
  assert.equal(dash.state.signal?.decision, 'LONG');
  assert.equal(dash.retained(EURUSD, '1m')?.decision, 'LONG');
  assert.match(dash.renderPanel(), /LONG/);
  assert.match(dash.renderPanel(), /1\.0983/, 'the real stop loss is shown');
});

test('D7 G — a later NO_TRADE does not erase the retained signal', () => {
  const dash = dashboardWithDecision();
  assert.equal(dash.retained(EURUSD, '1m')?.decision, 'LONG');

  // A later evaluation that no longer qualifies (the engine's own outcome).
  const evaluation = dash.evaluate(EURUSD, '1m');
  assert.ok(evaluation, 'the pair is still evaluated');
  assert.equal(dash.state.signal?.decision, 'NO_TRADE', 'the latest decision is shown');
  assert.equal(
    dash.retained(EURUSD, '1m')?.decision,
    'LONG',
    'the retained signal survives a rejected re-evaluation'
  );
});

test('D7 G — the invalidation is idempotent', () => {
  const dash = dashboardWithDecision();
  dash.disconnect();
  const afterFirst = dash.state;

  dash.disconnect();

  assert.equal(dash.state.signal, null);
  assert.equal(dash.state.retained.size, afterFirst.retained.size);
  assert.equal(dash.state.evaluatedAt, null);
});
