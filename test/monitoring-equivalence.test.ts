/**
 * Phase 2B Stage 1C — headless monitoring core equivalence harness.
 *
 * Proves that the headless core (lib/monitoring/headless-core.ts) is
 * strategy-equivalent to the existing dashboard evaluation path, and that it
 * preserves the existing state/dedup semantics. It requires NO live Deriv
 * connection: candles are injected directly.
 *
 * Fixture note (documented limitation): no existing candle fixture produces a
 * genuine LONG/SHORT through the full candle→SMC→engine pipeline. The richest
 * fixture (`bearZigZag`) resolves real structure but is honestly rejected
 * (NO_TRADE). Genuine-signal state (duplicate suppression, identity) is therefore
 * exercised with constructed `SMCAnalysisResult` objects — the exact same
 * technique the existing `signal-engine.test.ts` suite uses. No candle, price,
 * zone, or signal is fabricated into the candle pipeline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MonitoringCore } from '../lib/monitoring/headless-core';
import {
  CandleManager,
  Candle,
  Timeframe,
  TIMEFRAME_SECONDS,
} from '../lib/deriv/candles';
import { SMCEngine, SMCAnalysisResult } from '../lib/analysis/smc';
import { SignalEngine, SignalContext, SignalOutput } from '../lib/signals/signal-engine';
import { evaluateSignalForPair, PairEvaluation } from '../lib/signals/signal-eval';
import {
  signalPairKey,
  isGeneratedSignal,
  recordGeneratedSignal,
  getGeneratedSignal,
} from '../lib/signals/signal-history';
import { detectNewSignal, NotificationSession } from '../lib/notifications/detector';
import {
  buildTestNotificationEvent,
  isNotificationTestEnabled,
} from '../lib/notifications/test-signal';
import { DerivWebSocketClient } from '../lib/deriv/websocket';
import {
  MarketStructureState,
  StructuralBias,
  SwingPoint,
} from '../lib/analysis/market-structure';
import { BreakType, StructureBreak } from '../lib/analysis/structure-breaks';
import { FairValueGap, FVGState } from '../lib/analysis/fvg';
import { LiquidityLevel, LiquidityState } from '../lib/analysis/liquidity';

// --- Fixtures (copied verbatim from the existing suites; not exported there) ------------------

/** Earliest epoch of the bearZigZag series, used as the confirming epoch. */
const SIG = 1_000_000;

function candle(epoch: number, open: number, high: number, low: number, close: number): Candle {
  return { epoch, open, high, low, close, volume: 10, isClosed: true };
}

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
      out.push(candle((e += 60), p, p + 0.0002, p - 0.0003, p));
    }
    for (let i = 0; i < 2; i++) {
      p += 0.001;
      out.push(candle((e += 60), p, p + 0.0002, p - 0.0003, p));
    }
    p = target + 0.002;
  }
  return out;
}

/** 6 closed Gold candles (gold.test.ts). Too few for context; NO_TRADE. */
function goldCandles(): Candle[] {
  return [
    { epoch: 1000, open: 4180, high: 4195, low: 4170, close: 4190, volume: 10, isClosed: true },
    { epoch: 1060, open: 4190, high: 4205, low: 4180, close: 4200, volume: 10, isClosed: true },
    { epoch: 1120, open: 4200, high: 4230, low: 4195, close: 4225, volume: 10, isClosed: true },
    { epoch: 1180, open: 4225, high: 4220, low: 4190, close: 4200, volume: 10, isClosed: true },
    { epoch: 1240, open: 4200, high: 4205, low: 4175, close: 4180, volume: 10, isClosed: true },
    { epoch: 1300, open: 4180, high: 4260, low: 4178, close: 4255, volume: 10, isClosed: true },
  ];
}

// --- Constructed genuine-signal analysis fixtures (same technique as signal-engine.test.ts) ---

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

// --- Normalization helpers (exclude wall-clock metadata only) ---------------------------------

function normalizedAnalysis(a: SMCAnalysisResult): SMCAnalysisResult {
  return { ...a, analyzedAt: 0 };
}

function normalizedEvaluation(e: PairEvaluation): unknown {
  return {
    analysis: normalizedAnalysis(e.analysis),
    signal: e.signal,
    direction: e.direction,
    evaluatedAt: e.evaluatedAt === null ? null : '<date>',
    closedCandleCount: e.closedCandleCount,
  };
}

