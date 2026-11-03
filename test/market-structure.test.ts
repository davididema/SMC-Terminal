import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MarketStructureAnalyzer,
  classifySwingHigh,
  classifySwingLow,
  evaluateStructuralBias,
  getSymbolEqualityTolerance,
  SwingPoint,
} from '../lib/analysis/market-structure';
import { Candle } from '../lib/deriv/candles';

function createCandle(
  epoch: number,
  open: number,
  high: number,
  low: number,
  close: number,
  isClosed = true
): Candle {
  return {
    epoch,
    open,
    high,
    low,
    close,
    volume: 10,
    isClosed,
  };
}

test('Test 1 — Swing High Detection', () => {
  const analyzer = new MarketStructureAnalyzer({ leftBars: 2, rightBars: 2 });
  // Sequence of highs: 100, 102, 105, 103, 101
  const candles: Candle[] = [
    createCandle(1000, 98, 100, 95, 99),
    createCandle(1060, 99, 102, 97, 101),
    createCandle(1120, 101, 105, 99, 104), // Pivot candidate (high 105)
    createCandle(1180, 104, 103, 100, 101),
    createCandle(1240, 101, 101, 98, 99),  // Confirmed at this candle
  ];

  const state = analyzer.analyze('EURUSD', '1m', candles);

  assert.equal(state.swings.length, 1);
  const swing = state.swings[0];
  assert.equal(swing.type, 'HIGH');
  assert.equal(swing.price, 105);
  assert.equal(swing.candleEpoch, 1120);
  assert.equal(swing.swingCandleEpoch, 1120);
  assert.equal(swing.confirmedAtEpoch, 1240); // Closed at 2nd right bar
  assert.equal(state.latestSwingHigh?.price, 105);
});

test('Test 2 — Swing Low Detection', () => {
  const analyzer = new MarketStructureAnalyzer({ leftBars: 2, rightBars: 2 });
  // Sequence of lows: 105, 103, 100, 102, 104
  const candles: Candle[] = [
    createCandle(1000, 110, 112, 105, 108),
    createCandle(1060, 108, 110, 103, 105),
    createCandle(1120, 105, 108, 100, 102), // Pivot candidate (low 100)
    createCandle(1180, 102, 106, 102, 104),
    createCandle(1240, 104, 107, 104, 106), // Confirmed at this candle
  ];

  const state = analyzer.analyze('EURUSD', '1m', candles);

  assert.equal(state.swings.length, 1);
  const swing = state.swings[0];
  assert.equal(swing.type, 'LOW');
  assert.equal(swing.price, 100);
  assert.equal(swing.candleEpoch, 1120);
  assert.equal(swing.swingCandleEpoch, 1120);
  assert.equal(swing.confirmedAtEpoch, 1240);
  assert.equal(state.latestSwingLow?.price, 100);
});

test('Test 3 — Higher High (HH)', () => {
  // Previous swing high: 105, New swing high: 110 -> HH
  const classification = classifySwingHigh(110, 105, 0.001);
  assert.equal(classification, 'HH');

  // Verify in analyzer engine
  const analyzer = new MarketStructureAnalyzer({ leftBars: 2, rightBars: 2, customTolerance: 0.01 });
  const candles: Candle[] = [
    // 1st Swing High @ 105
    createCandle(1000, 95, 100, 90, 99),
    createCandle(1060, 99, 102, 95, 101),
    createCandle(1120, 101, 105, 98, 104), // High 105
    createCandle(1180, 104, 102, 97, 98),
    createCandle(1240, 98, 99, 94, 96),
    // 2nd Swing High @ 110
    createCandle(1300, 96, 104, 95, 103),
    createCandle(1360, 103, 110, 102, 108), // High 110
    createCandle(1420, 108, 106, 101, 104),
    createCandle(1480, 104, 103, 100, 102),
  ];

  const state = analyzer.analyze('EURUSD', '1m', candles);
  assert.equal(state.latestHH?.price, 110);
  assert.equal(state.latestHH?.structureType, 'HH');
});

