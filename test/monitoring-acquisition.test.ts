/**
 * Phase 2B Stage 2C — live read-only acquisition adapter tests.
 *
 * These tests exercise `lib/monitoring/live-acquisition.ts` with a controlled
 * in-memory market source (no socket, no network) and the REAL headless
 * `MonitoringCore` (real `CandleManager`). They verify the Stage 2 safety
 * guarantees: only genuinely-closed candles are ever evaluated, history seeding
 * and reconnects never replay or fabricate, a connection/subscription is never
 * treated as usable data, and no notification-dedup state is polluted.
 *
 * Fixture note (documented limitation, carried from Stage 1): no existing candle
 * fixture produces a genuine LONG/SHORT through the full candle→SMC→engine
 * pipeline. The candidate-identity plumbing (ACQ 9) is therefore exercised with
 * a constructed genuine `SignalOutput` and an explicitly labelled stub target —
 * the same constructed-signal technique `signal-engine.test.ts` uses. No candle,
 * price, zone, or signal is fabricated into the candle pipeline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LiveAcquisitionAdapter,
  MonitoringMarketSource,
  MonitoringEvaluationTarget,
  MonitoringObservation,
} from '../lib/monitoring/live-acquisition';
import { MonitoringCore, PairEvaluationReport } from '../lib/monitoring/headless-core';
import {
  Candle,
  CandleManager,
  TickData,
  Timeframe,
  TIMEFRAME_SECONDS,
} from '../lib/deriv/candles';
import type { ConnectionStatus } from '../lib/deriv/websocket';
import type { FeedStatus } from '../lib/deriv/feed';
import type {
  HistoryCandleData,
  HistoryRequestCallback,
  HistoryRequestOutcome,
} from '../lib/deriv/history-requests';
import {
  SignalEngine,
  SignalContext,
  SignalOutput,
} from '../lib/signals/signal-engine';
import { PairEvaluation } from '../lib/signals/signal-eval';
import { signalPairKey, isGeneratedSignal } from '../lib/signals/signal-history';
import type { SMCAnalysisResult } from '../lib/analysis/smc';
import {
  MarketStructureState,
  StructuralBias,
  SwingPoint,
} from '../lib/analysis/market-structure';
import { BreakType, StructureBreak } from '../lib/analysis/structure-breaks';
import { FairValueGap, FVGState } from '../lib/analysis/fvg';
import { LiquidityLevel, LiquidityState } from '../lib/analysis/liquidity';

// --- Controlled market source (implements MonitoringMarketSource) ----------------------------

class FakeMarketSource implements MonitoringMarketSource {
  public connectCount = 0;
  public disconnectCount = 0;
  public subscribed: string[] = [];

  private status: ConnectionStatus = 'DISCONNECTED';
  private readonly feed = new Map<string, FeedStatus>();
  private readonly lastTick = new Map<string, number>();
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
    this.disconnectCount += 1;
    this.status = 'DISCONNECTED';
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getFeedStatus(symbolId: string): FeedStatus | undefined {
    return this.feed.get(symbolId);
  }

  getLastTickEpoch(symbolId: string): number | undefined {
    return this.lastTick.get(symbolId);
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

  // --- test controls ---

  setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }

  emitTick(t: TickData): void {
    this.lastTick.set(t.symbol, t.epoch);
    for (const l of this.tickListeners) l(t);
  }

  emitFeed(status: FeedStatus): void {
    this.feed.set(status.symbol, status);
    for (const l of this.feedListeners) l(status);
  }

  pendingCount(): number {
    return this.pending.length;
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

function tick(symbol: string, price: number, epoch: number): TickData {
  return { symbol, derivSymbol: symbol, price, epoch };
}

function collect(adapter: LiveAcquisitionAdapter): MonitoringObservation[] {
  const out: MonitoringObservation[] = [];
  adapter.onObservation((o) => out.push(o));
  return out;
}

function historyFrom(candles: readonly Candle[]): HistoryCandleData[] {
  return candles.map((c) => ({
    epoch: c.epoch,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
}

function ofType<T extends MonitoringObservation['type']>(
  obs: MonitoringObservation[],
  type: T
): Array<Extract<MonitoringObservation, { type: T }>> {
  return obs.filter((o): o is Extract<MonitoringObservation, { type: T }> => o.type === type);
}

/** A period-aligned base epoch and the start of the first 1m period. */
const BASE = 1_700_000_000;
const P1 = Math.floor(BASE / 60) * 60; // first 1m period boundary