/** The existing dashboard path, driven manually for a fair comparison. */
function dashboardEvaluate(
  symbolId: string,
  timeframe: Timeframe,
  candles: readonly Candle[]
): PairEvaluation {
  const manager = new CandleManager();
  manager.seedHistory(
    symbolId,
    timeframe,
    candles.map((c) => ({ epoch: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close }))
  );
  return evaluateSignalForPair(manager, new SMCEngine(), new SignalEngine(), symbolId, timeframe);
}

// =============================================================================================
// Stage 1A — runtime compatibility
// =============================================================================================

test('CORE 1 — existing transport imports and constructs under Node without a live connection', () => {
  const wsCtor = (globalThis as unknown as { WebSocket?: { OPEN?: number } }).WebSocket;
  assert.equal(typeof wsCtor, 'function', 'global WebSocket constructor is available');
  assert.equal(wsCtor?.OPEN, 1, 'WebSocket.OPEN static is available');

  const client = new DerivWebSocketClient({ endpoint: 'wss://example.invalid' });
  assert.equal(client.getStatus(), 'DISCONNECTED', 'constructing does not open a socket');
});

// =============================================================================================
// Candle-path equivalence (existing candles; honestly NO_TRADE)
// =============================================================================================

test('CORE 2 — bearZigZag: headless core and dashboard paths produce identical output', () => {
  const candles = bearZigZag();
  const core = new MonitoringCore();
  core.ingestClosedCandles('EURUSD', '1m', candles);
  const report = core.evaluatePair('EURUSD', '1m');
  const reference = dashboardEvaluate('EURUSD', '1m', candles);

  assert.deepEqual(report.evaluation.signal, reference.signal);
  assert.deepEqual(normalizedEvaluation(report.evaluation), normalizedEvaluation(reference));
  assert.equal(report.pairKey, 'EURUSD:1m');
  assert.equal(report.evaluation.signal?.decision, 'NO_TRADE');

  // A rejected evaluation must not be treated as a new signal.
  assert.equal(report.detection.reason, 'not-generated');
  assert.equal(report.candidate, null);
});

test('CORE 3 — Gold candles: same pipeline and identity on both paths', () => {
  const candles = goldCandles();
  const core = new MonitoringCore();
  core.ingestClosedCandles('XAUUSD', '1m', candles);
  const report = core.evaluatePair('XAUUSD', '1m');
  const reference = dashboardEvaluate('XAUUSD', '1m', candles);

  assert.deepEqual(normalizedEvaluation(report.evaluation), normalizedEvaluation(reference));
  assert.equal(report.evaluation.analysis.symbol, 'XAUUSD');
  assert.equal(report.evaluation.signal?.decision, 'NO_TRADE');
  assert.equal(report.candidate, null);
});

test('CORE 4 — determinism: two fresh cores on identical candles are byte-equivalent', () => {
  const candles = bearZigZag();
  const a = new MonitoringCore();
  const b = new MonitoringCore();
  a.ingestClosedCandles('EURUSD', '1m', candles);
  b.ingestClosedCandles('EURUSD', '1m', candles);
  const ra = a.evaluatePair('EURUSD', '1m');
  const rb = b.evaluatePair('EURUSD', '1m');
  assert.deepEqual(normalizedEvaluation(ra.evaluation), normalizedEvaluation(rb.evaluation));
});

test('CORE 5 — too few closed candles: INSUFFICIENT_DATA equivalence', () => {
  const candles = [
    candle(60, 1.0, 1.01, 0.99, 1.005),
    candle(120, 1.005, 1.02, 1.0, 1.015),
    candle(180, 1.015, 1.03, 1.01, 1.025),
  ];
  const core = new MonitoringCore();
  core.ingestClosedCandles('EURUSD', '1m', candles);
  const report = core.evaluatePair('EURUSD', '1m');
  const reference = dashboardEvaluate('EURUSD', '1m', candles);

  assert.equal(report.evaluation.closedCandleCount, 3);
  assert.deepEqual(report.evaluation.signal?.rejectionReasons, ['INSUFFICIENT_DATA']);
  assert.deepEqual(normalizedEvaluation(report.evaluation), normalizedEvaluation(reference));
  assert.equal(report.candidate, null);
});

