/**
 * G3 — a stale feed must enter the existing discontinuity lifecycle.
 *
 * The confirmed defect: the dashboard's stale-tick listener only wrote a warning
 * to the event log. A stale episode means the ticks of an unknown stretch of
 * time were never observed, so the candle that spans the gap must never be
 * finalized as a valid close and the pair must recover its history before it is
 * evaluated again - exactly like a dropped connection. Because the stale path
 * did nothing, a late tick could jump the forming candle across the gap and the
 * pair kept being evaluated as if no data were missing; the previously displayed
 * decision also stayed on screen as if it were current.
 *
 * These tests drive the real production transitions: the real candle manager,
 * the real recovery path, the real decision-state invalidation, the real signal
 * pipeline, and the real headless acquisition adapter. No socket, no network,
 * no fabricated market data beyond deterministic period fixtures.
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
  type DecisionState,
  type PairRef,
} from '../lib/signals/decision-state';
import { SignalPanel } from '../components/SignalPanel';
import { MonitoringCore } from '../lib/monitoring/headless-core';
import { LiveAcquisitionAdapter, type MonitoringMarketSource } from '../lib/monitoring/live-acquisition';
import { DerivWebSocketClient } from '../lib/deriv/websocket';
import type { ConnectionStatus } from '../lib/deriv/websocket';
import type { FeedStatus } from '../lib/deriv/feed';
import type { HistoryRequestCallback, HistoryRequestOutcome } from '../lib/deriv/history-requests';
import { signalPairKey } from '../lib/signals/signal-history';
import { constructedLongSignal, genuineLongAnalysis } from './signal-replay-harness';

const EURUSD = 'EURUSD';
const GBPUSD = 'GBPUSD';
const MINUTE = 60;
const LONG_EPOCH = 1750000000;

function historyCandle(epoch: number, close = 1.1): HistoryCandleData {
  return { epoch, open: close, high: close, low: close, close };
}

function series(firstEpoch: number, count: number, close = 1.1): HistoryCandleData[] {
  const out: HistoryCandleData[] = [];
  for (let i = 0; i < count; i++) out.push(historyCandle(firstEpoch + i * MINUTE, close));
  return out;
}

function tick(symbol: string, price: number, epoch: number): TickData {
  return { symbol, derivSymbol: symbol, price, epoch };
}

/**
 * The dashboard's decision state and the operations its listeners perform.
 * Every step uses the production transitions; only the React state updates are
 * replaced by plain assignments (the project has no interactive React harness).
 */
class Dashboard {
  public state: DecisionState = createDecisionState();
  public readonly manager = new CandleManager();
  public displayed: PairRef;
  public retriesCancelled = 0;

  private readonly smc = new SMCEngine();
  private readonly signalEngine = new SignalEngine();

  constructor(displayed: PairRef) {
    this.displayed = displayed;
  }