test('Test 4 — Lower High (LH)', () => {
  // Previous swing high: 110, New swing high: 106 -> LH
  const classification = classifySwingHigh(106, 110, 0.001);
  assert.equal(classification, 'LH');

  const analyzer = new MarketStructureAnalyzer({ leftBars: 2, rightBars: 2, customTolerance: 0.01 });
  const candles: Candle[] = [
    // 1st Swing High @ 110
    createCandle(1000, 100, 104, 98, 102),
    createCandle(1060, 102, 108, 100, 106),
    createCandle(1120, 106, 110, 103, 108), // High 110
    createCandle(1180, 108, 105, 101, 103),
    createCandle(1240, 103, 101, 98, 99),
    // 2nd Swing High @ 106
    createCandle(1300, 99, 103, 97, 101),
    createCandle(1360, 101, 106, 100, 104), // High 106
    createCandle(1420, 104, 102, 99, 101),
    createCandle(1480, 101, 100, 96, 98),
  ];

  const state = analyzer.analyze('EURUSD', '1m', candles);
  assert.equal(state.latestLH?.price, 106);
  assert.equal(state.latestLH?.structureType, 'LH');
});

test('Test 5 — Higher Low (HL)', () => {
  // Previous swing low: 100, New swing low: 104 -> HL
  const classification = classifySwingLow(104, 100, 0.001);
  assert.equal(classification, 'HL');

  const analyzer = new MarketStructureAnalyzer({ leftBars: 2, rightBars: 2, customTolerance: 0.01 });
  const candles: Candle[] = [
    // 1st Swing Low @ 100
    createCandle(1000, 115, 118, 108, 112),
    createCandle(1060, 112, 114, 104, 107),
    createCandle(1120, 107, 110, 100, 105), // Low 100
    createCandle(1180, 105, 112, 103, 110),
    createCandle(1240, 110, 116, 107, 114),
    // 2nd Swing Low @ 104
    createCandle(1300, 114, 115, 108, 110),
    createCandle(1360, 110, 112, 104, 108), // Low 104
    createCandle(1420, 108, 114, 107, 112),
    createCandle(1480, 112, 118, 111, 116),
  ];

  const state = analyzer.analyze('EURUSD', '1m', candles);
  assert.equal(state.latestHL?.price, 104);
  assert.equal(state.latestHL?.structureType, 'HL');
});

test('Test 6 — Lower Low (LL)', () => {
  // Previous swing low: 104, New swing low: 98 -> LL
  const classification = classifySwingLow(98, 104, 0.001);
  assert.equal(classification, 'LL');

  const analyzer = new MarketStructureAnalyzer({ leftBars: 2, rightBars: 2, customTolerance: 0.01 });
  const candles: Candle[] = [
    // 1st Swing Low @ 104
    createCandle(1000, 120, 122, 112, 115),
    createCandle(1060, 115, 118, 108, 110),
    createCandle(1120, 110, 114, 104, 109), // Low 104
    createCandle(1180, 109, 115, 107, 112),
    createCandle(1240, 112, 116, 109, 114),
    // 2nd Swing Low @ 98
    createCandle(1300, 114, 115, 102, 105),
    createCandle(1360, 105, 108, 98, 103),  // Low 98
    createCandle(1420, 103, 110, 101, 107),
    createCandle(1480, 107, 112, 105, 110),
  ];

  const state = analyzer.analyze('EURUSD', '1m', candles);
  assert.equal(state.latestLL?.price, 98);
  assert.equal(state.latestLL?.structureType, 'LL');
});

test('Test 7 — No Repaint & Confirmation Delay', () => {
  const analyzer = new MarketStructureAnalyzer({ leftBars: 2, rightBars: 2 });
  const baseCandles: Candle[] = [
    createCandle(1000, 98, 100, 95, 99),
    createCandle(1060, 99, 102, 97, 101),
    createCandle(1120, 101, 105, 99, 104), // Pivot candidate (high 105)
    createCandle(1180, 104, 103, 100, 101), // Only 1 right bar closed
  ];

  // 1. With only 1 right bar closed, candidate 105 must NOT be confirmed
  let state = analyzer.analyze('EURUSD', '1m', baseCandles);
  assert.equal(state.swings.length, 0);

  // 2. Add 2nd right bar as unclosed / forming candle (isClosed: false)
  const formingCandle = createCandle(1240, 101, 101, 98, 99, false);
  state = analyzer.analyze('EURUSD', '1m', [...baseCandles, formingCandle]);
  // Still must NOT be confirmed
  assert.equal(state.swings.length, 0);

  // 3. Close the 2nd right bar (isClosed: true)
  const closedCandle = createCandle(1240, 101, 101, 98, 99, true);
  state = analyzer.analyze('EURUSD', '1m', [...baseCandles, closedCandle]);
  // Now it is objectively confirmed!
  assert.equal(state.swings.length, 1);
  assert.equal(state.swings[0].price, 105);
  assert.equal(state.swings[0].confirmedAtEpoch, 1240);
});