test('CORE OBS — an observer-injected SignalEngine is evaluation-equivalent to the default path', () => {
  const candles = bearZigZag();
  const observed: unknown[] = [];
  const observerCore = new MonitoringCore({
    signalEngine: new SignalEngine({ riskRewardObserver: (o) => observed.push(o) }),
  });
  observerCore.ingestClosedCandles('EURUSD', '1m', candles);
  const plainCore = new MonitoringCore();
  plainCore.ingestClosedCandles('EURUSD', '1m', candles);

  const withObserver = observerCore.evaluatePair('EURUSD', '1m');
  const withoutObserver = plainCore.evaluatePair('EURUSD', '1m');
  assert.deepEqual(
    normalizedEvaluation(withObserver.evaluation),
    normalizedEvaluation(withoutObserver.evaluation)
  );

  const reference = dashboardEvaluate('EURUSD', '1m', candles);
  assert.deepEqual(normalizedEvaluation(withObserver.evaluation), normalizedEvaluation(reference));
  // bearZigZag is honestly rejected before the R:R gate, so no candidate is observed here.
  assert.equal(observed.length, 0);
});

// =============================================================================================
// State preservation: duplicate suppression, identity, cross-pair isolation
// =============================================================================================

test('CORE 6 — a genuine signal is emitted once; the reused engine then suppresses the duplicate', () => {
  const core = new MonitoringCore();
  const analysis = genuineLong('EURUSD', '1m', SIG);

  const first = core.signalEngine.evaluate(analysis, ctxAt(SIG, 1.1));
  assert.equal(first.decision, 'LONG');
  assert.equal(isGeneratedSignal(first), true);
  assert.equal(typeof first.signalId, 'string');

  const d1 = core.session.detect({
    signal: first,
    symbolId: 'EURUSD',
    timeframe: '1m',
    pairKey: signalPairKey('EURUSD', '1m'),
    confirmingCandleEpoch: SIG,
  });
  assert.equal(d1.accepted, true);

  const second = core.signalEngine.evaluate(analysis, ctxAt(SIG, 1.1));
  assert.equal(second.decision, 'NO_TRADE');
  assert.deepEqual(second.rejectionReasons, ['DUPLICATE']);
  assert.equal(second.signalId, undefined);

  const d2 = core.session.detect({
    signal: first,
    symbolId: 'EURUSD',
    timeframe: '1m',
    pairKey: signalPairKey('EURUSD', '1m'),
    confirmingCandleEpoch: SIG,
  });
  assert.equal(d2.accepted, false);
  assert.equal(d2.reason, 'duplicate');
});

test('CORE 7 — cross-pair isolation: distinct pairs never leak engine state', () => {
  const core = new MonitoringCore();
  const long1m = genuineLong('EURUSD', '1m', SIG);
  const long5m = genuineLong('EURUSD', '5m', SIG);

  // Both pairs emit independently on the shared engine (no cross-pair suppression).
  const s1m = core.signalEngine.evaluate(long1m, ctxAt(SIG, 1.1));
  const s5m = core.signalEngine.evaluate(long5m, ctxAt(SIG, 1.1));
  assert.equal(s1m.decision, 'LONG');
  assert.equal(s5m.decision, 'LONG');
  assert.notEqual(s1m.signalId, s5m.signalId);
  assert.equal(s1m.signalId, 'EURUSD:1m:trig-long:zone-long');
  assert.equal(s5m.signalId, 'EURUSD:5m:trig-long:zone-long');

  // Re-consuming one pair does not affect the other's duplicate state.
  assert.equal(core.signalEngine.evaluate(long1m, ctxAt(SIG, 1.1)).rejectionReasons?.[0], 'DUPLICATE');
  assert.equal(core.signalEngine.evaluate(long5m, ctxAt(SIG, 1.1)).rejectionReasons?.[0], 'DUPLICATE');
});

test('CORE 8 — candle-path isolation: two symbols evaluated together match independent runs', () => {
  const core = new MonitoringCore();
  core.ingestClosedCandles('EURUSD', '1m', bearZigZag());
  core.ingestClosedCandles('XAUUSD', '1m', bearZigZag());

  const eur = core.evaluatePair('EURUSD', '1m');
  const xau = core.evaluatePair('XAUUSD', '1m');

  assert.equal(eur.pairKey, 'EURUSD:1m');
  assert.equal(xau.pairKey, 'XAUUSD:1m');
  assert.equal(eur.evaluation.analysis.symbol, 'EURUSD');
  assert.equal(xau.evaluation.analysis.symbol, 'XAUUSD');
  assert.deepEqual(
    normalizedEvaluation(eur.evaluation),
    normalizedEvaluation(dashboardEvaluate('EURUSD', '1m', bearZigZag()))
  );
  assert.deepEqual(
    normalizedEvaluation(xau.evaluation),
    normalizedEvaluation(dashboardEvaluate('XAUUSD', '1m', bearZigZag()))
  );
});

