import test from 'node:test';
import assert from 'node:assert/strict';

import { Candle } from '../lib/deriv/candles';
import {
  MarketStructureState,
  SwingPoint,
} from '../lib/analysis/market-structure';
import { StructureBreakState } from '../lib/analysis/structure-breaks';
import { LiquidityState } from '../lib/analysis/liquidity';
import { FVGState, FairValueGap } from '../lib/analysis/fvg';
import { OrderBlockState, OrderBlock } from '../lib/analysis/order-blocks';
import { SMCEngine } from '../lib/analysis/smc';
import { SignalOutput } from '../lib/signals/signal-engine';
import { PairEvaluation } from '../lib/signals/signal-eval';

import {
  minimumSwingConfirmationBars,
  MIN_ANALYSIS_HISTORY,
  classifyGap,
  checkCandleIntegrity,
  checkMarketStructure,
  checkStructureBreaks,
  checkLiquidity,
  checkFvg,
  checkOrderBlocks,
  checkPremiumDiscount,
  checkSignalEvaluation,
} from './verification-lib';

function candle(
  epoch: number,
  open: number,
  high: number,
  low: number,
  close: number,
  isClosed = true
): Candle {
  return { epoch, open, high, low, close, volume: 1, isClosed };
}

function validSeries(count: number, period = 60): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + i * 0.1;
    out.push(candle(i * period, base, base + 0.05, base - 0.05, base + 0.02));
  }
  return out;
}

// --- Stage 1 thresholds --------------------------------------------------

test('V1 — minimum swing confirmation bars derives from swing parameters', () => {
  assert.equal(minimumSwingConfirmationBars({ leftBars: 2, rightBars: 2 }), 5);
  assert.equal(minimumSwingConfirmationBars({ leftBars: 3, rightBars: 2 }), 6);
  assert.ok(MIN_ANALYSIS_HISTORY >= minimumSwingConfirmationBars({ leftBars: 2, rightBars: 2 }));
});

// --- Stage 2 candle integrity -------------------------------------------

test('V2 — a clean aligned series has no integrity failures', () => {
  const report = checkCandleIntegrity(validSeries(20), {
    timeframe: '1m',
    periodSeconds: 60,
    category: 'Forex',
    expectClosed: true,
  });
  assert.equal(report.ok, true, report.failures.join('; '));
  assert.equal(report.unexpectedGapCount, 0);
});

test('V3 — duplicate and non-increasing epochs are failures', () => {
  const dup = validSeries(5);
  dup.push(candle(dup[3].epoch, 1, 2, 0.5, 1.5));
  const dupReport = checkCandleIntegrity(dup, {
    timeframe: '1m',
    periodSeconds: 60,
    category: 'Forex',
    expectClosed: true,
  });
  assert.equal(dupReport.ok, false);
  assert.ok(dupReport.failures.some((f) => f.includes('duplicate')));
});

test('V4 — a single leading unaligned candle (adjust_start_time) is tolerated', () => {
  const series = [
    candle(30, 1, 1.1, 0.9, 1.05),
    candle(60, 1, 1.1, 0.9, 1.05),
    candle(120, 1, 1.1, 0.9, 1.05),
    candle(180, 1, 1.1, 0.9, 1.05),
    candle(240, 1, 1.1, 0.9, 1.05),
  ];
  const report = checkCandleIntegrity(series, {
    timeframe: '1m',
    periodSeconds: 60,
    category: 'Forex',
    expectClosed: true,
  });
  assert.equal(report.ok, true, report.failures.join('; '));
  assert.equal(report.leadingUnaligned, true);
});

test('V5 — a non-leading unaligned candle is a failure', () => {
  const series = [
    candle(0, 1, 1.1, 0.9, 1.05),
    candle(60, 1, 1.1, 0.9, 1.05),
    candle(120, 1, 1.1, 0.9, 1.05),
    candle(180, 1, 1.1, 0.9, 1.05),
    candle(270, 1, 1.1, 0.9, 1.05),
  ];
  const report = checkCandleIntegrity(series, {
    timeframe: '1m',
    periodSeconds: 60,
    category: 'Forex',
    expectClosed: true,
  });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.includes('not aligned')));
});