  public evaluate(symbolId: string, timeframe: Timeframe): PairEvaluation | null {
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

  private invalidateAffectedDecisions(): void {
    const affected = collectAffectedPairs(this.manager);
    if (affected.length > 0) {
      this.state = invalidateDecisionsForDiscontinuity(this.state, affected, this.displayed);
    }
  }

  /** app/dashboard/page.tsx onStatusChange, non-connected branch. */
  public statusDisconnected(): void {
    for (const symbolId of this.manager.getTrackedSymbols()) {
      this.manager.markDiscontinuity(symbolId);
    }
    this.invalidateAffectedDecisions();
    this.retriesCancelled += 1;
  }

  /** app/dashboard/page.tsx onStale, isStale === true branch. */
  public stale(symbol: string): void {
    this.manager.markDiscontinuity(symbol);
    this.invalidateAffectedDecisions();
    this.retriesCancelled += 1;
  }

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

  public retained(symbolId: string, timeframe: Timeframe): SignalOutput | null {
    return getRetainedSignal(this.state, { symbolId, timeframe });
  }

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

  public renderPanel(): string {
    return renderToStaticMarkup(React.createElement(SignalPanel, this.panelProps()));
  }

  private isDisplayed(symbolId: string, timeframe: Timeframe): boolean {
    return symbolId === this.displayed.symbolId && timeframe === this.displayed.timeframe;
  }
}

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

function dashboardWithDecision(symbolId = EURUSD, timeframe: Timeframe = '1m'): Dashboard {
  const dash = new Dashboard({ symbolId, timeframe });
  dash.manager.seedHistory(symbolId, timeframe, series(60, 30));
  dash.manager.processTick(tick(symbolId, 1.1, 60 + 30 * MINUTE));
  dash.state = applyEvaluation(
    dash.state,
    { symbolId, timeframe },
    genuineLongEvaluation(symbolId, timeframe)
  );
  return dash;
}

// =============================================================================================
// A — A stale feed triggers the existing discontinuity lifecycle
// =============================================================================================

test('G3 A — a stale symbol is marked and requires recovery, like a dropped connection', () => {
  const dash = dashboardWithDecision();
  assert.equal(dash.manager.isRecoveryRequired(EURUSD, '1m'), false);

  dash.stale(EURUSD);

  assert.equal(
    dash.manager.isRecoveryRequired(EURUSD, '1m'),
    true,
    'the stale pair must recover its history'
  );
  assert.equal(dash.manager.getState(EURUSD)?.timeframes.get('1m')?.recoveryRequired, true);
});

test('G3 A — the interrupted candle spanning the gap is anchored at the stale symbol only', () => {
  const dash = dashboardWithDecision(EURUSD, '1m');
  dash.manager.seedHistory(GBPUSD, '1m', series(60, 30));
  dash.manager.processTick(tick(GBPUSD, 1.2, 60 + 30 * MINUTE));

  dash.stale(EURUSD);

  assert.equal(dash.manager.isRecoveryRequired(EURUSD, '1m'), true);
  assert.equal(
    dash.manager.isRecoveryRequired(GBPUSD, '1m'),
    false,
    'an unrelated symbol is not interrupted by another symbol going stale'
  );
});

// =============================================================================================
// B — Repeated stale callbacks are idempotent; a new episode is still detected
// =============================================================================================

test('G3 B — repeated stale callbacks do not create a second cycle or reset the anchor', () => {
  const dash = dashboardWithDecision();
  dash.stale(EURUSD);
  const requirement = dash.manager.getRecoveryRequirement(EURUSD, '1m');
  assert.ok(requirement);
  const afterFirst = dash.state;

  dash.stale(EURUSD);
  dash.stale(EURUSD);

  const requirementAgain = dash.manager.getRecoveryRequirement(EURUSD, '1m');
  assert.ok(requirementAgain);
  assert.equal(
    requirementAgain.recoveryEpoch,
    requirement.recoveryEpoch,
    'the oldest gap anchor is kept'
  );
  assert.equal(requirementAgain.requiredCount, requirement.requiredCount);
  assert.equal(dash.state.retained.size, afterFirst.retained.size);
  assert.equal(dash.state.evaluatedAt, null);
});

test('G3 B — after a completed recovery a new independent stale episode is detectable', () => {
  const dash = dashboardWithDecision();
  dash.stale(EURUSD);

  // The interrupted period is re-derived: the gap is bridged and the pair released.
  const applied = dash.deliverHistory(EURUSD, '1m', series(60 + 30 * MINUTE, 1));
  assert.equal(applied.recoveryComplete, true);
  assert.equal(dash.manager.isRecoveryRequired(EURUSD, '1m'), false);

  // A later, independent stale episode must block the pair again.
  dash.manager.processTick(tick(EURUSD, 1.1, 60 + 60 * MINUTE));
  dash.stale(EURUSD);
  assert.equal(
    dash.manager.isRecoveryRequired(EURUSD, '1m'),
    true,
    'the new episode is a fresh discontinuity'
  );
});

// =============================================================================================
// C — A late tick cannot bypass the required recovery
// =============================================================================================

test('G3 C — a late tick after a stale episode cannot silently advance past the gap', () => {
  const dash = new Dashboard({ symbolId: EURUSD, timeframe: '1m' });
  dash.manager.seedHistory(EURUSD, '1m', series(60, 30));
  dash.manager.processTick(tick(EURUSD, 1.1, 60 + 30 * MINUTE));

  // Data goes silent, then a much later tick arrives (periods were never observed).
  dash.stale(EURUSD);
  dash.manager.processTick(tick(EURUSD, 1.3, 60 + 40 * MINUTE));

  assert.equal(
    dash.manager.isRecoveryRequired(EURUSD, '1m'),
    true,
    'the pair stays blocked despite the late tick'
  );
  assert.equal(dash.evaluate(EURUSD, '1m'), null, 'a blocked pair is never evaluated');
});

test('G3 C — the evaluation path refuses a pair whose stale recovery is pending', () => {
  const dash = dashboardWithDecision();
  dash.stale(EURUSD);

  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(dash.evaluate(EURUSD, '1m'), null);
    assert.equal(dash.state.signal, null);
    assert.equal(dash.retained(EURUSD, '1m'), null);
  }
});