// --- Fixtures (copied verbatim from the Stage 1 harness; not exported there) ------------------

/** 5-leg bearish zig-zag (30 closed candles). Real structure, honestly rejected. */
function bearZigZag(): Candle[] {
  const out: Candle[] = [];
  // The base is period-aligned: the candles below describe whole 1m periods,
  // exactly like the history a provider delivers.
  let e = 1749999960;
  let p = 1.115;
  for (let leg = 0; leg < 5; leg++) {
    const target = p - 0.006;
    for (let i = 0; i < 4; i++) {
      p -= 0.0004;
      out.push({ epoch: (e += 60), open: p, high: p + 0.0002, low: p - 0.0003, close: p, volume: 10, isClosed: true });
    }
    for (let i = 0; i < 2; i++) {
      p += 0.001;
      out.push({ epoch: (e += 60), open: p, high: p + 0.0002, low: p - 0.0003, close: p, volume: 10, isClosed: true });
    }
    p = target + 0.002;
  }
  return out;
}

// --- Constructed genuine-signal helpers (same technique as signal-engine.test.ts) ------------

const SIG = 1_000_000;

function brk(
  symbol: string,
  timeframe: Timeframe,
  type: BreakType,
  confirmedAtEpoch: number,
  breakCandleEpoch: number,
  id: string
): StructureBreak {
  const direction: 'BULLISH' | 'BEARISH' = type.startsWith('BULLISH') ? 'BULLISH' : 'BEARISH';
  return {
    id,
    type,
    symbol,
    timeframe,
    breakCandleEpoch,
    brokenSwingEpoch: breakCandleEpoch - 100,
    brokenPrice: 1.1,
    confirmationPrice: 1.1,
    confirmedAtEpoch,
    direction,
    sourceStructure: 'NEUTRAL',
  };
}

function makeSwingPoint(
  symbol: string,
  timeframe: Timeframe,
  id: string,
  type: 'HIGH' | 'LOW',
  price: number
): SwingPoint {
  return {
    id,
    symbol,
    timeframe,
    type,
    candleEpoch: 100,
    swingCandleEpoch: 100,
    confirmedAtEpoch: 200,
    price,
    candleIndex: 0,
    structureType: type === 'HIGH' ? 'HH' : 'LL',
  };
}

function makeLiquidityLevel(
  id: string,
  price: number,
  type: 'BUY_SIDE' | 'SELL_SIDE',
  swept: boolean
): LiquidityLevel {
  return { id, price, type, swept, epoch: 100 };
}

function emptyAnalysis(symbol: string, timeframe: Timeframe): SMCAnalysisResult {
  const marketStructure: MarketStructureState = {
    symbol,
    timeframe,
    structuralBias: 'NEUTRAL' as StructuralBias,
    swings: [],
    latestSwingHigh: null,
    latestSwingLow: null,
    latestHH: null,
    latestHL: null,
    latestLH: null,
    latestLL: null,
    latestEQH: null,
    latestEQL: null,
    recentStructureSequence: [],
    lastAnalyzedEpoch: 0,
    breaks: [],
    latestBOS: null,
    latestCHoCH: null,
    protectedHigh: null,
    protectedLow: null,
  };
  return {
    symbol,
    timeframe,
    marketStructure,
    liquidity: {
      symbol,
      timeframe,
      buySideLiquidity: [],
      sellSideLiquidity: [],
      equalHighs: [],
      equalLows: [],
      status: 'WAITING FOR DATA',
    },
    fvg: {
      symbol,
      timeframe,
      bullishFVGs: [],
      bearishFVGs: [],
      unmitigatedCount: 0,
      status: 'WAITING FOR DATA',
    },
    orderBlocks: {
      symbol,
      timeframe,
      bullishOrderBlocks: [],
      bearishOrderBlocks: [],
      status: 'WAITING FOR DATA',
    },
    zone: 'WAITING FOR DATA',
    analyzedAt: 0,
  };
}