test('V6 — OHLC inconsistencies and non-finite values are failures', () => {
  const badHigh = validSeries(3);
  badHigh[1] = candle(60, 100, 99, 98, 99.5);
  const r1 = checkCandleIntegrity(badHigh, {
    timeframe: '1m',
    periodSeconds: 60,
    category: 'Forex',
    expectClosed: true,
  });
  assert.equal(r1.ok, false);

  const badLow = validSeries(3);
  badLow[1] = candle(60, 100, 101, 100.5, 100.2);
  const r2 = checkCandleIntegrity(badLow, {
    timeframe: '1m',
    periodSeconds: 60,
    category: 'Forex',
    expectClosed: true,
  });
  assert.equal(r2.ok, false);

  const nan = validSeries(3);
  nan[1] = candle(60, NaN, 101, 99, 100);
  const r3 = checkCandleIntegrity(nan, {
    timeframe: '1m',
    periodSeconds: 60,
    category: 'Forex',
    expectClosed: true,
  });
  assert.equal(r3.ok, false);
});

test('V7 — an unclosed candle is a failure when closed input is required', () => {
  const series = validSeries(3);
  series[2] = candle(120, 100, 101, 99, 100, false);
  const report = checkCandleIntegrity(series, {
    timeframe: '1m',
    periodSeconds: 60,
    category: 'Forex',
    expectClosed: true,
  });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.includes('unclosed')));
});

test('V8 — classifyGap distinguishes weekend, holiday and unexpected gaps', () => {
  const friday20 = Math.floor(Date.UTC(2026, 0, 2, 20, 0, 0) / 1000); // 2026-01-02 is a Friday
  const sunday22 = Math.floor(Date.UTC(2026, 0, 4, 22, 0, 0) / 1000);
  const weekend = classifyGap(friday20, sunday22, 3600, 'Forex');
  assert.equal(weekend?.classification, 'weekend_closure');

  const shortGap = classifyGap(0, 4 * 3600, 3600, 'Forex');
  assert.equal(shortGap?.classification, 'unexpected');

  const longGap = classifyGap(0, 48 * 3600, 3600, 'Forex');
  assert.equal(longGap?.classification, 'possible_holiday');

  const syntheticGap = classifyGap(600 * 3600, 604 * 3600, 3600, 'Synthetics');
  assert.equal(syntheticGap?.classification, 'unexpected');
});

test('V9 — a legitimate weekend gap does not fail integrity; an intraday gap does', () => {
  const friday20 = Math.floor(Date.UTC(2026, 0, 2, 20, 0, 0) / 1000);
  const sunday22 = Math.floor(Date.UTC(2026, 0, 4, 22, 0, 0) / 1000);
  const weekendSeries = [
    candle(friday20 - 3600, 100, 101, 99, 100),
    candle(friday20, 100, 101, 99, 100),
    candle(sunday22, 100, 101, 99, 100),
  ];
  const weekendReport = checkCandleIntegrity(weekendSeries, {
    timeframe: '1H',
    periodSeconds: 3600,
    category: 'Forex',
    expectClosed: true,
  });
  assert.equal(weekendReport.ok, true, weekendReport.failures.join('; '));
  assert.equal(weekendReport.unexpectedGapCount, 0);
  assert.ok(weekendReport.gaps.some((g) => g.classification === 'weekend_closure'));

  const intradaySeries = [
    candle(0, 100, 101, 99, 100),
    candle(3600, 100, 101, 99, 100),
    candle(5 * 3600, 100, 101, 99, 100),
  ];
  const intradayReport = checkCandleIntegrity(intradaySeries, {
    timeframe: '1H',
    periodSeconds: 3600,
    category: 'Forex',
    expectClosed: true,
  });
  assert.equal(intradayReport.ok, false);
  assert.equal(intradayReport.unexpectedGapCount, 1);
});

test('V18 — classifyGap recognises the Metals daily maintenance halt', () => {
  const day2000 = Math.floor(Date.UTC(2026, 0, 5, 20, 0, 0) / 1000); // Monday 20:00 UTC
  const day2200 = day2000 + 2 * 3600;

  const metalsGap = classifyGap(day2000, day2200, 3600, 'Metals');
  assert.equal(metalsGap?.classification, 'maintenance_closure');

  const forexGap = classifyGap(day2000, day2200, 3600, 'Forex');
  assert.equal(forexGap?.classification, 'unexpected');

  const midday = Math.floor(Date.UTC(2026, 0, 5, 10, 0, 0) / 1000);
  const middayGap = classifyGap(midday, midday + 2 * 3600, 3600, 'Metals');
  assert.equal(middayGap?.classification, 'unexpected');
});

