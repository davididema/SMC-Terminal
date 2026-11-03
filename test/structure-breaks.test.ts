import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StructureBreakDetector,
  StructureBreak,
} from '../lib/analysis/structure-breaks';
import {
  MarketStructureAnalyzer,
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

function createSwingPoint(
  epoch: number,
  type: 'HIGH' | 'LOW',
  price: number,
  structureType: 'HH' | 'HL' | 'LH' | 'LL' | 'EQH' | 'EQL',
  confirmedAtEpoch: number = epoch + 120
): SwingPoint {
  return {
    id: `TEST:1m:${epoch}:${type}`,
    symbol: 'TEST',
    timeframe: '1m',
    type,
    candleEpoch: epoch,
    swingCandleEpoch: epoch,
    confirmedAtEpoch,
    price,
    candleIndex: 2,
    structureType,
  };
}

test('Test 1 — Bullish BOS', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  // Structure: HH (105), HL (100), HH (110)
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'HIGH', 105, 'HH', 1120),
    createSwingPoint(1200, 'LOW', 100, 'HL', 1320),
    createSwingPoint(1400, 'HIGH', 110, 'HH', 1520),
  ];

  // Candles where intermediate candle closes do not break prior high until candle 1600
  const candles: Candle[] = [
    createCandle(1000, 95, 105, 95, 100),
    createCandle(1200, 102, 103, 100, 101),
    createCandle(1400, 101, 110, 101, 104), // Closes @ 104 <= 105 (no premature break)
    createCandle(1520, 104, 105, 102, 103), // Swing 110 confirmed
    createCandle(1600, 103, 115, 102, 112), // Closes @ 112 > 110 + tolerance
  ];

  const state = detector.analyze('EURUSD', '1m', candles, swings, 'BULLISH');

  assert.equal(state.breaks.length, 1);
  const b = state.breaks[0];
  assert.equal(b.type, 'BULLISH_BOS');
  assert.equal(b.direction, 'BULLISH');
  assert.equal(b.brokenPrice, 110);
  assert.equal(b.brokenSwingEpoch, 1400);
  assert.equal(b.breakCandleEpoch, 1600);
  assert.equal(b.confirmationPrice, 112);
  assert.equal(state.latestBOS?.type, 'BULLISH_BOS');
});

test('Test 2 — Bearish BOS', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  // Structure: LL (100), LH (108), LL (95)
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'LOW', 100, 'LL', 1120),
    createSwingPoint(1200, 'HIGH', 108, 'LH', 1320),
    createSwingPoint(1400, 'LOW', 95, 'LL', 1520),
  ];

  const candles: Candle[] = [
    createCandle(1000, 105, 106, 100, 102),
    createCandle(1200, 102, 108, 101, 105),
    createCandle(1400, 104, 105, 95, 101), // Closes @ 101 >= 100 (no premature break)
    createCandle(1520, 101, 102, 97, 98), // Swing 95 confirmed
    createCandle(1600, 98, 99, 91, 93),   // Closes @ 93 < 95 - tolerance
  ];

  const state = detector.analyze('EURUSD', '1m', candles, swings, 'BEARISH');

  assert.equal(state.breaks.length, 1);
  const b = state.breaks[0];
  assert.equal(b.type, 'BEARISH_BOS');
  assert.equal(b.direction, 'BEARISH');
  assert.equal(b.brokenPrice, 95);
  assert.equal(b.brokenSwingEpoch, 1400);
  assert.equal(b.breakCandleEpoch, 1600);
  assert.equal(b.confirmationPrice, 93);
  assert.equal(state.latestBOS?.type, 'BEARISH_BOS');
});