function structState(
  symbol: string,
  timeframe: Timeframe,
  overrides: Partial<MarketStructureState>
): MarketStructureState {
  return { ...emptyAnalysis(symbol, timeframe).marketStructure, ...overrides };
}

function fvgState(
  symbol: string,
  timeframe: Timeframe,
  bull: FairValueGap[],
  bear: FairValueGap[]
): FVGState {
  return { symbol, timeframe, bullishFVGs: bull, bearishFVGs: bear, unmitigatedCount: 0, status: 'ACTIVE' };
}

function liqState(
  symbol: string,
  timeframe: Timeframe,
  buy: LiquidityLevel[],
  sell: LiquidityLevel[]
): LiquidityState {
  return {
    symbol,
    timeframe,
    buySideLiquidity: buy,
    sellSideLiquidity: sell,
    equalHighs: [],
    equalLows: [],
    status: 'ACTIVE',
  };
}

function analysisWith(
  symbol: string,
  timeframe: Timeframe,
  overrides: Partial<SMCAnalysisResult>
): SMCAnalysisResult {
  return { ...emptyAnalysis(symbol, timeframe), ...overrides };
}

/** Genuine LONG TREND_CONTINUATION analysis (mirrors signal-engine.test.ts ORCH 1). */
function genuineLong(symbol: string, timeframe: Timeframe, signalEpoch: number): SMCAnalysisResult {
  const bar = TIMEFRAME_SECONDS[timeframe];
  const trigger: StructureBreak = {
    ...brk(symbol, timeframe, 'BULLISH_BOS', signalEpoch - bar, signalEpoch - 2 * bar, 'trig-long'),
    brokenPrice: 1.1,
  };
  const struct = structState(symbol, timeframe, {
    structuralBias: 'BULLISH',
    swings: [makeSwingPoint(symbol, timeframe, 'sw1', 'LOW', 1.095)],
    protectedLow: makeSwingPoint(symbol, timeframe, 'pl', 'LOW', 1.0985),
    breaks: [trigger],
  });
  const fvg = fvgState(
    symbol,
    timeframe,
    [
      {
        id: 'zone-long',
        type: 'BULLISH',
        topPrice: 1.0995,
        bottomPrice: 1.099,
        epoch: signalEpoch - 5 * bar,
        mitigated: false,
      },
    ],
    []
  );
  const liq = liqState(symbol, timeframe, [makeLiquidityLevel('tgt-long', 1.105, 'BUY_SIDE', false)], []);
  return analysisWith(symbol, timeframe, {
    marketStructure: struct,
    fvg,
    liquidity: liq,
    zone: 'DISCOUNT',
  });
}

function makeCandle(epoch: number, close: number): Candle {
  return { epoch, open: close, high: close, low: close, close, volume: 1, isClosed: true };
}

function ctxAt(epoch: number, close: number): SignalContext {
  return { lastClosedCandle: makeCandle(epoch, close) };
}

// =============================================================================================
// History seeding never evaluates
// =============================================================================================

test('ACQ 1 — history seeding never evaluates and never produces a candidate', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  const obs = collect(adapter);
  adapter.start();

  assert.equal(source.pendingCount(), 1, 'one bounded history request per pair');
  source.completeHistory('EURUSD', '1m', historyFrom(bearZigZag()), 'success');

  const st = adapter.getPairState('EURUSD', '1m');
  assert.equal(st?.historyStatus, 'success');
  assert.equal(st?.historyCandleCount, 30);
  assert.equal(st?.evaluationCount, 0, 'seeding is not an evaluation');
  assert.equal(st?.candidateCount, 0);
  assert.equal(core.candleManager.getHistory('EURUSD', '1m').length, 30);
  assert.equal(core.session.size(), 0, 'no notification dedup state is created by seeding');
  assert.equal(ofType(obs, 'evaluation').length, 0);
  assert.equal(ofType(obs, 'candidate').length, 0);
});

