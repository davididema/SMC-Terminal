import test from 'node:test';
import assert from 'node:assert/strict';
import { LiquidityAnalyzer } from '../lib/analysis/liquidity';
import {
  MarketStructureState,
  SwingPoint,
  SwingType,
} from '../lib/analysis/market-structure';
import { Candle, Timeframe } from '../lib/deriv/candles';

const TOL = 0.0001;

function createCandle(
  epoch: number,
  open: number,
  high: number,
  low: number,
  close: number,
  isClosed = true
): Candle {
  return { epoch, open, high, low, close, volume: 10, isClosed };
}

function makeSwing(
  symbol: string,
  timeframe: Timeframe,
  type: SwingType,
  price: number,
  epoch: number
): SwingPoint {
  return {
    id: `${symbol}:${timeframe}:${epoch}:${type}`,
    symbol,
    timeframe,
    type,
    candleEpoch: epoch,
    swingCandleEpoch: epoch,
    confirmedAtEpoch: epoch + 2,
    price,
    candleIndex: 0,
    structureType: type === 'HIGH' ? 'HH' : 'LL',
  };
}

function makeStructure(
  symbol: string,
  timeframe: Timeframe,
  swings: SwingPoint[]
): MarketStructureState {
  return {
    symbol,
    timeframe,
    structuralBias: 'NEUTRAL',
    swings,
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
}

test('LIQ 1 — Levels derived from confirmed swings', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: TOL });
  const structure = makeStructure('EURUSD', '1m', [
    makeSwing('EURUSD', '1m', 'HIGH', 1.1, 100),
    makeSwing('EURUSD', '1m', 'LOW', 1.09, 200),
  ]);
  const state = analyzer.analyze('EURUSD', '1m', [], structure);
  assert.equal(state.status, 'ACTIVE');
  assert.equal(state.buySideLiquidity.length, 1);
  assert.equal(state.sellSideLiquidity.length, 1);
  assert.equal(state.buySideLiquidity[0].price, 1.1);
  assert.equal(state.buySideLiquidity[0].type, 'BUY_SIDE');
  assert.equal(state.buySideLiquidity[0].id, 'EURUSD:1m:LIQ:BUY_SIDE:100');
  assert.equal(state.sellSideLiquidity[0].id, 'EURUSD:1m:LIQ:SELL_SIDE:200');
});

test('LIQ 2 — Buy-side sweep-on-rejection marks first qualifying candle', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: TOL });
  const structure = makeStructure('EURUSD', '1m', [
    makeSwing('EURUSD', '1m', 'HIGH', 1.1, 10),
  ]);
  const candles = [
    createCandle(11, 1.0999, 1.10005, 1.0998, 1.0999),
    createCandle(12, 1.0998, 1.1002, 1.0997, 1.0998),
  ];
  const state = analyzer.analyze('EURUSD', '1m', candles, structure);
  const level = state.buySideLiquidity[0];
  assert.equal(level.swept, true);
  assert.equal(level.sweptEpoch, 12);
});

test('LIQ 3 — A touch within tolerance is not a sweep', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: TOL });
  const structure = makeStructure('EURUSD', '1m', [
    makeSwing('EURUSD', '1m', 'HIGH', 1.1, 10),
  ]);
  const candles = [createCandle(11, 1.0999, 1.10005, 1.0998, 1.0999)];
  const state = analyzer.analyze('EURUSD', '1m', candles, structure);
  assert.equal(state.buySideLiquidity[0].swept, false);
  assert.equal(state.buySideLiquidity[0].sweptEpoch, undefined);
});

test('LIQ 4 — A close-through is not a sweep', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: TOL });
  const structure = makeStructure('EURUSD', '1m', [
    makeSwing('EURUSD', '1m', 'HIGH', 1.1, 10),
  ]);
  const candles = [createCandle(11, 1.0999, 1.1003, 1.0999, 1.1005)];
  const state = analyzer.analyze('EURUSD', '1m', candles, structure);
  assert.equal(state.buySideLiquidity[0].swept, false);
});

test('LIQ 5 — First sweep is retained (no un-set)', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: TOL });
  const structure = makeStructure('EURUSD', '1m', [
    makeSwing('EURUSD', '1m', 'HIGH', 1.1, 10),
  ]);
  const candles = [
    createCandle(11, 1.0998, 1.1002, 1.0997, 1.0998),
    createCandle(12, 1.0998, 1.1009, 1.099, 1.0992),
  ];
  const state = analyzer.analyze('EURUSD', '1m', candles, structure);
  const level = state.buySideLiquidity[0];
  assert.equal(level.swept, true);
  assert.equal(level.sweptEpoch, 11);
});