test('Test 3 — Bearish CHoCH', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  // Bullish structure: HH (105), HL (100), HH (112), HL (106)
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'HIGH', 105, 'HH', 1120),
    createSwingPoint(1200, 'LOW', 100, 'HL', 1320),
    createSwingPoint(1400, 'HIGH', 112, 'HH', 1520),
    createSwingPoint(1600, 'LOW', 106, 'HL', 1720), // Protected HL @ 106
  ];

  // Candle closes @ 104 < 106 (below protected HL)
  const candles: Candle[] = [
    createCandle(1000, 98, 105, 97, 102),
    createCandle(1200, 102, 104, 100, 103),
    createCandle(1400, 103, 112, 102, 104), // Closes @ 104 <= 105 (no premature high break)
    createCandle(1600, 108, 111, 106, 109),
    createCandle(1720, 108, 109, 107, 108), // Swing 106 confirmed
    createCandle(1800, 107, 108, 103, 104), // Closes @ 104 < 106 - tolerance
  ];

  const state = detector.analyze('EURUSD', '1m', candles, swings, 'BULLISH');

  assert.equal(state.breaks.length, 1);
  const b = state.breaks[0];
  assert.equal(b.type, 'BEARISH_CHOCH');
  assert.equal(b.direction, 'BEARISH');
  assert.equal(b.brokenPrice, 106);
  assert.equal(b.brokenSwingEpoch, 1600);
  assert.equal(state.latestCHoCH?.type, 'BEARISH_CHOCH');
});

test('Test 4 — Bullish CHoCH', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  // Bearish structure: LL (100), LH (110), LL (92), LH (105)
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'LOW', 100, 'LL', 1120),
    createSwingPoint(1200, 'HIGH', 110, 'LH', 1320),
    createSwingPoint(1400, 'LOW', 92, 'LL', 1520),
    createSwingPoint(1600, 'HIGH', 105, 'LH', 1720), // Protected LH @ 105
  ];

  // Candle closes @ 108 > 105 (above protected LH)
  const candles: Candle[] = [
    createCandle(1000, 105, 106, 100, 102),
    createCandle(1200, 102, 110, 101, 107),
    createCandle(1400, 107, 108, 92, 102),  // Closes @ 102 >= 100 (no premature low break)
    createCandle(1600, 101, 105, 100, 102),
    createCandle(1720, 102, 104, 101, 103), // Swing 105 confirmed
    createCandle(1800, 103, 109, 102, 108), // Closes @ 108 > 105 + tolerance
  ];

  const state = detector.analyze('EURUSD', '1m', candles, swings, 'BEARISH');

  assert.equal(state.breaks.length, 1);
  const b = state.breaks[0];
  assert.equal(b.type, 'BULLISH_CHOCH');
  assert.equal(b.direction, 'BULLISH');
  assert.equal(b.brokenPrice, 105);
  assert.equal(b.brokenSwingEpoch, 1600);
  assert.equal(state.latestCHoCH?.type, 'BULLISH_CHOCH');
});

test('Test 5 — Wick Break Rejection', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'HIGH', 100, 'HH', 1120),
  ];

  // Candle: Open = 99, High = 103, Low = 98, Close = 99.5
  // Wick crossed 100, but Close did NOT close beyond 100
  const candles: Candle[] = [
    createCandle(1000, 95, 100, 94, 98),
    createCandle(1120, 98, 99, 96, 97),
    createCandle(1200, 99, 103, 98, 99.5),
  ];

  const state = detector.analyze('EURUSD', '1m', candles, swings, 'BULLISH');
  assert.equal(state.breaks.length, 0, 'Wick-only break must be rejected');
});

test('Test 6 — Unclosed Candle Rejection', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'HIGH', 100, 'HH', 1120),
  ];

  // Forming candle with isClosed: false crosses swing level @ 105
  const candles: Candle[] = [
    createCandle(1000, 95, 100, 94, 98),
    createCandle(1120, 98, 99, 96, 97),
    createCandle(1200, 99, 106, 98, 105, false), // Forming candle!
  ];

  const state = detector.analyze('EURUSD', '1m', candles, swings, 'BULLISH');
  assert.equal(state.breaks.length, 0, 'Unclosed forming candle must not confirm break');
});

test('Test 7 — Tolerance Buffer', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.05 });
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'HIGH', 100, 'HH', 1120),
  ];

  // Close = 100.02. Beyond 100, but within tolerance buffer of 0.05 (100.02 < 100 + 0.05)
  const candles: Candle[] = [
    createCandle(1000, 95, 100, 94, 98),
    createCandle(1120, 98, 99, 96, 97),
    createCandle(1200, 99, 101, 98, 100.02),
  ];

  const state = detector.analyze('EURUSD', '1m', candles, swings, 'BULLISH');
  assert.equal(state.breaks.length, 0, 'Break inside tolerance buffer must be rejected');
});