test('ACQ 1b — a response that carries candles but admits none is a failure, not a seed', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  const obs = collect(adapter);
  adapter.start();

  assert.equal(source.pendingCount(), 1, 'one bounded history request per pair');
  // The response carries a candle whose high is not a number: nothing about it
  // can be admitted, so the pair received no usable history at all.
  source.completeHistory(
    'EURUSD',
    '1m',
    [{ epoch: 60, open: 1.1, high: NaN, low: 1.0, close: 1.05 }],
    'success'
  );

  const st = adapter.getPairState('EURUSD', '1m');
  assert.equal(st?.historyStatus, 'failure', 'an unusable response is never a success');
  assert.equal(st?.historyCandleCount, 0, 'no candle was admitted');
  assert.equal(
    core.candleManager.getHistory('EURUSD', '1m').length,
    0,
    'the trusted history stays empty'
  );
  const errors = ofType(obs, 'error').filter((o) => o.stage === 'history');
  assert.equal(errors.length, 1, 'the rejection is reported once');
  assert.ok(
    errors[0].message.includes('non-finite-value'),
    'the report names the reason of the rejection'
  );
  assert.equal(
    ofType(obs, 'history').some((o) => o.outcome === 'success'),
    false,
    'the response is not reported as a successful history load'
  );
});

// =============================================================================================
// Only genuinely-closed candles are evaluated
// =============================================================================================
test('ACQ 2 — an incomplete (unclosed) candle is never evaluated', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  const obs = collect(adapter);
  adapter.start();

  const result = adapter.handleClosedCandle('EURUSD', '1m', {
    epoch: P1,
    open: 1.1,
    high: 1.1,
    low: 1.1,
    close: 1.1,
    volume: 1,
    isClosed: false,
  });

  assert.equal(result, null);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 0);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.candidateCount, 0);
  const errors = ofType(obs, 'error').filter((o) => o.stage === 'candle-close');
  assert.equal(errors.length, 1);
});

test('ACQ 3 — a genuine candle close evaluates exactly once', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  const obs = collect(adapter);
  adapter.start();

  source.emitTick(tick('EURUSD', 1.1, BASE));
  source.emitTick(tick('EURUSD', 1.11, BASE + 30));
  source.emitTick(tick('EURUSD', 1.12, BASE + 60)); // crosses into a new period -> close

  const st = adapter.getPairState('EURUSD', '1m');
  assert.equal(st?.evaluationCount, 1);
  assert.equal(st?.lastClosedCandleEpoch, P1);
  assert.equal(core.candleManager.getHistory('EURUSD', '1m').length, 1);

  const closes = ofType(obs, 'candle-close');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].epoch, P1);
  assert.equal(closes[0].close, 1.11, 'the confirmed close is the last tick in the period');
  assert.equal(ofType(obs, 'evaluation').length, 1);
});

test('ACQ 4 — duplicate or out-of-order delivery never re-evaluates', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  adapter.start();

  source.emitTick(tick('EURUSD', 1.1, BASE));
  source.emitTick(tick('EURUSD', 1.11, BASE + 30));
  source.emitTick(tick('EURUSD', 1.12, BASE + 60));
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 1);

  const closed: Candle = { epoch: P1, open: 1.1, high: 1.11, low: 1.1, close: 1.11, volume: 2, isClosed: true };
  assert.equal(adapter.handleClosedCandle('EURUSD', '1m', closed), null, 'same epoch is blocked');
  assert.equal(
    adapter.handleClosedCandle('EURUSD', '1m', { ...closed, epoch: P1 - 60 }),
    null,
    'older epoch is blocked'
  );
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 1);

  // Re-delivering the rollover tick only updates the new, forming candle.
  source.emitTick(tick('EURUSD', 1.121, BASE + 60));
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 1);
});

// =============================================================================================
// Recovery / reconnect never replays or fabricates
// =============================================================================================

