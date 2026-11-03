import test from 'node:test';
import assert from 'node:assert/strict';
import { SMCEngine } from '../lib/analysis/smc';
import {
  SignalEngine,
  resolveTrigger,
  DEFAULT_SIGNAL_ENGINE_CONFIG,
} from '../lib/signals/signal-engine';
import { evaluateSignalForPair } from '../lib/signals/signal-eval';
import { buildSignalView } from '../lib/ui/signal-view';
import { Candle, Timeframe } from '../lib/deriv/candles';

function candle(
  epoch: number,
  open: number,
  high: number,
  low: number,
  close: number
): Candle {
  return { epoch, open, high, low, close, volume: 10, isClosed: true };
}

/**
 * A 5-leg bearish zig-zag that the structure analyzer resolves to 9 swings, a
 * BEARISH structural bias, and a TREND_CONTINUATION trigger (probe-verified).
 * Candles carry no symbol field (the pair is supplied to the engine, and
 * `getHistory` is scoped to a symbol inside `CandleManager`).
 */
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

test('SIGNAL-EVAL — empty history clears the panel state (no stale signal)', () => {
  const r = evaluateSignalForPair(
    new FakeCandleManager([]),
    new SMCEngine(),
    new SignalEngine(),
    'EURUSD',
    '1m'
  );
  assert.equal(r.closedCandleCount, 0);
  assert.equal(r.signal, null);
  assert.equal(r.direction, null);
  assert.equal(r.evaluatedAt, null);
});

test('SIGNAL-EVAL — evaluates a pair from closed candles with engine parity', () => {
  const symbol = 'EURUSD';
  const cs = bearZigZag();
  const r = evaluateSignalForPair(
    new FakeCandleManager(cs),
    new SMCEngine(),
    new SignalEngine(),
    symbol,
    '1m'
  );

  assert.ok(r.closedCandleCount > 0);
  assert.ok(r.evaluatedAt instanceof Date);
  assert.ok(r.signal, 'expected a real SignalOutput');

  const analysis = new SMCEngine().analyze(symbol, '1m', cs);
  const direct = new SignalEngine().evaluate(analysis, {
    lastClosedCandle: cs[cs.length - 1],
  });
  assert.equal(r.signal.decision, direct.decision);
  assert.deepEqual(r.signal.rejectionReasons, direct.rejectionReasons);

  const tr = resolveTrigger(
    r.analysis.marketStructure.breaks,
    r.analysis.marketStructure.structuralBias,
    cs[cs.length - 1].epoch,
    '1m',
    DEFAULT_SIGNAL_ENGINE_CONFIG
  );
  assert.equal(r.direction, tr.direction);
  assert.equal(r.direction, 'BEARISH');
});

test('SIGNAL-EVAL — gold flows through the exact same pipeline as EURUSD', () => {
  const eurCs = bearZigZag();
  const xauCs = bearZigZag();

  const eur = evaluateSignalForPair(
    new FakeCandleManager(eurCs),
    new SMCEngine(),
    new SignalEngine(),
    'EURUSD',
    '1m'
  );
  const xau = evaluateSignalForPair(
    new FakeCandleManager(xauCs),
    new SMCEngine(),
    new SignalEngine(),
    'XAUUSD',
    '1m'
  );

  // Both run the identical code path and produce a genuine, rejected outcome.
  assert.ok(eur.signal);
  assert.ok(xau.signal);
  assert.equal(eur.signal.decision, 'NO_TRADE');
  assert.equal(xau.signal.decision, 'NO_TRADE');
  assert.ok((xau.signal.rejectionReasons ?? []).length > 0);

  // Each instrument's direction agrees with the engine's own resolver output
  // for that instrument (gold's coarser tick size may legitimately resolve no
  // context on this synthetic series, so we only assert self-consistency).
  const xauTr = resolveTrigger(
    xau.analysis.marketStructure.breaks,
    xau.analysis.marketStructure.structuralBias,
    xauCs[xauCs.length - 1].epoch,
    '1m',
    DEFAULT_SIGNAL_ENGINE_CONFIG
  );
  assert.equal(xau.direction, xauTr.direction);
});

// --- Phase 12: insufficient closed history flows to an honest panel status ---

test('SIGNAL-EVAL — too few closed candles yields a real INSUFFICIENT_DATA evaluation', () => {
  // Three closed candles: the swing loop (leftBars = rightBars = 2) cannot
  // produce a confirmed pivot, so structure is genuinely insufficient — this is
  // not a valid no-trade result.
  const cs = [
    candle(60, 1.0, 1.01, 0.99, 1.005),
    candle(120, 1.005, 1.02, 1.0, 1.015),
    candle(180, 1.015, 1.03, 1.01, 1.025),
  ];
  const r = evaluateSignalForPair(
    new FakeCandleManager(cs),
    new SMCEngine(),
    new SignalEngine(),
    'EURUSD',
    '1m'
  );

  assert.equal(r.closedCandleCount, 3);
  assert.ok(r.evaluatedAt instanceof Date, 'an evaluation actually ran');
  assert.ok(r.signal, 'a real engine output is returned');
  assert.equal(r.signal.decision, 'NO_TRADE');
  assert.deepEqual(r.signal.rejectionReasons, ['INSUFFICIENT_DATA']);

  // The dashboard feeds exactly these fields to SignalPanel; the status must not
  // claim a completed analysis.
  const view = buildSignalView({
    signal: r.signal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    direction: r.direction,
    evaluatedAt: r.evaluatedAt,
    hasClosedCandles: r.closedCandleCount > 0,
  });
  assert.equal(view.status, 'INSUFFICIENT DATA');
  assert.notEqual(view.status, 'EVALUATED');
});