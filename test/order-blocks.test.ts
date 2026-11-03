import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderBlockAnalyzer, OrderBlock } from '../lib/analysis/order-blocks';
import {
  MarketStructureState,
  SwingPoint,
  SwingType,
} from '../lib/analysis/market-structure';
import { BreakType, StructureBreak } from '../lib/analysis/structure-breaks';
import { Candle, Timeframe } from '../lib/deriv/candles';

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

function makeBreak(
  symbol: string,
  timeframe: Timeframe,
  type: BreakType,
  breakCandleEpoch: number,
  brokenSwingEpoch: number,
  brokenPrice: number
): StructureBreak {
  const direction = type.startsWith('BULLISH') ? 'BULLISH' : 'BEARISH';
  return {
    id: `${symbol}:${timeframe}:${type}:${breakCandleEpoch}:${brokenSwingEpoch}`,
    type,
    symbol,
    timeframe,
    breakCandleEpoch,
    brokenSwingEpoch,
    brokenPrice,
    confirmationPrice: brokenPrice,
    confirmedAtEpoch: breakCandleEpoch,
    direction,
    sourceStructure: 'NEUTRAL',
  };
}

function makeStructure(
  symbol: string,
  timeframe: Timeframe,
  swings: SwingPoint[],
  breaks: StructureBreak[]
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
    breaks,
    latestBOS: null,
    latestCHoCH: null,
    protectedHigh: null,
    protectedLow: null,
  };
}

function bullishScenario(): { candles: Candle[]; structure: MarketStructureState } {
  const candles = [
    createCandle(100, 1.105, 1.1055, 1.1, 1.101),
    createCandle(101, 1.101, 1.104, 1.1008, 1.1035),
    createCandle(102, 1.104, 1.1045, 1.103, 1.1035),
    createCandle(103, 1.1047, 1.107, 1.1046, 1.106),
  ];
  const swings = [
    makeSwing('EURUSD', '1m', 'HIGH', 1.105, 90),
    makeSwing('EURUSD', '1m', 'LOW', 1.1, 100),
  ];
  const breaks = [makeBreak('EURUSD', '1m', 'BULLISH_BOS', 103, 90, 1.105)];
  return { candles, structure: makeStructure('EURUSD', '1m', swings, breaks) };
}

const TOL = 0.0001;

test('OB 1 — Bullish OB from nearest opposing candle within origin window', () => {
  const { candles, structure } = bullishScenario();
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    structure
  );
  assert.equal(state.status, 'ACTIVE');
  assert.equal(state.bullishOrderBlocks.length, 1);
  const ob = state.bullishOrderBlocks[0];
  assert.equal(ob.high, 1.1045);
  assert.equal(ob.low, 1.103);
  assert.equal(ob.epoch, 102);
  assert.equal(ob.id, 'EURUSD:1m:OB:BULLISH:102');
  assert.equal(ob.invalidated, false);
});

test('OB 2 — Opposing candle before the origin swing is ignored (window bound)', () => {
  const candles = [
    createCandle(100, 1.103, 1.1035, 1.101, 1.102),
    createCandle(101, 1.101, 1.1025, 1.1, 1.1015),
    createCandle(102, 1.1015, 1.104, 1.1013, 1.1038),
    createCandle(103, 1.104, 1.107, 1.1038, 1.106),
  ];
  const swings = [
    makeSwing('EURUSD', '1m', 'HIGH', 1.105, 90),
    makeSwing('EURUSD', '1m', 'LOW', 1.1, 101),
  ];
  const breaks = [makeBreak('EURUSD', '1m', 'BULLISH_BOS', 103, 90, 1.105)];
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    makeStructure('EURUSD', '1m', swings, breaks)
  );
  assert.equal(state.bullishOrderBlocks.length, 0);
});

test('OB 3 — W_MAX fallback finds an opposing candle at distance 20', () => {
  const candles: Candle[] = [];
  for (let i = 0; i <= 21; i++) {
    const epoch = 100 + i;
    if (i === 1) {
      candles.push(createCandle(epoch, 100.5, 102, 99, 100));
    } else {
      candles.push(createCandle(epoch, 100, 101, 99, 100.5));
    }
  }
  const breaks = [makeBreak('EURUSD', '1m', 'BULLISH_BOS', 121, 50, 100.8)];
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    makeStructure('EURUSD', '1m', [], breaks)
  );
  assert.equal(state.bullishOrderBlocks.length, 1);
  assert.equal(state.bullishOrderBlocks[0].epoch, 101);
});