test('ACQ 5 — a reconnect re-requests history that is missing or must be recovered, and never replays evaluation', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [
      { symbolId: 'EURUSD', timeframe: '1m' },
      { symbolId: 'XAUUSD', timeframe: '1m' },
    ],
  });
  adapter.start();
  assert.equal(source.pendingCount(), 2);

  source.completeHistory('EURUSD', '1m', historyFrom(bearZigZag()), 'success');
  source.completeHistory('XAUUSD', '1m', [], 'abandoned');
  assert.equal(source.pendingCount(), 0);
  assert.equal(adapter.getPairState('XAUUSD', '1m')?.historyStatus, 'abandoned');

  source.setStatus('RECONNECTING');
  // The disconnect leaves the seeded pair with a known gap in its history: it
  // must recover before it may be evaluated again.
  assert.equal(adapter.getPairState('EURUSD', '1m')?.recoveryRequired, true);
  source.setStatus('CONNECTED');

  // Both pairs are re-requested: EURUSD because it has to recover the gap the
  // disconnect left behind, XAUUSD because its request was abandoned.
  assert.equal(source.pendingCount(), 2);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 0);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.candidateCount, 0);
  assert.equal(core.session.size(), 0);
});

// =============================================================================================
// Per-pair isolation
// =============================================================================================

test('ACQ 6 — pairs are isolated: unmonitored symbols and other timeframes are ignored', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [
      { symbolId: 'EURUSD', timeframe: '1m' },
      { symbolId: 'XAUUSD', timeframe: '1m' },
    ],
  });
  adapter.start();

  source.emitTick(tick('EURUSD', 1.1, BASE));
  source.emitTick(tick('EURUSD', 1.12, BASE + 60));

  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 1);
  assert.equal(adapter.getPairState('XAUUSD', '1m')?.evaluationCount, 0);

  const closed: Candle = { epoch: P1, open: 1.1, high: 1.1, low: 1.1, close: 1.1, volume: 1, isClosed: true };
  assert.equal(adapter.handleClosedCandle('GBPUSD', '1m', closed), null, 'unmonitored symbol');
  assert.equal(adapter.handleClosedCandle('EURUSD', '5m', closed), null, 'unmonitored timeframe');
});

// =============================================================================================
// Connection is never usable data; closed/unavailable markets are reported accurately
// =============================================================================================

test('ACQ 7 — a connection is never treated as usable data, and no data is fabricated', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  const obs = collect(adapter);
  adapter.start();

  assert.equal(adapter.getConnectionStatus(), 'CONNECTED');
  assert.equal(adapter.getPairState('EURUSD', '1m')?.feedState, 'IDLE', 'no tick yet');

  source.emitFeed({ symbol: 'EURUSD', state: 'PENDING' });
  assert.equal(adapter.getPairState('EURUSD', '1m')?.feedState, 'PENDING');

  source.setStatus('RECONNECTING');
  assert.equal(adapter.getConnectionStatus(), 'RECONNECTING');
  assert.notEqual(adapter.getPairState('EURUSD', '1m')?.feedState, 'LIVE');

  source.setStatus('CONNECTED');
  assert.equal(adapter.getConnectionStatus(), 'CONNECTED');
  assert.notEqual(adapter.getPairState('EURUSD', '1m')?.feedState, 'LIVE', 'socket up ≠ live data');

  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 0);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.candidateCount, 0);
  assert.equal(core.candleManager.getHistory('EURUSD', '1m').length, 0);
  assert.equal(ofType(obs, 'candle-close').length, 0, 'no candle is fabricated from connectivity');
});

test('ACQ 8 — missing history and a closed market are reported accurately', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [
      { symbolId: 'EURUSD', timeframe: '1m' },
      { symbolId: 'XAUUSD', timeframe: '1m' },
    ],
  });
  const obs = collect(adapter);
  adapter.start();

  source.completeHistory('EURUSD', '1m', [], 'empty');
  source.completeHistory('XAUUSD', '1m', [], 'failure');

  assert.equal(adapter.getPairState('EURUSD', '1m')?.historyStatus, 'empty');
  assert.equal(adapter.getPairState('EURUSD', '1m')?.historyCandleCount, 0);
  assert.equal(adapter.getPairState('XAUUSD', '1m')?.historyStatus, 'failure');

  source.emitFeed({
    symbol: 'EURUSD',
    state: 'CLOSED',
    errorCode: 'MarketIsClosed',
    errorMessage: 'This market is presently closed.',
  });
  const st = adapter.getPairState('EURUSD', '1m');
  assert.equal(st?.feedState, 'CLOSED');
  assert.equal(st?.feedErrorCode, 'MarketIsClosed');
  assert.equal(st?.candidateCount, 0);
  assert.equal(ofType(obs, 'candidate').length, 0);
  assert.ok(ofType(obs, 'error').some((o) => o.stage === 'history'));
  assert.ok(ofType(obs, 'error').some((o) => o.stage === 'feed'));
});