test('CORE 9 — signal identity is preserved across the core engine and a fresh dashboard engine', () => {
  const analysis = genuineLong('EURUSD', '1m', SIG);
  const coreSignal = new MonitoringCore().signalEngine.evaluate(analysis, ctxAt(SIG, 1.1));
  const dashboardSignal = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  assert.equal(coreSignal.decision, 'LONG');
  assert.equal(coreSignal.signalId, dashboardSignal.signalId);
  assert.equal(coreSignal.signalId, 'EURUSD:1m:trig-long:zone-long');
});

// =============================================================================================
// Detector validation rules + dev test-event separation + replay safety
// =============================================================================================

test('CORE 10 — existing detector rules accept, then reject invalid/duplicate candidates', () => {
  const good = new SignalEngine().evaluate(genuineLong('EURUSD', '1m', SIG), ctxAt(SIG, 1.1));
  const base = {
    symbolId: 'EURUSD',
    timeframe: '1m',
    pairKey: signalPairKey('EURUSD', '1m'),
    confirmingCandleEpoch: SIG,
  };

  assert.equal(detectNewSignal({ ...base, signal: null }, new Set()).reason, 'not-generated');

  const { signalId: _dropped, ...withoutIdentity } = good;
  assert.equal(
    detectNewSignal({ ...base, signal: withoutIdentity as SignalOutput }, new Set()).reason,
    'missing-identity'
  );

  assert.equal(
    detectNewSignal({ ...base, signal: good, confirmingCandleEpoch: SIG + 60 }, new Set()).reason,
    'epoch-mismatch'
  );

  const session = new NotificationSession();
  assert.equal(session.detect({ ...base, signal: good }).accepted, true);
  assert.equal(session.detect({ ...base, signal: good }).reason, 'duplicate');
  assert.equal(session.size(), 1);
});

test('CORE 11 — dev test events are never genuine signals and never enter retained history', () => {
  const event = buildTestNotificationEvent('nonce-a');
  assert.equal(event.isTest, true);
  assert.equal(isGeneratedSignal(event.signal), false);
  assert.equal(event.signal.decision, 'NO_TRADE');

  // Retained history ignores the test event entirely.
  let store: ReadonlyMap<string, SignalOutput> = new Map();
  store = recordGeneratedSignal(store, event.pairKey, event.signal);
  assert.equal(store.size, 0);
  assert.equal(getGeneratedSignal(store, event.pairKey), null);

  // A genuine signal, by contrast, is retained.
  const genuine = new SignalEngine().evaluate(genuineLong('EURUSD', '1m', SIG), ctxAt(SIG, 1.1));
  const key = signalPairKey('EURUSD', '1m');
  store = recordGeneratedSignal(store, key, genuine);
  assert.equal(getGeneratedSignal(store, key)?.signalId, genuine.signalId);

  // Dev-only gating.
  assert.equal(isNotificationTestEnabled('production'), false);
  assert.equal(isNotificationTestEnabled('development'), true);
});

test('CORE 12 — replaying closed candles creates no new-signal notification', () => {
  const candles = bearZigZag();
  const core = new MonitoringCore();
  core.ingestClosedCandles('EURUSD', '1m', candles);
  const first = core.evaluatePair('EURUSD', '1m');
  const second = core.evaluatePair('EURUSD', '1m');

  assert.equal(first.candidate, null);
  assert.equal(second.candidate, null);
  assert.equal(first.detection.reason, 'not-generated');
  assert.equal(second.detection.reason, 'not-generated');
  assert.equal(core.session.size(), 0);
});

test('CORE 13 — a genuine signal is accepted once, then re-delivery is suppressed', () => {
  const core = new MonitoringCore();
  const good = core.signalEngine.evaluate(genuineLong('EURUSD', '1m', SIG), ctxAt(SIG, 1.1));
  const input = {
    signal: good,
    symbolId: 'EURUSD',
    timeframe: '1m',
    pairKey: signalPairKey('EURUSD', '1m'),
    confirmingCandleEpoch: SIG,
  };

  const first = core.session.detect(input);
  const second = core.session.detect(input);
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'duplicate');
  assert.equal(core.session.size(), 1);
});