test('Test 8 — Duplicate Protection', () => {
  const analyzer = new MarketStructureAnalyzer({ leftBars: 2, rightBars: 2 });
  const candles: Candle[] = [
    createCandle(1000, 98, 100, 95, 99),
    createCandle(1060, 99, 102, 97, 101),
    createCandle(1120, 101, 105, 99, 104),
    createCandle(1180, 104, 103, 100, 101),
    createCandle(1240, 101, 101, 98, 99),
  ];

  // Run 1
  const state1 = analyzer.analyze('EURUSD', '1m', candles);
  assert.equal(state1.swings.length, 1);

  // Pass same candles with duplicate instances appended
  const state2 = analyzer.analyze('EURUSD', '1m', [...candles, ...candles]);
  assert.equal(state2.swings.length, 1);
  assert.equal(state2.swings[0].id, 'EURUSD:1m:1120:HIGH');
});

test('Test 9 — Symbol Isolation', () => {
  const analyzer = new MarketStructureAnalyzer({ leftBars: 2, rightBars: 2 });
  const eurCandles: Candle[] = [
    createCandle(1000, 98, 100, 95, 99),
    createCandle(1060, 99, 102, 97, 101),
    createCandle(1120, 101, 105, 99, 104), // EUR High 105
    createCandle(1180, 104, 103, 100, 101),
    createCandle(1240, 101, 101, 98, 99),
  ];

  const gbpCandles: Candle[] = [
    createCandle(1000, 200, 210, 198, 205),
    createCandle(1060, 205, 215, 202, 210),
    createCandle(1120, 210, 220, 205, 215), // GBP High 220
    createCandle(1180, 215, 212, 201, 208),
    createCandle(1240, 208, 205, 199, 202),
  ];

  analyzer.analyze('EURUSD', '1m', eurCandles);
  analyzer.analyze('GBPUSD', '1m', gbpCandles);

  const eurState = analyzer.getState('EURUSD', '1m');
  const gbpState = analyzer.getState('GBPUSD', '1m');

  assert.equal(eurState?.swings[0].price, 105);
  assert.equal(eurState?.swings[0].symbol, 'EURUSD');

  assert.equal(gbpState?.swings[0].price, 220);
  assert.equal(gbpState?.swings[0].symbol, 'GBPUSD');

  // Verify mutating one symbol does not affect the other
  analyzer.clear('GBPUSD');
  assert.equal(analyzer.getState('GBPUSD', '1m'), undefined);
  assert.equal(analyzer.getState('EURUSD', '1m')?.swings.length, 1);
});

test('Test 10 — Timeframe Isolation', () => {
  const analyzer = new MarketStructureAnalyzer({ leftBars: 2, rightBars: 2 });
  const candles15m: Candle[] = [
    createCandle(1000, 10, 15, 9, 14),
    createCandle(1900, 14, 20, 12, 18),
    createCandle(2800, 18, 30, 16, 25), // 15m high 30
    createCandle(3700, 25, 22, 19, 21),
    createCandle(4600, 21, 19, 15, 17),
  ];

  const candles1h: Candle[] = [
    createCandle(3600, 10, 18, 8, 16),
    createCandle(7200, 16, 24, 14, 22),
    createCandle(10800, 22, 50, 20, 45), // 1h high 50
    createCandle(14400, 45, 38, 30, 35),
    createCandle(18000, 35, 32, 25, 28),
  ];

  analyzer.analyze('EURUSD', '15m', candles15m);
  analyzer.analyze('EURUSD', '1H', candles1h);

  const state15m = analyzer.getState('EURUSD', '15m');
  const state1h = analyzer.getState('EURUSD', '1H');

  assert.equal(state15m?.swings[0].price, 30);
  assert.equal(state15m?.swings[0].timeframe, '15m');

  assert.equal(state1h?.swings[0].price, 50);
  assert.equal(state1h?.swings[0].timeframe, '1H');
});