// =============================================================================================
// Candidate identity plumbing (constructed genuine signal — explicitly labelled)
// =============================================================================================

test('ACQ 9 — candidate identity is carried verbatim through the adapter (stub target)', () => {
  const core = new MonitoringCore();
  const analysis = genuineLong('EURUSD', '1m', SIG);
  const genuine: SignalOutput = core.signalEngine.evaluate(analysis, ctxAt(SIG, 1.1));
  assert.equal(isGeneratedSignal(genuine), true);

  const pairKey = signalPairKey('EURUSD', '1m');
  const detection = core.session.detect({
    signal: genuine,
    symbolId: 'EURUSD',
    timeframe: '1m',
    pairKey,
    confirmingCandleEpoch: SIG,
  });
  assert.equal(detection.accepted, true);
  const candidate = detection.event;
  assert.ok(candidate);

  const evaluation: PairEvaluation = {
    analysis,
    signal: genuine,
    direction: 'BULLISH',
    evaluatedAt: new Date(),
    closedCandleCount: 60,
  };
  const report: PairEvaluationReport = {
    pairKey,
    symbolId: 'EURUSD',
    timeframe: '1m',
    confirmingCandleEpoch: SIG,
    evaluation,
    detection,
    candidate,
  };
  const stubTarget: MonitoringEvaluationTarget = {
    candleManager: new CandleManager(),
    evaluatePair: () => report,
  };

  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, stubTarget, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  const obs = collect(adapter);

  adapter.handleClosedCandle('EURUSD', '1m', {
    epoch: SIG,
    open: 1.1,
    high: 1.1,
    low: 1.1,
    close: 1.1,
    volume: 1,
    isClosed: true,
  });

  const candidates = ofType(obs, 'candidate');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].signalId, genuine.signalId);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.candidateCount, 1);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.lastCandidate?.signalId, genuine.signalId);
});

// =============================================================================================
// Honest NO_TRADE + lifecycle
// =============================================================================================

test('ACQ 10 — a genuine NO_TRADE is reported as NO_TRADE, never as a candidate', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  const obs = collect(adapter);
  adapter.start();

  const candles = bearZigZag();
  const lastSeed = candles[candles.length - 1].epoch;
  source.completeHistory('EURUSD', '1m', historyFrom(candles), 'success');

  // Ticks strictly after the seeded history force exactly one real close.
  source.emitTick(tick('EURUSD', 1.2, lastSeed + 120));
  source.emitTick(tick('EURUSD', 1.21, lastSeed + 180));

  const st = adapter.getPairState('EURUSD', '1m');
  assert.equal(st?.evaluationCount, 1);
  assert.equal(st?.lastSignal?.decision, 'NO_TRADE');
  assert.equal(st?.candidateCount, 0);
  assert.equal(ofType(obs, 'candidate').length, 0);
  const evaluations = ofType(obs, 'evaluation');
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].decision, 'NO_TRADE');
  assert.equal(evaluations[0].signalId, undefined);
});

test('ACQ 11 — stop() unregisters listeners and disconnects; later ticks are ignored', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  adapter.start();
  adapter.stop();

  assert.equal(source.disconnectCount, 1);
  assert.equal(adapter.getConnectionStatus(), 'DISCONNECTED');
  assert.equal(adapter.getPairState('EURUSD', '1m')?.connectionStatus, 'DISCONNECTED');

  // Listeners are gone: an incoming tick is not processed and produces no close.
  source.emitTick(tick('EURUSD', 1.1, BASE));
  source.emitTick(tick('EURUSD', 1.12, BASE + 60));
  assert.equal(core.candleManager.getState('EURUSD'), undefined, 'no tick reaches the candle manager');
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 0);
});