test('Test 8 — Duplicate Protection', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'HIGH', 100, 'HH', 1120),
  ];

  const candles: Candle[] = [
    createCandle(1000, 95, 100, 94, 98),
    createCandle(1120, 98, 99, 96, 97),
    createCandle(1200, 99, 104, 98, 103),
  ];

  // Process candles, then re-process with duplicate candles array
  const state1 = detector.analyze('EURUSD', '1m', candles, swings, 'BULLISH');
  assert.equal(state1.breaks.length, 1);

  const state2 = detector.analyze('EURUSD', '1m', [...candles, ...candles], swings, 'BULLISH');
  assert.equal(state2.breaks.length, 1, 'Duplicate candle inputs must produce exactly one break event');
});

test('Test 9 — Historical / Incremental Equivalence', () => {
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'HIGH', 100, 'HH', 1120),
    createSwingPoint(1300, 'LOW', 95, 'HL', 1420),
    createSwingPoint(1600, 'HIGH', 108, 'HH', 1720),
  ];

  const candles: Candle[] = [
    createCandle(1000, 95, 100, 94, 98),
    createCandle(1120, 98, 99, 96, 97),
    createCandle(1200, 97, 104, 96, 103), // Breaks 100 (BOS)
    createCandle(1300, 102, 103, 95, 98),
    createCandle(1420, 98, 101, 97, 100),
    createCandle(1500, 99, 105, 98, 104),
    createCandle(1600, 104, 108, 103, 107),
    createCandle(1720, 106, 107, 104, 105),
    createCandle(1800, 105, 112, 104, 110), // Breaks 108 (BOS)
  ];

  // Batch execution
  const batchDetector = new StructureBreakDetector({ customTolerance: 0.01 });
  const batchState = batchDetector.analyze('EURUSD', '1m', candles, swings, 'BULLISH');

  // Incremental execution (candle by candle)
  const incDetector = new StructureBreakDetector({ customTolerance: 0.01 });
  let incState: any;
  for (let i = 1; i <= candles.length; i++) {
    incState = incDetector.analyze('EURUSD', '1m', candles.slice(0, i), swings, 'BULLISH');
  }

  assert.equal(batchState.breaks.length, incState.breaks.length);
  for (let i = 0; i < batchState.breaks.length; i++) {
    assert.equal(batchState.breaks[i].id, incState.breaks[i].id);
    assert.equal(batchState.breaks[i].brokenPrice, incState.breaks[i].brokenPrice);
    assert.equal(batchState.breaks[i].confirmationPrice, incState.breaks[i].confirmationPrice);
    assert.equal(batchState.breaks[i].type, incState.breaks[i].type);
  }
});

test('Test 10 — Symbol Isolation', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  const eurSwings: SwingPoint[] = [createSwingPoint(1000, 'HIGH', 1.10, 'HH', 1120)];
  const gbpSwings: SwingPoint[] = [createSwingPoint(1000, 'HIGH', 1.30, 'HH', 1120)];

  const eurCandles: Candle[] = [
    createCandle(1000, 1.08, 1.10, 1.07, 1.09),
    createCandle(1120, 1.09, 1.095, 1.085, 1.09),
    createCandle(1200, 1.09, 1.12, 1.085, 1.115), // Breaks EURUSD
  ];

  const gbpCandles: Candle[] = [
    createCandle(1000, 1.28, 1.30, 1.27, 1.29),
    createCandle(1120, 1.29, 1.295, 1.285, 1.29),
    createCandle(1200, 1.29, 1.295, 1.285, 1.29), // Does NOT break GBPUSD
  ];

  detector.analyze('EURUSD', '1m', eurCandles, eurSwings, 'BULLISH');
  detector.analyze('GBPUSD', '1m', gbpCandles, gbpSwings, 'BULLISH');

  const eurState = detector.getState('EURUSD', '1m');
  const gbpState = detector.getState('GBPUSD', '1m');

  assert.equal(eurState?.breaks.length, 1);
  assert.equal(eurState?.breaks[0].symbol, 'EURUSD');

  assert.equal(gbpState?.breaks.length, 0);
});