// --- Stage 3 component invariant checkers -------------------------------

function swing(epoch: number, type: 'HIGH' | 'LOW', price: number): SwingPoint {
  return {
    id: `EURUSD:1m:${epoch}:${type}`,
    symbol: 'EURUSD',
    timeframe: '1m',
    type,
    candleEpoch: epoch,
    swingCandleEpoch: epoch,
    confirmedAtEpoch: epoch + 120,
    price,
    candleIndex: 0,
    structureType: type === 'HIGH' ? 'HH' : 'HL',
  };
}

function validState(swings: SwingPoint[], lastEpoch: number): MarketStructureState {
  return {
    symbol: 'EURUSD',
    timeframe: '1m',
    structuralBias: 'NEUTRAL',
    swings,
    latestSwingHigh: swings.find((s) => s.type === 'HIGH') ?? null,
    latestSwingLow: swings.find((s) => s.type === 'LOW') ?? null,
    latestHH: null,
    latestHL: null,
    latestLH: null,
    latestLL: null,
    latestEQH: null,
    latestEQL: null,
    recentStructureSequence: [],
    lastAnalyzedEpoch: lastEpoch,
    breaks: [],
    latestBOS: null,
    latestCHoCH: null,
    protectedHigh: null,
    protectedLow: null,
  };
}

test('V10 — market-structure checker accepts a valid state and detects planted violations', () => {
  const candles = [
    candle(0, 100, 101, 99, 100),
    candle(60, 100, 102, 99, 101),
    candle(120, 101, 103, 100, 102),
    candle(180, 100, 101, 98, 99),
    candle(240, 99, 100, 97, 98),
  ];
  const s = swing(120, 'HIGH', 103);
  const state = validState([s], 240);
  const ok = checkMarketStructure('EURUSD', '1m', candles, state);
  assert.equal(ok.status, 'PASS', ok.failures.join('; '));

  const wrongPrice = validState([{ ...s, price: 999 }], 240);
  assert.equal(checkMarketStructure('EURUSD', '1m', candles, wrongPrice).status, 'FAIL');

  const lookahead = validState([{ ...s, confirmedAtEpoch: 120 }], 240);
  assert.equal(checkMarketStructure('EURUSD', '1m', candles, lookahead).status, 'FAIL');

  const wrongLast = validState([s], 999);
  assert.equal(checkMarketStructure('EURUSD', '1m', candles, wrongLast).status, 'FAIL');
});

test('V11 — structure-break checker accepts valid breaks and detects geometry violations', () => {
  const candles = [
    candle(0, 100, 101, 99, 100),
    candle(60, 100, 102, 99, 101),
    candle(120, 101, 103, 100, 102),
    candle(180, 104, 106, 103, 105),
  ];
  const swings = [swing(120, 'HIGH', 103)];
  const state: StructureBreakState = {
    symbol: 'EURUSD',
    timeframe: '1m',
    breaks: [
      {
        id: 'EURUSD:1m:BULLISH_BOS:180:120',
        type: 'BULLISH_BOS',
        symbol: 'EURUSD',
        timeframe: '1m',
        breakCandleEpoch: 180,
        brokenSwingEpoch: 120,
        brokenPrice: 103,
        confirmationPrice: 105,
        confirmedAtEpoch: 180,
        direction: 'BULLISH',
        sourceStructure: 'BULLISH',
      },
    ],
    latestBOS: null,
    latestCHoCH: null,
    protectedHigh: null,
    protectedLow: null,
  };
  const ok = checkStructureBreaks('EURUSD', '1m', candles, swings, state);
  assert.equal(ok.status, 'PASS', ok.failures.join('; '));

  const badGeometry: StructureBreakState = {
    ...state,
    breaks: [{ ...state.breaks[0], confirmationPrice: 102 }],
  };
  assert.equal(checkStructureBreaks('EURUSD', '1m', candles, swings, badGeometry).status, 'FAIL');

  const badCausality: StructureBreakState = {
    ...state,
    breaks: [{ ...state.breaks[0], breakCandleEpoch: 100, confirmedAtEpoch: 100 }],
  };
  assert.equal(checkStructureBreaks('EURUSD', '1m', candles, swings, badCausality).status, 'FAIL');
});