test('OB 4 — W_MAX boundary: opposing candle at distance 21 is excluded', () => {
  const candles: Candle[] = [];
  for (let i = 0; i <= 21; i++) {
    const epoch = 100 + i;
    if (i === 0) {
      candles.push(createCandle(epoch, 100.5, 102, 99, 100));
    } else {
      candles.push(createCandle(epoch, 100, 101, 99, 100.5));
    }
  }
  const breaks = [makeBreak('EURUSD', '1m', 'BULLISH_BOS', 121, 50, 100.8)];
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    makeStructure('EURUSD', '1m', [], breaks)
  );
  assert.equal(state.bullishOrderBlocks.length, 0);
});

test('OB 5 — Consecutive breaks on the same source candle are deduplicated', () => {
  const { candles, structure } = bullishScenario();
  candles.push(createCandle(104, 1.106, 1.108, 1.1055, 1.1075));
  structure.breaks = [
    makeBreak('EURUSD', '1m', 'BULLISH_BOS', 103, 90, 1.105),
    makeBreak('EURUSD', '1m', 'BULLISH_BOS', 104, 90, 1.105),
  ];
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    structure
  );
  assert.equal(state.bullishOrderBlocks.length, 1);
  assert.equal(state.bullishOrderBlocks[0].epoch, 102);
});

test('OB 6 — Mitigation without invalidation', () => {
  const { candles, structure } = bullishScenario();
  candles.push(createCandle(105, 1.1044, 1.1046, 1.1042, 1.1044));
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    structure
  );
  const ob = state.bullishOrderBlocks[0];
  assert.equal(ob.mitigated, true);
  assert.equal(ob.mitigationEpoch, 105);
  assert.equal(ob.invalidated, false);
  assert.equal(ob.invalidatedEpoch, undefined);
});

test('OB 7 — Invalidation with mitigation on the same candle', () => {
  const { candles, structure } = bullishScenario();
  candles.push(createCandle(105, 1.1035, 1.104, 1.1015, 1.102));
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    structure
  );
  const ob = state.bullishOrderBlocks[0];
  assert.equal(ob.invalidated, true);
  assert.equal(ob.mitigated, true);
  assert.equal(ob.invalidatedEpoch, 105);
  assert.equal(ob.mitigationEpoch, 105);
});

test('OB 8 — Earlier mitigation timestamp is preserved when invalidation occurs later', () => {
  const { candles, structure } = bullishScenario();
  candles.push(createCandle(105, 1.1044, 1.1046, 1.1042, 1.1044));
  candles.push(createCandle(108, 1.1035, 1.104, 1.1015, 1.102));
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    structure
  );
  const ob = state.bullishOrderBlocks[0];
  assert.equal(ob.mitigationEpoch, 105);
  assert.equal(ob.invalidatedEpoch, 108);
  assert.equal(ob.invalidated, true);
});

test('OB 9 — Invariant holds: invalidated implies mitigated across fixtures', () => {
  const { candles, structure } = bullishScenario();
  candles.push(createCandle(105, 1.1035, 1.104, 1.1015, 1.102));
  candles.push(createCandle(110, 1.1045, 1.1047, 1.1043, 1.1045));
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    structure
  );
  const all: OrderBlock[] = [...state.bullishOrderBlocks, ...state.bearishOrderBlocks];
  assert.ok(all.length > 0);
  for (const ob of all) {
    assert.ok(!ob.invalidated || ob.mitigated);
  }
});

test('OB 10 — Bearish OB source selection, mitigation, and invalidation', () => {
  const candles = [
    createCandle(100, 1.107, 1.108, 1.1065, 1.1075),
    createCandle(101, 1.1075, 1.109, 1.107, 1.1085),
    createCandle(102, 1.1085, 1.11, 1.108, 1.1095),
    createCandle(103, 1.1075, 1.1075, 1.105, 1.1055),
    createCandle(105, 1.107, 1.1085, 1.1068, 1.1072),
    createCandle(106, 1.109, 1.111, 1.1088, 1.1105),
  ];
  const swings = [
    makeSwing('EURUSD', '1m', 'HIGH', 1.108, 100),
    makeSwing('EURUSD', '1m', 'LOW', 1.106, 90),
  ];
  const breaks = [makeBreak('EURUSD', '1m', 'BEARISH_BOS', 103, 90, 1.106)];
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    makeStructure('EURUSD', '1m', swings, breaks)
  );
  assert.equal(state.bearishOrderBlocks.length, 1);
  const ob = state.bearishOrderBlocks[0];
  assert.equal(ob.high, 1.11);
  assert.equal(ob.low, 1.108);
  assert.equal(ob.epoch, 102);
  assert.equal(ob.mitigated, true);
  assert.equal(ob.mitigationEpoch, 105);
  assert.equal(ob.invalidated, true);
  assert.equal(ob.invalidatedEpoch, 106);
});