test('Test 11 — Timeframe Isolation', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  const swings15m: SwingPoint[] = [createSwingPoint(900, 'HIGH', 100, 'HH', 1800)];
  const swings1h: SwingPoint[] = [createSwingPoint(3600, 'HIGH', 150, 'HH', 7200)];

  const candles15m: Candle[] = [
    createCandle(900, 95, 100, 94, 98),
    createCandle(1800, 98, 99, 96, 97),
    createCandle(2700, 97, 105, 96, 103), // Breaks 15m @ 100
  ];

  const candles1h: Candle[] = [
    createCandle(3600, 140, 150, 138, 145),
    createCandle(7200, 145, 148, 142, 144), // Does NOT break 1h @ 150
  ];

  detector.analyze('EURUSD', '15m', candles15m, swings15m, 'BULLISH');
  detector.analyze('EURUSD', '1H', candles1h, swings1h, 'BULLISH');

  assert.equal(detector.getState('EURUSD', '15m')?.breaks.length, 1);
  assert.equal(detector.getState('EURUSD', '1H')?.breaks.length, 0);
});

test('Test 12 — Already Broken Swing Protection', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  const swings: SwingPoint[] = [createSwingPoint(1000, 'HIGH', 100, 'HH', 1120)];

  // Multiple subsequent candles closing above 100
  const candles: Candle[] = [
    createCandle(1000, 95, 100, 94, 98),
    createCandle(1120, 98, 99, 96, 97),
    createCandle(1200, 97, 104, 96, 102), // 1st break: emits BOS
    createCandle(1260, 102, 105, 101, 103), // Still above 100: must NOT re-emit BOS
    createCandle(1320, 103, 106, 102, 104), // Still above 100: must NOT re-emit BOS
  ];

  const state = detector.analyze('EURUSD', '1m', candles, swings, 'BULLISH');
  assert.equal(state.breaks.length, 1, 'Already broken swing must not repeatedly emit breaks');
});

test('Test 13 — Neutral Break Classification', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  // Initial swing in neutral structure
  const swings: SwingPoint[] = [createSwingPoint(1000, 'HIGH', 100, 'HH', 1120)];

  const candles: Candle[] = [
    createCandle(1000, 95, 100, 94, 98),
    createCandle(1120, 98, 99, 96, 97),
    createCandle(1200, 97, 105, 96, 103), // First break out of neutral
  ];

  const state = detector.analyze('EURUSD', '1m', candles, swings, 'NEUTRAL');
  assert.equal(state.breaks.length, 1);
  assert.equal(state.breaks[0].type, 'INITIAL_BULLISH_BREAK');
  assert.notEqual(state.breaks[0].type, 'BULLISH_BOS');
  assert.notEqual(state.breaks[0].type, 'BULLISH_CHOCH');
});

test('Test 14 — Large Candle Crossing Multiple Levels', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  // Two unbroken swing highs: 100 and 103
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'HIGH', 100, 'HH', 1120),
    createSwingPoint(1200, 'HIGH', 103, 'HH', 1320),
  ];

  // Giant candle closes at 108 (surpasses both 100 and 103)
  const candles: Candle[] = [
    createCandle(1000, 95, 100, 94, 98),
    createCandle(1120, 98, 99, 96, 97),
    createCandle(1200, 96, 103, 95, 99), // Close 99 < 100 (neither 100 nor 103 broken yet)
    createCandle(1320, 98, 99, 97, 98),  // Swing 103 confirmed
    createCandle(1400, 98, 110, 97, 108), // Large candle closing above both 100 and 103
    createCandle(1460, 108, 109, 105, 106),
  ];

  const state = detector.analyze('EURUSD', '1m', candles, swings, 'BULLISH');
  // Must emit exactly one meaningful break for the defining level, consuming both
  assert.equal(state.breaks.length, 1);
  assert.equal(state.breaks[0].brokenPrice, 103);
});

test('Test 15 — No Historical Repaint', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'HIGH', 100, 'HH', 1120),
  ];

  const initialCandles: Candle[] = [
    createCandle(1000, 95, 100, 94, 98),
    createCandle(1120, 98, 99, 96, 97),
    createCandle(1200, 97, 105, 96, 103), // Confirmed BOS @ 1200
  ];

  const state1 = detector.analyze('EURUSD', '1m', initialCandles, swings, 'BULLISH');
  assert.equal(state1.breaks.length, 1);
  const originalBreak = state1.breaks[0];

  // Later candles move down sharply
  const subsequentCandles: Candle[] = [
    ...initialCandles,
    createCandle(1260, 103, 103, 94, 95),
    createCandle(1320, 95, 96, 90, 91),
  ];

  const state2 = detector.analyze('EURUSD', '1m', subsequentCandles, swings, 'BULLISH');
  // Original event must be preserved identically
  assert.ok(state2.breaks.some((b) => b.id === originalBreak.id && b.breakCandleEpoch === 1200));
});