test('Test 11 — Equal Highs (EQH) and Equal Lows (EQL)', () => {
  // Test within tolerance
  const eqh = classifySwingHigh(1.08502, 1.08500, 0.00005);
  assert.equal(eqh, 'EQH');

  const eql = classifySwingLow(1.08201, 1.08200, 0.00005);
  assert.equal(eql, 'EQL');

  // Test beyond tolerance
  const hh = classifySwingHigh(1.08510, 1.08500, 0.00005);
  assert.equal(hh, 'HH');

  const ll = classifySwingLow(1.08190, 1.08200, 0.00005);
  assert.equal(ll, 'LL');

  // Verify symbol-aware tolerance
  const tolForex = getSymbolEqualityTolerance('EURUSD', 1.085);
  assert.ok(tolForex > 0);
  const tolV75 = getSymbolEqualityTolerance('V75', 250000);
  assert.ok(tolV75 > 0);
});

test('Test 12 — Structural Bias Rules', () => {
  // Bullish: Dual confirmation (HH and HL)
  const bullishSwings: SwingPoint[] = [
    {
      id: '1',
      symbol: 'EURUSD',
      timeframe: '15m',
      type: 'LOW',
      candleEpoch: 1000,
      swingCandleEpoch: 1000,
      confirmedAtEpoch: 1100,
      price: 100,
      candleIndex: 2,
      structureType: 'HL',
    },
    {
      id: '2',
      symbol: 'EURUSD',
      timeframe: '15m',
      type: 'HIGH',
      candleEpoch: 1200,
      swingCandleEpoch: 1200,
      confirmedAtEpoch: 1300,
      price: 115,
      candleIndex: 5,
      structureType: 'HH',
    },
  ];
  assert.equal(evaluateStructuralBias(bullishSwings), 'BULLISH');

  // Bearish: Dual confirmation (LH and LL)
  const bearishSwings: SwingPoint[] = [
    {
      id: '3',
      symbol: 'EURUSD',
      timeframe: '15m',
      type: 'HIGH',
      candleEpoch: 1000,
      swingCandleEpoch: 1000,
      confirmedAtEpoch: 1100,
      price: 120,
      candleIndex: 2,
      structureType: 'LH',
    },
    {
      id: '4',
      symbol: 'EURUSD',
      timeframe: '15m',
      type: 'LOW',
      candleEpoch: 1200,
      swingCandleEpoch: 1200,
      confirmedAtEpoch: 1300,
      price: 90,
      candleIndex: 5,
      structureType: 'LL',
    },
  ];
  assert.equal(evaluateStructuralBias(bearishSwings), 'BEARISH');

  // Insufficient Swings (< 2)
  assert.equal(evaluateStructuralBias([bullishSwings[0]]), 'NEUTRAL');
});

test('Test 13 — Production Init (Analyzer -> Detector) Starts NEUTRAL', () => {
  const analyzer = new MarketStructureAnalyzer({ leftBars: 2, rightBars: 2, customTolerance: 0.01 });

  // Deterministic series: one confirmed swing high @ 1200 (105) then a close above it @ 1500.
  const candles: Candle[] = [
    createCandle(1000, 98, 100, 97, 99),
    createCandle(1100, 99, 102, 98, 101),
    createCandle(1200, 101, 105, 100, 104), // Pivot high 105
    createCandle(1300, 104, 103, 100, 101), // Right bar 1
    createCandle(1400, 101, 101, 98, 99),   // Right bar 2 -> swing 105 confirmed @ 1400
    createCandle(1500, 99, 110, 98, 109),   // Close 109 > 105 -> initial break
  ];

  const state = analyzer.analyze('EURUSD', '1m', candles);

  assert.equal(state.swings.length, 1);
  assert.equal(state.swings[0].candleEpoch, 1200);
  assert.equal(state.swings[0].confirmedAtEpoch, 1400);

  assert.equal(state.breaks.length, 1);
  const b = state.breaks[0];
  assert.equal(b.type, 'INITIAL_BULLISH_BREAK');
  assert.equal(b.direction, 'BULLISH');
  assert.equal(b.sourceStructure, 'NEUTRAL');
  assert.equal(b.brokenPrice, 105);
  assert.equal(b.brokenSwingEpoch, 1200);
  assert.equal(b.breakCandleEpoch, 1500);
  assert.equal(b.confirmationPrice, 109);

  // The initial break is recorded as latestBOS and must NOT populate latestCHoCH.
  assert.equal(state.latestBOS?.type, 'INITIAL_BULLISH_BREAK');
  assert.equal(state.latestCHoCH, null);
});
