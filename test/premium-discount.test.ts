import test from 'node:test';
import assert from 'node:assert/strict';
import { SMCEngine } from '../lib/analysis/smc';
import { Candle } from '../lib/deriv/candles';

function candle(
  epoch: number,
  open: number,
  high: number,
  low: number,
  close: number,
  isClosed = true
): Candle {
  return { epoch, open, high, low, close, volume: 10, isClosed };
}

/**
 * Produces a series whose latest confirmed swings are:
 *   swing low = 1.1000 (@ epoch 1020), swing high = 1.1100 (@ epoch 1060).
 * Dealing range = 0.0100, equilibrium = 1.1050, band = 0.0005 (equilibrium zone 1.1045..1.1055).
 * The final candle's close is supplied so the zone can be probed at exact boundaries.
 */
function rangeCandles(finalClose: number): Candle[] {
  const finalOpen = 1.105;
  const high = Math.max(finalOpen, finalClose) + 0.0002;
  const low = Math.min(finalOpen, finalClose) - 0.0002;
  return [
    candle(1000, 1.105, 1.106, 1.1045, 1.1055),
    candle(1010, 1.1055, 1.1065, 1.104, 1.105),
    candle(1020, 1.105, 1.1055, 1.1, 1.101),
    candle(1030, 1.101, 1.103, 1.1015, 1.1025),
    candle(1040, 1.1025, 1.1045, 1.102, 1.104),
    candle(1050, 1.104, 1.108, 1.1035, 1.1075),
    candle(1060, 1.1075, 1.11, 1.107, 1.109),
    candle(1070, 1.109, 1.1095, 1.108, 1.1085),
    candle(1080, 1.1085, 1.109, 1.108, 1.1085),
    candle(1090, finalOpen, high, low, finalClose),
  ];
}

test('PD 1 — Premium classification', () => {
  const engine = new SMCEngine();
  const result = engine.analyze('EURUSD', '1m', rangeCandles(1.107));
  assert.equal(result.zone, 'PREMIUM');
});

test('PD 2 — Discount classification', () => {
  const engine = new SMCEngine();
  const result = engine.analyze('EURUSD', '1m', rangeCandles(1.103));
  assert.equal(result.zone, 'DISCOUNT');
});

test('PD 3 — Equilibrium classification at the exact midpoint', () => {
  const engine = new SMCEngine();
  const result = engine.analyze('EURUSD', '1m', rangeCandles(1.105));
  assert.equal(result.zone, 'EQUILIBRIUM');
});

test('PD 4 — Exact equilibrium boundaries are inclusive', () => {
  const engine = new SMCEngine();
  assert.equal(engine.analyze('EURUSD', '1m', rangeCandles(1.1055)).zone, 'EQUILIBRIUM');
  assert.equal(engine.analyze('EURUSD', '1m', rangeCandles(1.1045)).zone, 'EQUILIBRIUM');
});

test('PD 5 — Just beyond the equilibrium boundaries flips the zone', () => {
  const engine = new SMCEngine();
  assert.equal(engine.analyze('EURUSD', '1m', rangeCandles(1.1056)).zone, 'PREMIUM');
  assert.equal(engine.analyze('EURUSD', '1m', rangeCandles(1.1044)).zone, 'DISCOUNT');
});

test('PD 6 — Missing dealing range yields WAITING FOR DATA', () => {
  const engine = new SMCEngine();
  const result = engine.analyze('EURUSD', '1m', [
    candle(1000, 98, 100, 95, 99),
    candle(1060, 99, 102, 97, 101),
  ]);
  assert.equal(result.zone, 'WAITING FOR DATA');
});

test('PD 7 — Price is the last closed candle close', () => {
  const engine = new SMCEngine();
  const closed = rangeCandles(1.105);
  const withForming = [
    ...closed,
    candle(1100, 1.105, 1.12, 1.09, 1.1199, false),
  ];
  assert.equal(engine.analyze('EURUSD', '1m', withForming).zone, 'EQUILIBRIUM');
});