test('LIQ 6 — One candle can sweep multiple buy-side levels', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: TOL });
  const structure = makeStructure('EURUSD', '1m', [
    makeSwing('EURUSD', '1m', 'HIGH', 1.1, 10),
    makeSwing('EURUSD', '1m', 'HIGH', 1.1003, 20),
  ]);
  const candles = [createCandle(21, 1.1, 1.1006, 1.099, 1.0995)];
  const state = analyzer.analyze('EURUSD', '1m', candles, structure);
  assert.equal(state.buySideLiquidity.length, 2);
  assert.equal(state.buySideLiquidity[0].swept, true);
  assert.equal(state.buySideLiquidity[1].swept, true);
  assert.equal(state.buySideLiquidity[0].sweptEpoch, 21);
});

test('LIQ 7 — Sell-side sweep symmetry', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: TOL });
  const structure = makeStructure('EURUSD', '1m', [
    makeSwing('EURUSD', '1m', 'LOW', 1.09, 10),
  ]);
  const candles = [createCandle(11, 1.0898, 1.091, 1.0895, 1.0905)];
  const state = analyzer.analyze('EURUSD', '1m', candles, structure);
  const level = state.sellSideLiquidity[0];
  assert.equal(level.swept, true);
  assert.equal(level.sweptEpoch, 11);
});

test('LIQ 8 — EQH clustering uses fixed anchor (no transitive chaining)', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: 0.0002 });
  const structure = makeStructure('EURUSD', '1m', [
    makeSwing('EURUSD', '1m', 'HIGH', 1.1, 100),
    makeSwing('EURUSD', '1m', 'HIGH', 1.1001, 200),
    makeSwing('EURUSD', '1m', 'HIGH', 1.1002, 300),
    makeSwing('EURUSD', '1m', 'HIGH', 1.1005, 400),
  ]);
  const state = analyzer.analyze('EURUSD', '1m', [], structure);
  assert.equal(state.equalHighs.length, 1);
  const eqh = state.equalHighs[0];
  assert.equal(eqh.price, 1.1002);
  assert.equal(eqh.count, 3);
  assert.equal(eqh.epoch, 300);
  assert.equal(eqh.type, 'EQH');
  assert.equal(eqh.id, 'EURUSD:1m:LIQ:EQH:100');
  assert.ok(eqh.tolerancePips !== undefined);
  assert.ok(Math.abs(eqh.tolerancePips - 2) < 1e-9);
});

test('LIQ 9 — Exact tolerance boundary joins the cluster', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: 0.0002 });
  const structure = makeStructure('EURUSD', '1m', [
    makeSwing('EURUSD', '1m', 'HIGH', 1.1, 100),
    makeSwing('EURUSD', '1m', 'HIGH', 1.1002, 200),
  ]);
  const state = analyzer.analyze('EURUSD', '1m', [], structure);
  assert.equal(state.equalHighs.length, 1);
  assert.equal(state.equalHighs[0].count, 2);
});

test('LIQ 10 — A lone swing does not form an EQH/EQL', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: TOL });
  const structure = makeStructure('EURUSD', '1m', [
    makeSwing('EURUSD', '1m', 'HIGH', 1.1, 100),
  ]);
  const state = analyzer.analyze('EURUSD', '1m', [], structure);
  assert.equal(state.equalHighs.length, 0);
  assert.equal(state.equalLows.length, 0);
});

test('LIQ 11 — EQL clustering takes the cluster minimum', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: 0.0002 });
  const structure = makeStructure('EURUSD', '1m', [
    makeSwing('EURUSD', '1m', 'LOW', 1.09, 100),
    makeSwing('EURUSD', '1m', 'LOW', 1.0901, 200),
    makeSwing('EURUSD', '1m', 'LOW', 1.0902, 300),
  ]);
  const state = analyzer.analyze('EURUSD', '1m', [], structure);
  assert.equal(state.equalLows.length, 1);
  assert.equal(state.equalLows[0].price, 1.09);
  assert.equal(state.equalLows[0].count, 3);
  assert.equal(state.equalLows[0].type, 'EQL');
});

test('LIQ 12 — Clustering is independent of input swing order', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: 0.0002 });
  const swings = [
    makeSwing('EURUSD', '1m', 'HIGH', 1.1, 400),
    makeSwing('EURUSD', '1m', 'HIGH', 1.1001, 100),
    makeSwing('EURUSD', '1m', 'HIGH', 1.1002, 300),
    makeSwing('EURUSD', '1m', 'HIGH', 1.10005, 200),
  ];
  const state = analyzer.analyze('EURUSD', '1m', [], makeStructure('EURUSD', '1m', swings));
  assert.equal(state.equalHighs.length, 1);
  assert.equal(state.equalHighs[0].price, 1.1002);
  assert.equal(state.equalHighs[0].count, 4);
  assert.equal(state.equalHighs[0].id, 'EURUSD:1m:LIQ:EQH:100');
});

