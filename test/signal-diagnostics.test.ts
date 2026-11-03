import test from 'node:test';
import assert from 'node:assert/strict';
import { SignalDiagnostics } from '../lib/signals/signal-diagnostics';
import { SignalEngine, SignalOutput } from '../lib/signals/signal-engine';
import { evaluateSignalForPair } from '../lib/signals/signal-eval';
import { SMCEngine } from '../lib/analysis/smc';
import { Candle, Timeframe } from '../lib/deriv/candles';

function candle(epoch: number, open: number, high: number, low: number, close: number): Candle {
  return { epoch, open, high, low, close, volume: 10, isClosed: true };
}

function signal(
  decision: SignalOutput['decision'],
  rejectionReasons?: SignalOutput['rejectionReasons']
): SignalOutput {
  const isTrade = decision === 'LONG' || decision === 'SHORT';
  return {
    decision,
    confidence: isTrade ? 50 : null,
    setup: isTrade ? 'TREND_CONTINUATION' : 'NONE',
    entry: isTrade ? 1.1 : null,
    stopLoss: isTrade ? 1.09 : null,
    takeProfit: isTrade ? 1.13 : null,
    riskReward: isTrade ? 2 : null,
    reason: 'test',
    timestamp: 1750000000,
    ...(rejectionReasons ? { rejectionReasons } : {}),
  };
}

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

class FakeCandleManager {
  constructor(private history: Candle[]) {}
  getHistory(_symbolId: string, _timeframe: Timeframe): Candle[] {
    return this.history;
  }
}

test('DIAG 1 — LONG evaluation counting', () => {
  const d = new SignalDiagnostics();
  const now = new Date('2026-01-01T00:00:00.000Z');
  d.incrementCompletedEvaluation({
    symbolId: 'EURUSD',
    timeframe: '1m',
    signal: signal('LONG', []),
    evaluatedAt: now,
  });
  const p = d.getPairDiagnostics('EURUSD', '1m');
  assert.equal(p.completedEvaluations, 1);
  assert.equal(p.longEmissions, 1);
  assert.equal(p.shortEmissions, 0);
  assert.equal(p.noTradeResults, 0);
  assert.equal(p.rejections.total, 0);
});

test('DIAG 2 — SHORT evaluation counting', () => {
  const d = new SignalDiagnostics();
  d.incrementCompletedEvaluation({
    symbolId: 'EURUSD',
    timeframe: '1m',
    signal: signal('SHORT', []),
    evaluatedAt: new Date(),
  });
  const p = d.getPairDiagnostics('EURUSD', '1m');
  assert.equal(p.shortEmissions, 1);
  assert.equal(p.longEmissions, 0);
});

test('DIAG 3 — NO_TRADE evaluation counting', () => {
  const d = new SignalDiagnostics();
  d.incrementCompletedEvaluation({
    symbolId: 'EURUSD',
    timeframe: '1m',
    signal: signal('NO_TRADE', ['NO_CONTEXT']),
    evaluatedAt: new Date(),
  });
  const p = d.getPairDiagnostics('EURUSD', '1m');
  assert.equal(p.noTradeResults, 1);
  assert.equal(p.completedEvaluations, 1);
  assert.equal(p.rejections.total, 1);
  assert.equal(p.rejections.codes.NO_CONTEXT, 1);
});

test('DIAG 4 — multiple rejection reasons', () => {
  const d = new SignalDiagnostics();
  d.incrementCompletedEvaluation({
    symbolId: 'EURUSD',
    timeframe: '1m',
    signal: signal('NO_TRADE', ['ZONE_MISALIGNED', 'NO_FRESH_SWEEP']),
    evaluatedAt: new Date(),
  });
  const p = d.getPairDiagnostics('EURUSD', '1m');
  assert.equal(p.rejections.total, 2);
  assert.equal(p.rejections.codes.ZONE_MISALIGNED, 1);
  assert.equal(p.rejections.codes.NO_FRESH_SWEEP, 1);
  assert.equal(p.rejections.duplicate, 0);
});

test('DIAG 5 — duplicate rejection counting', () => {
  const d = new SignalDiagnostics();
  d.incrementCompletedEvaluation({
    symbolId: 'EURUSD',
    timeframe: '1m',
    signal: signal('NO_TRADE', ['DUPLICATE']),
    evaluatedAt: new Date(),
  });
  const p = d.getPairDiagnostics('EURUSD', '1m');
  assert.equal(p.rejections.duplicate, 1);
  assert.equal(p.rejections.total, 1);
});