// =============================================================================================
// Evaluation failure isolation and epoch safety
// =============================================================================================

/**
 * Delegates to a real `MonitoringCore` (sharing its candle manager so ticks and
 * evaluations stay consistent) while allowing an injected evaluation failure.
 * This is a controlled double; it fabricates no market data.
 */
class FaultInjectingTarget implements MonitoringEvaluationTarget {
  public readonly candleManager: CandleManager;
  public calls = 0;
  public failNext = 0;
  public readonly failSymbols = new Set<string>();
  private readonly core: MonitoringCore;

  constructor(core: MonitoringCore) {
    this.core = core;
    this.candleManager = core.candleManager;
  }

  evaluatePair(symbolId: string, timeframe: Timeframe): PairEvaluationReport {
    this.calls += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('injected evaluation failure');
    }
    if (this.failSymbols.has(signalPairKey(symbolId, timeframe))) {
      throw new Error('injected evaluation failure');
    }
    return this.core.evaluatePair(symbolId, timeframe);
  }
}

test('ACQ 12 — a failed evaluation does not permanently consume the epoch (retryable)', () => {
  const core = new MonitoringCore();
  const target = new FaultInjectingTarget(core);
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, target, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  const obs = collect(adapter);
  adapter.start();

  // A genuine confirmed close whose evaluation throws.
  target.failNext = 1;
  source.emitTick(tick('EURUSD', 1.1, BASE));
  source.emitTick(tick('EURUSD', 1.11, BASE + 30));
  source.emitTick(tick('EURUSD', 1.12, BASE + 60)); // crosses into a new period -> close

  assert.equal(target.calls, 1);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 0, 'no success recorded');
  assert.equal(
    ofType(obs, 'error').filter((o) => o.stage === 'evaluation').length,
    1,
    'the failure is reported, not swallowed'
  );

  // The same confirmed close is delivered again (e.g. via recovery): it retries
  // because a failed evaluation must not have consumed the epoch.
  const closed: Candle = { epoch: P1, open: 1.1, high: 1.11, low: 1.1, close: 1.11, volume: 2, isClosed: true };
  const report = adapter.handleClosedCandle('EURUSD', '1m', closed);
  assert.ok(report, 'the retry evaluates successfully');
  assert.equal(target.calls, 2);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 1);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.lastClosedCandleEpoch, P1);

  // ...and once it has succeeded, a further duplicate is genuinely blocked.
  assert.equal(adapter.handleClosedCandle('EURUSD', '1m', closed), null, 'duplicate now blocked');
  assert.equal(target.calls, 2);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 1);
});

test('ACQ 13 — an evaluation failure on one pair does not stop other pairs', () => {
  const core = new MonitoringCore();
  const target = new FaultInjectingTarget(core);
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, target, {
    pairs: [
      { symbolId: 'EURUSD', timeframe: '1m' },
      { symbolId: 'XAUUSD', timeframe: '1m' },
    ],
  });
  const obs = collect(adapter);
  adapter.start();

  // EURUSD always throws on evaluation; XAUUSD is unaffected.
  target.failSymbols.add(signalPairKey('EURUSD', '1m'));

  source.emitTick(tick('EURUSD', 1.1, BASE));
  source.emitTick(tick('EURUSD', 1.12, BASE + 60)); // EURUSD close (fails)
  source.emitTick(tick('XAUUSD', 2400, BASE));
  source.emitTick(tick('XAUUSD', 2400.5, BASE + 60)); // XAUUSD close

  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 0);
  assert.equal(adapter.getPairState('XAUUSD', '1m')?.evaluationCount, 1, 'other pair still evaluated');
  assert.equal(
    ofType(obs, 'error').filter((o) => o.stage === 'evaluation' && o.pairKey === signalPairKey('EURUSD', '1m'))
      .length,
    1,
    'the failing pair still reports its own error'
  );
});