test('V12 — liquidity checker accepts valid levels and detects sweep inconsistencies', () => {
  const candles = [
    candle(0, 100, 101, 99, 100),
    candle(60, 100, 102, 99, 101),
    candle(120, 101, 103, 100, 102),
    candle(180, 101, 102, 98, 99),
  ];
  const structure = validState([swing(120, 'HIGH', 103)], 180);
  const valid: LiquidityState = {
    symbol: 'EURUSD',
    timeframe: '1m',
    buySideLiquidity: [
      { id: 'EURUSD:1m:LIQ:BUY_SIDE:120', price: 103, type: 'BUY_SIDE', swept: false, epoch: 120 },
    ],
    sellSideLiquidity: [],
    equalHighs: [],
    equalLows: [],
    status: 'ACTIVE',
  };
  const ok = checkLiquidity('EURUSD', '1m', candles, structure, valid);
  assert.equal(ok.status, 'PASS', ok.failures.join('; '));

  const badSweep: LiquidityState = {
    ...valid,
    buySideLiquidity: [{ ...valid.buySideLiquidity[0], swept: true }],
  };
  assert.equal(checkLiquidity('EURUSD', '1m', candles, structure, badSweep).status, 'FAIL');

  const countMismatch: LiquidityState = { ...valid, buySideLiquidity: [] };
  assert.equal(checkLiquidity('EURUSD', '1m', candles, structure, countMismatch).status, 'FAIL');
});

test('V13 — FVG checker accepts valid gaps and detects price inconsistencies', () => {
  const candles = [
    candle(0, 100, 101, 99, 100),
    candle(60, 101, 103, 100, 102),
    candle(120, 104, 106, 103.5, 105),
  ];
  const fvg: FairValueGap = {
    id: 'EURUSD:1m:FVG:BULLISH:120',
    type: 'BULLISH',
    topPrice: 103.5,
    bottomPrice: 101,
    epoch: 120,
    mitigated: false,
  };
  const valid: FVGState = {
    symbol: 'EURUSD',
    timeframe: '1m',
    bullishFVGs: [fvg],
    bearishFVGs: [],
    unmitigatedCount: 1,
    status: 'ACTIVE',
  };
  const ok = checkFvg('EURUSD', '1m', candles, valid);
  assert.equal(ok.status, 'PASS', ok.failures.join('; '));

  const badPrice: FVGState = { ...valid, bullishFVGs: [{ ...fvg, bottomPrice: 100 }] };
  assert.equal(checkFvg('EURUSD', '1m', candles, badPrice).status, 'FAIL');

  const badCount: FVGState = { ...valid, unmitigatedCount: 5 };
  assert.equal(checkFvg('EURUSD', '1m', candles, badCount).status, 'FAIL');
});

test('V14 — order-block checker accepts valid blocks and detects lifecycle violations', () => {
  const candles = [
    candle(0, 101, 102, 100, 101),
    candle(60, 101, 101.5, 99, 100), // bearish source candle
    candle(120, 100, 105, 99.5, 104),
  ];
  const ob: OrderBlock = {
    id: 'EURUSD:1m:OB:BULLISH:60',
    type: 'BULLISH',
    high: 101.5,
    low: 99,
    epoch: 60,
    mitigated: false,
    invalidated: false,
  };
  const valid: OrderBlockState = {
    symbol: 'EURUSD',
    timeframe: '1m',
    bullishOrderBlocks: [ob],
    bearishOrderBlocks: [],
    status: 'ACTIVE',
  };
  const ok = checkOrderBlocks('EURUSD', '1m', candles, valid);
  assert.equal(ok.status, 'PASS', ok.failures.join('; '));

  const invalidatedNotMitigated: OrderBlockState = {
    ...valid,
    bullishOrderBlocks: [{ ...ob, invalidated: true }],
  };
  assert.equal(checkOrderBlocks('EURUSD', '1m', candles, invalidatedNotMitigated).status, 'FAIL');

  const wrongSource: OrderBlockState = {
    ...valid,
    bullishOrderBlocks: [{ ...ob, epoch: 0 }],
  };
  assert.equal(checkOrderBlocks('EURUSD', '1m', candles, wrongSource).status, 'FAIL');
});