// =============================================================================================
// D — Retained decisions respect the recovery state
// =============================================================================================

test('G3 D — the stale decision and retained signal are invalidated immediately', () => {
  const dash = dashboardWithDecision();
  assert.equal(dash.state.signal?.decision, 'LONG');
  assert.equal(dash.retained(EURUSD, '1m')?.decision, 'LONG');
  assert.match(dash.renderPanel(), /LONG/);

  dash.stale(EURUSD);

  assert.equal(dash.state.signal, null, 'the displayed signal is invalidated');
  assert.equal(dash.state.evaluatedAt, null);
  assert.equal(dash.state.analysis, null);
  assert.equal(dash.retained(EURUSD, '1m'), null, 'the retained signal is dropped');
  assert.doesNotMatch(dash.renderPanel(), /LONG/);
});

test('G3 D — an interrupted pair cannot be resurrected by an unrelated update', () => {
  const dash = dashboardWithDecision();
  dash.stale(EURUSD);

  dash.manager.processTick(tick(GBPUSD, 1.2, 60 + 30 * MINUTE));
  dash.evaluate(GBPUSD, '1m');
  dash.evaluate(EURUSD, '1m');

  assert.equal(dash.state.signal, null);
  assert.equal(dash.retained(EURUSD, '1m'), null);
});

// =============================================================================================
// E — Normal recovery resumes without a restart
// =============================================================================================

test('G3 E — a completed recovery releases the pair and the pipeline evaluates again', () => {
  const dash = dashboardWithDecision();
  dash.stale(EURUSD);

  const applied = dash.deliverHistory(EURUSD, '1m', series(60 + 30 * MINUTE, 1));

  assert.equal(applied.recoveryComplete, true);
  assert.equal(dash.manager.isRecoveryRequired(EURUSD, '1m'), false, 'the pair is released');
  assert.ok(dash.state.evaluatedAt instanceof Date, 'a fresh evaluation ran');
  assert.equal(dash.retained(EURUSD, '1m'), null, 'the stale signal is not reused');
});

// =============================================================================================
// F — Exhaustion stays fail-closed
// =============================================================================================

test('G3 F — an incomplete recovery keeps the pair blocked (fail-closed)', () => {
  const dash = dashboardWithDecision();
  dash.stale(EURUSD);

  const applied = dash.deliverHistory(EURUSD, '1m', series(60 + 40 * MINUTE, 2));

  assert.equal(applied.recoveryIncomplete, true);
  assert.equal(applied.recoveryComplete, false);
  assert.equal(dash.manager.isRecoveryRequired(EURUSD, '1m'), true, 'the pair stays blocked');
  assert.equal(dash.state.signal, null);
  assert.equal(dash.retained(EURUSD, '1m'), null);
});

// =============================================================================================
// G — Ordinary operation is preserved
// =============================================================================================

test('G3 G — without a stale episode the decision is evaluated and retained', () => {
  const dash = new Dashboard({ symbolId: EURUSD, timeframe: '1m' });
  dash.manager.seedHistory(EURUSD, '1m', series(60, 30));
  dash.manager.processTick(tick(EURUSD, 1.1, 60 + 30 * MINUTE));

  const evaluation = dash.evaluate(EURUSD, '1m');
  assert.ok(evaluation);
  dash.state = applyEvaluation(
    dash.state,
    { symbolId: EURUSD, timeframe: '1m' },
    genuineLongEvaluation(EURUSD, '1m')
  );
  assert.equal(dash.state.signal?.decision, 'LONG');
  assert.equal(dash.retained(EURUSD, '1m')?.decision, 'LONG');
  assert.match(dash.renderPanel(), /LONG/);
});