test('LIQ 13 — Symbol/timeframe isolation', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: TOL });
  const eur = analyzer.analyze(
    'EURUSD',
    '1m',
    [],
    makeStructure('EURUSD', '1m', [makeSwing('EURUSD', '1m', 'HIGH', 1.1, 100)])
  );
  const gbp = analyzer.analyze(
    'GBPUSD',
    '5m',
    [],
    makeStructure('GBPUSD', '5m', [makeSwing('GBPUSD', '5m', 'HIGH', 1.3, 100)])
  );
  assert.equal(eur.symbol, 'EURUSD');
  assert.equal(eur.timeframe, '1m');
  assert.equal(gbp.timeframe, '5m');
  assert.equal(eur.buySideLiquidity[0].id, 'EURUSD:1m:LIQ:BUY_SIDE:100');
  assert.equal(gbp.buySideLiquidity[0].id, 'GBPUSD:5m:LIQ:BUY_SIDE:100');
});

test('LIQ 14 — No swings yields WAITING FOR DATA', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: TOL });
  const state = analyzer.analyze('EURUSD', '1m', [], makeStructure('EURUSD', '1m', []));
  assert.equal(state.status, 'WAITING FOR DATA');
  assert.equal(state.buySideLiquidity.length, 0);
});

test('LIQ 15 — Forming candle is ignored when sweeping', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: TOL });
  const structure = makeStructure('EURUSD', '1m', [
    makeSwing('EURUSD', '1m', 'HIGH', 1.1, 10),
  ]);
  const candles = [createCandle(11, 1.0998, 1.1009, 1.099, 1.0992, false)];
  const state = analyzer.analyze('EURUSD', '1m', candles, structure);
  assert.equal(state.buySideLiquidity[0].swept, false);
});

test('LIQ 16 — tolerancePips uses conventional FX pips for EURUSD (pipSize 5)', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: 0.0002 });
  const structure = makeStructure('EURUSD', '1m', [
    makeSwing('EURUSD', '1m', 'HIGH', 1.1, 100),
    makeSwing('EURUSD', '1m', 'HIGH', 1.1002, 200),
  ]);
  const state = analyzer.analyze('EURUSD', '1m', [], structure);
  const eqh = state.equalHighs[0];
  assert.ok(eqh.tolerancePips !== undefined);
  assert.ok(Math.abs(eqh.tolerancePips - 2) < 1e-9);
});

test('LIQ 17 — tolerancePips uses 0.01 units for USDJPY (pipSize 3)', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: 0.02 });
  const structure = makeStructure('USDJPY', '1m', [
    makeSwing('USDJPY', '1m', 'HIGH', 150.0, 100),
    makeSwing('USDJPY', '1m', 'HIGH', 150.01, 200),
  ]);
  const state = analyzer.analyze('USDJPY', '1m', [], structure);
  const eqh = state.equalHighs[0];
  assert.equal(eqh.count, 2);
  assert.ok(eqh.tolerancePips !== undefined);
  assert.ok(Math.abs(eqh.tolerancePips - 2) < 1e-9);
});

test('LIQ 18 — tolerancePips uses price-scaled units for V75 (pipSize 4)', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: 0.05 });
  const structure = makeStructure('V75', '1m', [
    makeSwing('V75', '1m', 'HIGH', 250000, 100),
    makeSwing('V75', '1m', 'HIGH', 250000.04, 200),
  ]);
  const state = analyzer.analyze('V75', '1m', [], structure);
  const eqh = state.equalHighs[0];
  assert.equal(eqh.count, 2);
  assert.ok(eqh.tolerancePips !== undefined);
  assert.ok(Math.abs(eqh.tolerancePips - 50) < 1e-9);
});

test('LIQ 19 — Unsupported symbol yields no tolerancePips conversion', () => {
  const analyzer = new LiquidityAnalyzer({ customTolerance: 0.0002 });
  const structure = makeStructure('ZZZUSD', '1m', [
    makeSwing('ZZZUSD', '1m', 'HIGH', 1900, 100),
    makeSwing('ZZZUSD', '1m', 'HIGH', 1900.0001, 200),
  ]);
  const state = analyzer.analyze('ZZZUSD', '1m', [], structure);
  const eqh = state.equalHighs[0];
  assert.equal(eqh.count, 2);
  assert.equal(eqh.tolerancePips, undefined);
});