test('DIAG 6/7 — symbol and timeframe isolation', () => {
  const d = new SignalDiagnostics();
  d.incrementCompletedEvaluation({
    symbolId: 'EURUSD',
    timeframe: '1m',
    signal: signal('NO_TRADE', ['NO_CONTEXT']),
    evaluatedAt: new Date(),
  });
  d.incrementCompletedEvaluation({
    symbolId: 'XAUUSD',
    timeframe: '1m',
    signal: signal('NO_TRADE', ['NO_CONTEXT']),
    evaluatedAt: new Date(),
  });
  d.incrementCompletedEvaluation({
    symbolId: 'EURUSD',
    timeframe: '5m',
    signal: signal('NO_TRADE', ['NO_CONTEXT']),
    evaluatedAt: new Date(),
  });
  assert.equal(d.getPairDiagnostics('EURUSD', '1m').completedEvaluations, 1);
  assert.equal(d.getPairDiagnostics('XAUUSD', '1m').completedEvaluations, 1);
  assert.equal(d.getPairDiagnostics('EURUSD', '5m').completedEvaluations, 1);
});

test('DIAG 8 — reset behaviour', () => {
  const d = new SignalDiagnostics();
  d.incrementCompletedEvaluation({
    symbolId: 'EURUSD',
    timeframe: '1m',
    signal: signal('NO_TRADE', []),
    evaluatedAt: new Date(),
  });
  assert.equal(d.getPairDiagnostics('EURUSD', '1m').completedEvaluations, 1);
  d.resetPair('EURUSD', '1m');
  assert.equal(d.getPairDiagnostics('EURUSD', '1m').completedEvaluations, 0);
  d.resetAll();
});

test('DIAG 9 — bounded storage of recent timestamps', () => {
  const d = new SignalDiagnostics(2);
  const base = new Date('2026-01-01T00:00:00.000Z');
  d.incrementCompletedEvaluation({
    symbolId: 'EURUSD',
    timeframe: '1m',
    signal: signal('NO_TRADE', []),
    evaluatedAt: new Date(base.getTime() + 0),
  });
  d.incrementCompletedEvaluation({
    symbolId: 'EURUSD',
    timeframe: '1m',
    signal: signal('NO_TRADE', []),
    evaluatedAt: new Date(base.getTime() + 1000),
  });
  d.incrementCompletedEvaluation({
    symbolId: 'EURUSD',
    timeframe: '1m',
    signal: signal('NO_TRADE', []),
    evaluatedAt: new Date(base.getTime() + 2000),
  });
  assert.equal(d.getPairDiagnostics('EURUSD', '1m').evaluationTimestamps.length, 2);
});

test('DIAG 10 — skipped evaluations recorded', () => {
  const d = new SignalDiagnostics();
  d.incrementSkippedEvaluation('EURUSD', '1m', new Date());
  d.incrementSkippedEvaluation('EURUSD', '1m', new Date());
  const p = d.getPairDiagnostics('EURUSD', '1m');
  assert.equal(p.skippedEvaluations, 2);
  assert.equal(p.completedEvaluations, 0);
});

test('DIAG 11 — integration with evaluateSignalForPair counts once', () => {
  const cs = bearZigZag();
  const d = new SignalDiagnostics();
  const res = evaluateSignalForPair(
    new FakeCandleManager(cs),
    new SMCEngine(),
    new SignalEngine(),
    'EURUSD',
    '1m',
    d
  );
  assert.ok(res.signal);
  const p = d.getPairDiagnostics('EURUSD', '1m');
  assert.equal(p.completedEvaluations, 1);
});

test('DIAG 12 — empty history records a skipped attempt, not a completed evaluation', () => {
  const d = new SignalDiagnostics();
  evaluateSignalForPair(new FakeCandleManager([]), new SMCEngine(), new SignalEngine(), 'EURUSD', '1m', d);
  const p = d.getPairDiagnostics('EURUSD', '1m');
  assert.equal(p.completedEvaluations, 0);
  assert.equal(p.skippedEvaluations, 1);
  assert.equal(p.noTradeResults, 0);
});
