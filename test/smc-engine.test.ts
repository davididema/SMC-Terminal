import test from 'node:test';
import assert from 'node:assert/strict';
import { SMCEngine, SMCAnalysisResult } from '../lib/analysis/smc';
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

function baseCandles(): Candle[] {
  return [
    candle(1000, 98, 100, 95, 99),
    candle(1060, 99, 102, 97, 101),
    candle(1120, 101, 105, 99, 104),
    candle(1180, 104, 103, 100, 101),
    candle(1240, 101, 101, 98, 99),
    candle(1300, 99, 110, 98, 109),
  ];
}

function gbpCandles(): Candle[] {
  return [
    candle(1000, 200, 205, 195, 202),
    candle(1060, 202, 208, 198, 206),
    candle(1120, 206, 220, 203, 215),
    candle(1180, 215, 213, 205, 208),
    candle(1240, 208, 206, 199, 202),
    candle(1300, 202, 230, 200, 228),
  ];
}

function stable(result: SMCAnalysisResult): string {
  return JSON.stringify({ ...result, analyzedAt: 0 });
}

test('SMC 1 — Aggregate result keeps the requested pair across all components', () => {
  const engine = new SMCEngine();
  const result = engine.analyze('EURUSD', '1m', baseCandles());
  assert.equal(result.symbol, 'EURUSD');
  assert.equal(result.timeframe, '1m');
  assert.equal(result.marketStructure.symbol, 'EURUSD');
  assert.equal(result.liquidity.symbol, 'EURUSD');
  assert.equal(result.liquidity.timeframe, '1m');
  assert.equal(result.fvg.symbol, 'EURUSD');
  assert.equal(result.orderBlocks.symbol, 'EURUSD');
  assert.equal(result.marketStructure.swings.length, 1);
  assert.equal(result.marketStructure.swings[0].id.startsWith('EURUSD:1m:'), true);
});

test('SMC 2 — Analysis is deterministic for unchanged closed input', () => {
  const engine = new SMCEngine();
  const candles = baseCandles();
  const first = engine.analyze('EURUSD', '1m', candles);
  const second = engine.analyze('EURUSD', '1m', candles);
  assert.equal(stable(first), stable(second));
});

test('SMC 3 — Forming candle does not change any analysis output', () => {
  const engine = new SMCEngine();
  const closed = baseCandles();
  const withForming = [...closed, candle(1360, 109, 112, 108, 111.5, false)];
  const base = engine.analyze('EURUSD', '1m', closed);
  const formed = engine.analyze('EURUSD', '1m', withForming);
  assert.equal(stable(base), stable(formed));
});

test('SMC 4 — Symbol/timeframe isolation across two pairs', () => {
  const engine = new SMCEngine();
  const eur = engine.analyze('EURUSD', '1m', baseCandles());
  const gbp = engine.analyze('GBPUSD', '5m', gbpCandles());
  assert.equal(eur.marketStructure.swings[0].price, 105);
  assert.equal(gbp.marketStructure.swings[0].price, 220);
  assert.equal(eur.marketStructure.swings[0].symbol, 'EURUSD');
  assert.equal(gbp.marketStructure.swings[0].symbol, 'GBPUSD');
  assert.equal(gbp.marketStructure.swings[0].timeframe, '5m');
  assert.equal(gbp.liquidity.symbol, 'GBPUSD');
  assert.equal(gbp.liquidity.timeframe, '5m');
});

test('SMC 5 — Liquidity levels carry buy/sell and pair identity', () => {
  const engine = new SMCEngine();
  const result = engine.analyze('EURUSD', '1m', baseCandles());
  assert.equal(result.liquidity.buySideLiquidity.length, 1);
  assert.equal(result.liquidity.buySideLiquidity[0].price, 105);
  assert.equal(result.liquidity.buySideLiquidity[0].id, 'EURUSD:1m:LIQ:BUY_SIDE:1120');
});

test('SMC 6 — Empty input yields waiting states without throwing', () => {
  const engine = new SMCEngine();
  const result = engine.analyze('EURUSD', '1m', []);
  assert.equal(result.fvg.status, 'WAITING FOR DATA');
  assert.equal(result.liquidity.status, 'WAITING FOR DATA');
  assert.equal(result.orderBlocks.status, 'WAITING FOR DATA');
  assert.equal(result.marketStructure.swings.length, 0);
  assert.equal(result.zone, 'WAITING FOR DATA');
});

test('SMC 7 — Same symbol, different timeframes stay isolated', () => {
  const engine = new SMCEngine();
  const oneMinute = engine.analyze('EURUSD', '1m', baseCandles());
  const fiveMinute = engine.analyze('EURUSD', '5m', baseCandles());
  assert.equal(oneMinute.marketStructure.swings[0].id, 'EURUSD:1m:1120:HIGH');
  assert.equal(fiveMinute.marketStructure.swings[0].id, 'EURUSD:5m:1120:HIGH');
  assert.equal(oneMinute.liquidity.buySideLiquidity[0].id, 'EURUSD:1m:LIQ:BUY_SIDE:1120');
  assert.equal(fiveMinute.liquidity.buySideLiquidity[0].id, 'EURUSD:5m:LIQ:BUY_SIDE:1120');
  assert.equal(oneMinute.marketStructure.timeframe, '1m');
  assert.equal(fiveMinute.marketStructure.timeframe, '5m');
});