test('V15 — premium/discount checker compares against the documented recomputation', () => {
  const candles = [
    candle(0, 100, 101, 99, 100),
    candle(60, 100, 104, 98, 103),
    candle(120, 103, 110, 102, 105),
    candle(180, 105, 106, 101, 102),
    candle(240, 102, 103, 90, 95),
    candle(300, 95, 100, 92, 98),
    candle(360, 96, 109, 95, 108),
  ];
  const analyzer = new SMCEngine();
  const result = analyzer.analyze('EURUSD', '1m', candles);
  const ok = checkPremiumDiscount(result.marketStructure, candles, result.zone);
  assert.equal(ok.status, 'PASS', ok.failures.join('; '));
  assert.equal(result.zone, 'PREMIUM');

  const wrong = result.zone === 'PREMIUM' ? 'DISCOUNT' : 'PREMIUM';
  assert.equal(checkPremiumDiscount(result.marketStructure, candles, wrong).status, 'FAIL');
});

test('V16 — signal-evaluation checker validates geometry, NO_TRADE and empty outcomes', () => {
  const candles = validSeries(8);
  const analysis = new SMCEngine().analyze('EURUSD', '1m', candles);

  const empty: PairEvaluation = {
    analysis,
    signal: null,
    direction: null,
    evaluatedAt: null,
    closedCandleCount: 0,
  };
  assert.notEqual(checkSignalEvaluation(empty).status, 'FAIL');

  const noTrade: PairEvaluation = {
    analysis,
    signal: {
      decision: 'NO_TRADE',
      confidence: null,
      setup: 'NONE',
      entry: null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      reason: 'rejected',
      timestamp: 420,
      rejectionReasons: ['NO_CONTEXT'],
    },
    direction: null,
    evaluatedAt: new Date(),
    closedCandleCount: 8,
  };
  assert.notEqual(checkSignalEvaluation(noTrade).status, 'FAIL');

  const longSignal: SignalOutput = {
    decision: 'LONG',
    confidence: 80,
    setup: 'TREND_CONTINUATION',
    entry: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.14,
    riskReward: 4,
    reason: 'signal',
    timestamp: 420,
  };
  const validLong: PairEvaluation = {
    analysis,
    signal: longSignal,
    direction: 'BULLISH',
    evaluatedAt: new Date(),
    closedCandleCount: 8,
  };
  assert.equal(checkSignalEvaluation(validLong).status, 'PASS', checkSignalEvaluation(validLong).failures.join('; '));

  const badGeometry: PairEvaluation = {
    ...validLong,
    signal: { ...longSignal, stopLoss: 1.2 },
  };
  assert.equal(checkSignalEvaluation(badGeometry).status, 'FAIL');

  const lowRr: PairEvaluation = { ...validLong, signal: { ...longSignal, riskReward: 1.2 } };
  assert.equal(checkSignalEvaluation(lowRr).status, 'FAIL');
});

test('V17 — checkers do not false-positive on genuine analyzer output', () => {
  const candles = [
    candle(1000, 98, 100, 95, 99),
    candle(1060, 99, 102, 97, 101),
    candle(1120, 101, 105, 99, 104),
    candle(1180, 104, 103, 100, 101),
    candle(1240, 101, 101, 98, 99),
    candle(1300, 99, 110, 98, 109),
  ];
  const engine = new SMCEngine();
  const result = engine.analyze('EURUSD', '1m', candles);

  assert.notEqual(
    checkMarketStructure('EURUSD', '1m', candles, result.marketStructure).status,
    'FAIL'
  );
  assert.notEqual(checkFvg('EURUSD', '1m', candles, result.fvg).status, 'FAIL');
  assert.notEqual(
    checkLiquidity('EURUSD', '1m', candles, result.marketStructure, result.liquidity).status,
    'FAIL'
  );
  assert.notEqual(
    checkOrderBlocks('EURUSD', '1m', candles, result.orderBlocks).status,
    'FAIL'
  );
  assert.notEqual(checkPremiumDiscount(result.marketStructure, candles, result.zone).status, 'FAIL');
});