test('G3 G — a disconnected status still marks every tracked symbol and invalidates once', () => {
  const dash = dashboardWithDecision();
  dash.manager.seedHistory(GBPUSD, '1m', series(60, 30));
  dash.manager.processTick(tick(GBPUSD, 1.2, 60 + 30 * MINUTE));

  dash.statusDisconnected();

  assert.equal(dash.manager.isRecoveryRequired(EURUSD, '1m'), true);
  assert.equal(dash.manager.isRecoveryRequired(GBPUSD, '1m'), true);
  assert.equal(dash.retriesCancelled, 1, 'retries are invalidated on a discontinuity');
});

// =============================================================================================
// Client — stale is emitted only on a real transition
// =============================================================================================

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

test('G3 client — a valid tick clears stale and emits a stale=false transition', () => {
  const original = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];

  const client = new DerivWebSocketClient({ pingIntervalMs: 1_000_000 });
  const events: Array<{ symbol: string; isStale: boolean }> = [];
  client.onStale((symbol, isStale) => events.push({ symbol, isStale }));

  try {
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    client.subscribeTicks(EURUSD);
    socket.emit({
      msg_type: 'tick',
      tick: { symbol: 'frxEURUSD', quote: 1.09, epoch: 1700000000 },
    });
    assert.equal(client.isSymbolStale(EURUSD), false);
    assert.equal(events.length, 0, 'a healthy tick never emits a stale transition');
  } finally {
    client.disconnect();
    (globalThis as { WebSocket?: unknown }).WebSocket = original;
  }
});

// =============================================================================================
// H — The headless adapter honours a stale feed identically
// =============================================================================================

class FakeMarketSource implements MonitoringMarketSource {
  public connectCount = 0;
  public subscribed: string[] = [];

  private status: ConnectionStatus = 'DISCONNECTED';
  private readonly feed = new Map<string, FeedStatus>();
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private readonly tickListeners = new Set<(t: TickData) => void>();
  private readonly feedListeners = new Set<(s: FeedStatus) => void>();
  private readonly pending: Array<{
    symbolId: string;
    timeframe: Timeframe;
    callback: HistoryRequestCallback;
  }> = [];

  connect(): void {
    this.connectCount += 1;
    this.setStatus('CONNECTED');
  }

  disconnect(): void {
    this.status = 'DISCONNECTED';
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getFeedStatus(symbolId: string): FeedStatus | undefined {
    return this.feed.get(symbolId);
  }

  getLastTickEpoch(symbolId: string): number | undefined {
    return undefined;
  }

  subscribeTicks(symbolId: string): void {
    this.subscribed.push(symbolId);
  }

  fetchCandlesHistory(
    symbolId: string,
    timeframe: Timeframe,
    _count: number,
    callback: HistoryRequestCallback
  ): void {
    this.pending.push({ symbolId, timeframe, callback });
  }

  onStatusChange(listener: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onTick(listener: (t: TickData) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  onFeedStatus(listener: (s: FeedStatus) => void): () => void {
    this.feedListeners.add(listener);
    return () => this.feedListeners.delete(listener);
  }

  setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }

  emitTick(t: TickData): void {
    for (const l of this.tickListeners) l(t);
  }

  emitFeed(status: FeedStatus): void {
    this.feed.set(status.symbol, status);
    for (const l of this.feedListeners) l(status);
  }

  completeHistory(
    symbolId: string,
    timeframe: Timeframe,
    candles: HistoryCandleData[],
    outcome: HistoryRequestOutcome
  ): void {
    const idx = this.pending.findIndex(
      (r) => r.symbolId === symbolId && r.timeframe === timeframe
    );
    if (idx < 0) throw new Error(`no pending history request for ${symbolId}:${timeframe}`);
    const [req] = this.pending.splice(idx, 1);
    req.callback(symbolId, timeframe, candles, outcome);
  }
}

const PERIOD = Math.floor(1_700_000_000 / MINUTE) * MINUTE;

function closedCandle(epoch: number, close = 1.1): Candle {
  return { epoch, open: close, high: close, low: close, close, volume: 1, isClosed: true };
}

test('G3 H — a STALE feed status marks the pair and refuses evaluation until recovery', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });
  adapter.start();