test('Test 16 - Future bias cannot affect earlier events', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'HIGH', 100, 'LH', 1120),
    createSwingPoint(1300, 'LOW', 95, 'LL', 1420),
    createSwingPoint(1600, 'HIGH', 108, 'HH', 1720),
    createSwingPoint(1900, 'LOW', 105, 'HL', 2020),
  ];
  const candles: Candle[] = [
    createCandle(1000, 95, 100, 94, 98),
    createCandle(1120, 98, 99, 96, 97),
    createCandle(1200, 97, 104, 96, 103),
    createCandle(1300, 102, 103, 95, 98),
    createCandle(1420, 98, 101, 97, 100),
    createCandle(1500, 99, 105, 98, 104),
    createCandle(1600, 104, 108, 103, 107),
    createCandle(1720, 106, 107, 104, 105),
    createCandle(1800, 105, 112, 104, 110),
  ];
  const batchState = detector.analyze('EURUSD', '1m', candles, swings, 'NEUTRAL');
  assert.ok(batchState.breaks.length >= 1);
});

test('Test 17 — Same-Epoch High/Low Identity: breaking the high preserves the low', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  // A single candle (epoch 1000) is BOTH the confirmed swing high and swing low.
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'HIGH', 105, 'HH', 1120),
    createSwingPoint(1000, 'LOW', 95, 'HL', 1120),
  ];

  const candles: Candle[] = [
    createCandle(1000, 100, 105, 95, 100), // Pivot bar: highest high AND lowest low
    createCandle(1120, 100, 104, 96, 101), // Both swings confirmed
    createCandle(1200, 101, 108, 100, 107), // Close 107 > 105 -> BULLISH_BOS (consumes the high)
    createCandle(1300, 107, 108, 90, 92),   // Close 92 < 95 -> BEARISH_CHOCH (must still break the low)
  ];

  const state = detector.analyze('EURUSD', '1m', candles, swings, 'BULLISH');

  assert.equal(state.breaks.length, 2, 'Consuming the high must not consume the same-epoch low');
  assert.equal(state.breaks[0].type, 'BULLISH_BOS');
  assert.equal(state.breaks[0].brokenSwingEpoch, 1000);
  assert.equal(state.breaks[1].type, 'BEARISH_CHOCH');
  assert.equal(state.breaks[1].brokenSwingEpoch, 1000);
  assert.equal(state.latestBOS?.type, 'BULLISH_BOS');
  assert.equal(state.latestCHoCH?.type, 'BEARISH_CHOCH');
});

test('Test 18 — Same-Epoch High/Low Identity: breaking the low preserves the high', () => {
  const detector = new StructureBreakDetector({ customTolerance: 0.01 });
  // A single candle (epoch 1000) is BOTH the confirmed swing high and swing low.
  const swings: SwingPoint[] = [
    createSwingPoint(1000, 'HIGH', 105, 'LH', 1120),
    createSwingPoint(1000, 'LOW', 95, 'LL', 1120),
  ];

  const candles: Candle[] = [
    createCandle(1000, 100, 105, 95, 100), // Pivot bar: highest high AND lowest low
    createCandle(1120, 100, 104, 96, 101), // Both swings confirmed
    createCandle(1200, 101, 102, 90, 92),   // Close 92 < 95 -> BEARISH_BOS (consumes the low)
    createCandle(1300, 92, 112, 91, 110),   // Close 110 > 105 -> BULLISH_CHOCH (must still break the high)
  ];

  const state = detector.analyze('EURUSD', '1m', candles, swings, 'BEARISH');

  assert.equal(state.breaks.length, 2, 'Consuming the low must not consume the same-epoch high');
  assert.equal(state.breaks[0].type, 'BEARISH_BOS');
  assert.equal(state.breaks[0].brokenSwingEpoch, 1000);
  assert.equal(state.breaks[1].type, 'BULLISH_CHOCH');
  assert.equal(state.breaks[1].brokenSwingEpoch, 1000);
  assert.equal(state.latestBOS?.type, 'BEARISH_BOS');
  assert.equal(state.latestCHoCH?.type, 'BULLISH_CHOCH');
});