test('OB 11 — CHoCH breaks also produce order blocks', () => {
  const { candles, structure } = bullishScenario();
  structure.breaks = [makeBreak('EURUSD', '1m', 'BULLISH_CHOCH', 103, 90, 1.105)];
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    structure
  );
  assert.equal(state.bullishOrderBlocks.length, 1);
});

test('OB 12 — INITIAL breaks do not produce order blocks', () => {
  const { candles, structure } = bullishScenario();
  structure.breaks = [makeBreak('EURUSD', '1m', 'INITIAL_BULLISH_BREAK', 103, 90, 1.105)];
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    structure
  );
  assert.equal(state.bullishOrderBlocks.length, 0);
  assert.equal(state.status, 'ACTIVE');
});

test('OB 13 — Forming candle is not eligible as a source', () => {
  const candles = [
    createCandle(100, 1.101, 1.102, 1.1, 1.1015),
    createCandle(101, 1.1015, 1.103, 1.1012, 1.1028),
    createCandle(102, 1.1028, 1.1035, 1.102, 1.1022, false),
    createCandle(103, 1.1028, 1.107, 1.1026, 1.106),
  ];
  const swings = [
    makeSwing('EURUSD', '1m', 'HIGH', 1.105, 90),
    makeSwing('EURUSD', '1m', 'LOW', 1.1, 100),
  ];
  const breaks = [makeBreak('EURUSD', '1m', 'BULLISH_BOS', 103, 90, 1.105)];
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    makeStructure('EURUSD', '1m', swings, breaks)
  );
  assert.equal(state.bullishOrderBlocks.length, 0);
});

test('OB 14 — Symbol/timeframe isolation', () => {
  const analyzer = new OrderBlockAnalyzer({ customTolerance: TOL });
  const eur = bullishScenario();
  const gbpCandles = [
    createCandle(100, 1.3, 1.305, 1.295, 1.3),
    createCandle(101, 1.3, 1.312, 1.299, 1.31),
    createCandle(102, 1.31, 1.314, 1.3, 1.302),
    createCandle(103, 1.318, 1.33, 1.317, 1.328),
  ];
  const gbp = makeStructure(
    'GBPUSD',
    '5m',
    [
      makeSwing('GBPUSD', '5m', 'HIGH', 1.32, 90),
      makeSwing('GBPUSD', '5m', 'LOW', 1.3, 100),
    ],
    [makeBreak('GBPUSD', '5m', 'BULLISH_BOS', 103, 90, 1.32)]
  );
  const eurState = analyzer.analyze('EURUSD', '1m', eur.candles, eur.structure);
  const gbpState = analyzer.analyze('GBPUSD', '5m', gbpCandles, gbp);
  assert.equal(eurState.bullishOrderBlocks[0].id, 'EURUSD:1m:OB:BULLISH:102');
  assert.equal(gbpState.bullishOrderBlocks[0].id, 'GBPUSD:5m:OB:BULLISH:102');
  assert.equal(eurState.symbol, 'EURUSD');
  assert.equal(gbpState.timeframe, '5m');
});

test('OB 15 — No breaks yields WAITING FOR DATA', () => {
  const { candles, structure } = bullishScenario();
  structure.breaks = [];
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    structure
  );
  assert.equal(state.status, 'WAITING FOR DATA');
  assert.equal(state.bullishOrderBlocks.length, 0);
});

test('OB 16 — refinedPips converts OB height to conventional EURUSD pips', () => {
  const { candles, structure } = bullishScenario();
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'EURUSD',
    '1m',
    candles,
    structure
  );
  const ob = state.bullishOrderBlocks[0];
  assert.ok(ob.refinedPips !== undefined);
  assert.ok(Math.abs(ob.refinedPips - 15) < 1e-9);
});

test('OB 17 — Unsupported symbol yields no refinedPips conversion', () => {
  const { candles } = bullishScenario();
  const structure = makeStructure(
    'ZZZUSD',
    '1m',
    [
      makeSwing('ZZZUSD', '1m', 'HIGH', 1.105, 90),
      makeSwing('ZZZUSD', '1m', 'LOW', 1.1, 100),
    ],
    [makeBreak('ZZZUSD', '1m', 'BULLISH_BOS', 103, 90, 1.105)]
  );
  const state = new OrderBlockAnalyzer({ customTolerance: TOL }).analyze(
    'ZZZUSD',
    '1m',
    candles,
    structure
  );
  assert.equal(state.bullishOrderBlocks.length, 1);
  assert.equal(state.bullishOrderBlocks[0].refinedPips, undefined);
});