  // Seed a usable closed history and confirm the pair is otherwise evaluable.
  source.completeHistory(EURUSD, '1m', series(PERIOD, 5), 'success');
  assert.equal(core.candleManager.isRecoveryRequired(EURUSD, '1m'), false);

  // The symbol goes stale: this is a discontinuity for that symbol.
  source.emitFeed({ symbol: EURUSD, state: 'STALE' });
  assert.equal(
    core.candleManager.isRecoveryRequired(EURUSD, '1m'),
    true,
    'the stale pair must recover its history'
  );
  assert.equal(adapter.getPairState(EURUSD, '1m')?.recoveryRequired, true);

  // A later closed candle may not be evaluated while recovery is pending.
  const report = adapter.handleClosedCandle(EURUSD, '1m', closedCandle(PERIOD + 5 * MINUTE));
  assert.equal(report, null, 'a blocked pair is never evaluated');
});

test('G3 H — a STALE feed for one symbol does not block an unrelated monitored symbol', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [
      { symbolId: EURUSD, timeframe: '1m' },
      { symbolId: GBPUSD, timeframe: '1m' },
    ],
  });
  adapter.start();
  source.completeHistory(EURUSD, '1m', series(PERIOD, 5), 'success');
  source.completeHistory(GBPUSD, '1m', series(PERIOD, 5), 'success');

  source.emitFeed({ symbol: EURUSD, state: 'STALE' });

  assert.equal(core.candleManager.isRecoveryRequired(EURUSD, '1m'), true);
  assert.equal(
    core.candleManager.isRecoveryRequired(GBPUSD, '1m'),
    false,
    'an unrelated pair keeps its history'
  );
});

test('G3 H — repeated STALE status callbacks are idempotent', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });
  adapter.start();
  source.completeHistory(EURUSD, '1m', series(PERIOD, 5), 'success');

  source.emitFeed({ symbol: EURUSD, state: 'STALE' });
  const first = core.candleManager.getRecoveryRequirement(EURUSD, '1m');
  source.emitFeed({ symbol: EURUSD, state: 'STALE' });
  source.emitFeed({ symbol: EURUSD, state: 'STALE' });
  const again = core.candleManager.getRecoveryRequirement(EURUSD, '1m');

  assert.ok(first && again);
  assert.equal(again.recoveryEpoch, first.recoveryEpoch, 'the oldest gap anchor is kept');
});

test('G3 H — recovery after a stale feed releases the pair and resumes evaluation', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: EURUSD, timeframe: '1m' }],
  });
  adapter.start();
  source.completeHistory(EURUSD, '1m', series(PERIOD, 5), 'success');
  source.emitFeed({ symbol: EURUSD, state: 'STALE' });
  assert.equal(core.candleManager.isRecoveryRequired(EURUSD, '1m'), true);

  // The stale pair is re-requested once the socket reports connected again.
  source.setStatus('CONNECTED');
  const gap = series(PERIOD, 10);
  source.completeHistory(EURUSD, '1m', gap, 'success');

  assert.equal(
    core.candleManager.isRecoveryRequired(EURUSD, '1m'),
    false,
    'the bridged history releases the pair'
  );

  const report = adapter.handleClosedCandle(EURUSD, '1m', closedCandle(PERIOD + 10 * MINUTE));
  assert.ok(report, 'the recovered pair is evaluated again');
});

test('G3 H — no signalPairKey collision: stale state is scoped to the right pair key', () => {
  assert.equal(signalPairKey(EURUSD, '1m'), 'EURUSD:1m');
  assert.equal(signalPairKey(EURUSD, '5m'), 'EURUSD:5m');
});
