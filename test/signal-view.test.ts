import test from 'node:test';
import assert from 'node:assert/strict';
import type { SignalOutput } from '../lib/signals/signal-engine';
import {
  REJECTION_CODE_EXPLANATIONS,
  describeRejection,
  explainRejections,
  signalStatusLabel,
  formatSignalTime,
  formatEpochTimeUTC,
  SIGNAL_TIMEZONE_LABEL,
  formatDirection,
  formatSignalConfidence,
  formatSignalPrice,
  formatRiskReward,
  buildSignalView,
  defaultSignalReason,
  buildHistoricalSignalView,
  HISTORICAL_SIGNAL_LABEL,
  HISTORICAL_SIGNAL_VALIDITY_NOTE,
  HISTORICAL_SIGNAL_EMPTY_NOTE,
} from '../lib/ui/signal-view';

const longSignal: SignalOutput = {
  decision: 'LONG',
  confidence: 78,
  setup: 'SWEEP_REVERSAL',
  entry: 1.09345,
  stopLoss: 1.09123,
  takeProfit: 1.09789,
  riskReward: 2.05,
  reason: 'Fresh sweep of seller liquidity with bullish CHoCH confirms a long.',
  timestamp: 1750000100,
  signalEpoch: 1750000100,
  triggerId: 'trig-long',
};

const noTradeSignal: SignalOutput = {
  decision: 'NO_TRADE',
  confidence: null,
  setup: 'NONE',
  entry: null,
  stopLoss: null,
  takeProfit: null,
  riskReward: null,
  reason: '',
  timestamp: 1750000100,
  rejectionReasons: ['ZONE_MISALIGNED', 'NO_FRESH_SWEEP'],
};

test('SIGNAL-VIEW — rejection explanations map every engine code', () => {
  assert.equal(
    describeRejection('ZONE_MISALIGNED'),
    'The identified zone does not support the intended trade direction.'
  );
  assert.equal(
    describeRejection('NO_FRESH_SWEEP'),
    'No qualifying fresh liquidity sweep was identified.'
  );
  assert.equal(explainRejections(['ZONE_MISALIGNED', 'NO_FRESH_SWEEP']).length, 2);
  for (const r of explainRejections(['ZONE_MISALIGNED', 'NO_FRESH_SWEEP'])) {
    assert.equal(REJECTION_CODE_EXPLANATIONS[r.code], r.explanation);
  }
  assert.deepEqual(explainRejections(undefined), []);
  assert.deepEqual(explainRejections([]), []);
});

test('SIGNAL-VIEW — status distinguishes evaluated vs waiting for data', () => {
  assert.equal(signalStatusLabel(true, new Date()), 'EVALUATED');
  assert.equal(signalStatusLabel(false, null), 'WAITING FOR DATA');
  assert.equal(signalStatusLabel(true, null), 'WAITING FOR DATA');
  assert.equal(signalStatusLabel(false, new Date()), 'WAITING FOR DATA');
});

test('SIGNAL-VIEW — formatting helpers are honest when values are missing', () => {
  assert.equal(formatSignalTime(new Date(Date.UTC(2026, 9, 11, 8, 5, 9))), '08:05:09');
  assert.equal(formatSignalTime(null), '—');
  assert.equal(formatDirection('BULLISH'), 'LONG');
  assert.equal(formatDirection('BEARISH'), 'SHORT');
  assert.equal(formatDirection(null), '—');
  assert.equal(formatSignalConfidence(78), '78%');
  assert.equal(formatSignalConfidence(null), '—');
  assert.equal(formatSignalPrice(1.09345, 5), '1.09345');
  assert.equal(formatSignalPrice(null, 5), '—');
  assert.equal(formatRiskReward(2.05), '1:2.05');
  assert.equal(formatRiskReward(null), '—');
});

test('SIGNAL-VIEW — a valid signal renders its actual values', () => {
  const v = buildSignalView({
    signal: longSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    marketBias: 'BEARISH',
    region: 'PREMIUM',
    direction: 'BULLISH',
    evaluatedAt: new Date(Date.UTC(2026, 9, 11, 8, 5, 9)),
    hasClosedCandles: true,
    decimals: 5,
    feedLabel: 'LIVE',
  });

  assert.equal(v.hasSignal, true);
  assert.equal(v.decision, 'LONG');
  assert.equal(v.status, 'EVALUATED');
  assert.equal(v.symbolLine, 'EUR/USD');
  assert.equal(v.timeframe, '1m');
  assert.equal(v.direction, 'LONG');
  assert.equal(v.confidence, '78%');
  assert.equal(v.setup, 'SWEEP_REVERSAL');
  assert.equal(v.entry, '1.09345');
  assert.equal(v.stopLoss, '1.09123');
  assert.equal(v.takeProfit, '1.09789');
  assert.equal(v.riskReward, '1:2.05');
  assert.deepEqual(v.rejections, []);
  assert.equal(v.evaluatedAt, '08:05:09');
  assert.equal(v.feedLabel, 'LIVE');
});

test('SIGNAL-VIEW — NO TRADE keeps the real rejection reasons, never fabricates prices', () => {
  const v = buildSignalView({
    signal: noTradeSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    direction: 'BEARISH',
    evaluatedAt: new Date(),
    hasClosedCandles: true,
    decimals: 5,
  });

  assert.equal(v.decision, 'NO TRADE');
  assert.equal(v.status, 'EVALUATED');
  assert.deepEqual(
    v.rejections.map((r) => r.code),
    ['ZONE_MISALIGNED', 'NO_FRESH_SWEEP']
  );
  assert.equal(v.confidence, '—');
  assert.equal(v.entry, '—');
  assert.equal(v.stopLoss, '—');
  assert.equal(v.takeProfit, '—');
  assert.equal(v.riskReward, '—');
  assert.equal(v.direction, 'SHORT');
});

test('SIGNAL-VIEW — missing data is distinguishable from a rejected setup', () => {
  const waiting = buildSignalView({
    signal: null,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    hasClosedCandles: false,
    evaluatedAt: null,
  });
  assert.equal(waiting.status, 'WAITING FOR DATA');
  assert.equal(waiting.decision, 'NO TRADE');
  assert.deepEqual(waiting.rejections, []);
  assert.equal(waiting.reason, 'Waiting for market data before evaluation.');
  assert.equal(
    defaultSignalReason(false, false, null),
    'Waiting for market data before evaluation.'
  );
  assert.equal(
    defaultSignalReason(true, true, new Date()),
    'Waiting for market structure confirmation.'
  );
  // A rejected setup carries real rejection reasons; waiting-for-data does not.
  assert.notEqual(waiting.rejections.length, noTradeSignal.rejectionReasons!.length);
});

test('SIGNAL-VIEW — updating the signal is reflected in the view', () => {
  const first = buildSignalView({ signal: longSignal, symbolId: 'EURUSD', timeframe: '1m' });
  const second = buildSignalView({
    signal: noTradeSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
  });
  assert.equal(first.decision, 'LONG');
  assert.equal(second.decision, 'NO TRADE');
  assert.equal(first.entry, '1.09345');
  assert.equal(second.entry, '—');
});

test('SIGNAL-VIEW — a selection change cannot leak the previous direction', () => {
  const before = buildSignalView({
    signal: longSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    direction: 'BULLISH',
    evaluatedAt: new Date(),
    hasClosedCandles: true,
  });
  const after = buildSignalView({
    signal: null,
    symbolId: 'GBPUSD',
    displayName: 'GBP/USD',
    timeframe: '5m',
    direction: null,
    evaluatedAt: null,
    hasClosedCandles: false,
  });
  assert.equal(before.direction, 'LONG');
  assert.equal(after.direction, '—');
  assert.equal(after.symbolLine, 'GBP/USD');
  assert.equal(after.timeframe, '5m');
  assert.equal(after.status, 'WAITING FOR DATA');
});

// --- Phase 8: signal freshness and timestamp integrity ---------------------

const EVAL_AT = new Date(Date.UTC(2026, 9, 11, 8, 5, 9)); // 08:05:09 UTC
const SIGNAL_EPOCH = Math.floor(Date.UTC(2026, 9, 9, 17, 30, 0) / 1000); // Fri close
const LAST_CANDLE_EPOCH = Math.floor(Date.UTC(2026, 9, 9, 17, 30, 0) / 1000);

test('SIGNAL-VIEW — epoch formatting never invents a timestamp', () => {
  assert.equal(SIGNAL_TIMEZONE_LABEL, 'UTC');
  assert.equal(formatEpochTimeUTC(SIGNAL_EPOCH), '17:30:00');
  assert.equal(formatEpochTimeUTC(null), '—');
  assert.equal(formatEpochTimeUTC(undefined), '—');
  assert.equal(formatEpochTimeUTC(0), '—');
  assert.equal(formatEpochTimeUTC(-5), '—');
  assert.equal(formatEpochTimeUTC(Number.NaN), '—');
  assert.equal(formatEpochTimeUTC(Number.POSITIVE_INFINITY), '—');
});

test('SIGNAL-VIEW — signal time, data-candle time and evaluation time stay distinct', () => {
  const v = buildSignalView({
    signal: longSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    direction: 'BULLISH',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    signalEpoch: SIGNAL_EPOCH,
    lastClosedCandleEpoch: LAST_CANDLE_EPOCH,
    feedLabel: 'Market closed',
  });

  assert.equal(v.signalTime, '17:30:00');
  assert.equal(v.lastCandleTime, '17:30:00');
  assert.equal(v.evaluatedAt, '08:05:09');
  assert.equal(v.timezoneLabel, 'UTC');
  // The confirming candle and the wall-clock evaluation are different moments.
  assert.notEqual(v.signalTime, v.evaluatedAt);
});

test('SIGNAL-VIEW — an old signal recalculated from historical candles keeps its candle time', () => {
  const v = buildSignalView({
    signal: longSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    lastClosedCandleEpoch: LAST_CANDLE_EPOCH,
  });

  // Falls back to the engine's own signalEpoch (1750000100), not the wall clock.
  assert.equal(v.signalTime, formatEpochTimeUTC(longSignal.signalEpoch));
  assert.notEqual(v.signalTime, v.evaluatedAt);
});

test('SIGNAL-VIEW — evaluation time is never presented as the signal generation time', () => {
  const v = buildSignalView({
    signal: longSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    signalEpoch: SIGNAL_EPOCH,
    lastClosedCandleEpoch: LAST_CANDLE_EPOCH,
  });

  assert.equal(v.signalTime, '17:30:00');
  assert.notEqual(v.signalTime, formatSignalTime(EVAL_AT));
  // The evaluation time is still disclosed, but only under its own label value.
  assert.equal(v.evaluatedAt, formatSignalTime(EVAL_AT));
});

test('SIGNAL-VIEW — missing signal timestamps render as unavailable, never fabricated', () => {
  const noTimestamp: SignalOutput = {
    decision: 'NO_TRADE',
    confidence: null,
    setup: 'NONE',
    entry: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    reason: '',
    timestamp: 0,
    rejectionReasons: ['FORMING_CANDLE'],
  };

  const v = buildSignalView({
    signal: noTimestamp,
    symbolId: 'EURUSD',
    timeframe: '1m',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    lastClosedCandleEpoch: null,
  });

  assert.equal(v.signalTime, '—');
  assert.equal(v.lastCandleTime, '—');
  assert.equal(v.evaluatedAt, '08:05:09');

  const noSignal = buildSignalView({
    signal: null,
    symbolId: 'EURUSD',
    timeframe: '1m',
    evaluatedAt: null,
    hasClosedCandles: false,
    lastClosedCandleEpoch: null,
  });
  assert.equal(noSignal.signalTime, '—');
  assert.equal(noSignal.lastCandleTime, '—');
  assert.equal(noSignal.evaluatedAt, '—');
});

test('SIGNAL-VIEW — an explicit missing signal epoch suppresses the timestamp entirely', () => {
  const v = buildSignalView({
    signal: longSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    signalEpoch: null,
  });
  assert.equal(v.signalTime, '—');
});

// --- Phase 12: truthful evaluation status vs data readiness ------------------

const insufficientSignal: SignalOutput = {
  decision: 'NO_TRADE',
  confidence: null,
  setup: 'NONE',
  entry: null,
  stopLoss: null,
  takeProfit: null,
  riskReward: null,
  reason:
    'Signal rejected: no confirmed swings to build market-structure context (INSUFFICIENT_DATA)',
  timestamp: 1750000100,
  signalEpoch: 1750000100,
  rejectionReasons: ['INSUFFICIENT_DATA'],
};

const formingSignal: SignalOutput = {
  decision: 'NO_TRADE',
  confidence: null,
  setup: 'NONE',
  entry: null,
  stopLoss: null,
  takeProfit: null,
  riskReward: null,
  reason:
    'Signal rejected: confirming candle is not closed or context is missing (FORMING_CANDLE)',
  timestamp: 0,
  rejectionReasons: ['FORMING_CANDLE'],
};

const noContextSignal: SignalOutput = {
  decision: 'NO_TRADE',
  confidence: null,
  setup: 'NONE',
  entry: null,
  stopLoss: null,
  takeProfit: null,
  riskReward: null,
  reason:
    'Signal rejected: no directional context from the latest actionable event (NO_CONTEXT)',
  timestamp: 1750000100,
  signalEpoch: 1750000100,
  rejectionReasons: ['NO_CONTEXT'],
};

test('SIGNAL-VIEW — status maps engine reasons to readiness without guessing', () => {
  const at = new Date();
  assert.equal(signalStatusLabel(true, at, ['INSUFFICIENT_DATA']), 'INSUFFICIENT DATA');
  assert.equal(signalStatusLabel(true, at, ['FORMING_CANDLE']), 'INSUFFICIENT DATA');
  assert.equal(signalStatusLabel(true, at, ['NO_CONTEXT']), 'EVALUATED');
  assert.equal(signalStatusLabel(true, at, []), 'EVALUATED');
  assert.equal(signalStatusLabel(true, at, undefined), 'EVALUATED');
  // No closed candles / no evaluation dominates regardless of any reported code.
  assert.equal(signalStatusLabel(false, at, ['INSUFFICIENT_DATA']), 'WAITING FOR DATA');
  assert.equal(signalStatusLabel(true, null, ['INSUFFICIENT_DATA']), 'WAITING FOR DATA');
});

test('SIGNAL-VIEW — zero closed candles is never presented as a completed analysis', () => {
  const v = buildSignalView({
    signal: null,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    hasClosedCandles: false,
    evaluatedAt: null,
  });
  assert.equal(v.status, 'WAITING FOR DATA');
  assert.notEqual(v.status, 'EVALUATED');
  assert.equal(v.decision, 'NO TRADE');
  assert.deepEqual(v.rejections, []);
});

test('SIGNAL-VIEW — insufficient closed-candle structure is not a completed analysis', () => {
  const v = buildSignalView({
    signal: insufficientSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    evaluatedAt: new Date(),
    hasClosedCandles: true,
    decimals: 5,
  });
  assert.equal(v.status, 'INSUFFICIENT DATA');
  assert.notEqual(v.status, 'EVALUATED');
  assert.equal(v.decision, 'NO TRADE');
  assert.deepEqual(v.rejections.map((r) => r.code), ['INSUFFICIENT_DATA']);
  assert.equal(
    v.rejections[0].explanation,
    REJECTION_CODE_EXPLANATIONS.INSUFFICIENT_DATA
  );
});

test('SIGNAL-VIEW — FORMING_CANDLE is distinguished from INSUFFICIENT_DATA', () => {
  const forming = buildSignalView({
    signal: formingSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    evaluatedAt: new Date(),
    hasClosedCandles: true,
  });
  const insufficient = buildSignalView({
    signal: insufficientSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    evaluatedAt: new Date(),
    hasClosedCandles: true,
  });
  // Both are "not ready", but the engine's specific reason is preserved.
  assert.equal(forming.status, 'INSUFFICIENT DATA');
  assert.equal(insufficient.status, 'INSUFFICIENT DATA');
  assert.deepEqual(forming.rejections.map((r) => r.code), ['FORMING_CANDLE']);
  assert.deepEqual(insufficient.rejections.map((r) => r.code), ['INSUFFICIENT_DATA']);
  assert.notEqual(
    forming.rejections[0].explanation,
    insufficient.rejections[0].explanation
  );
  // A forming candle carries no confirming epoch; the time stays unavailable.
  assert.equal(forming.signalTime, '—');
});

test('SIGNAL-VIEW — a valid no-trade evaluation stays EVALUATED, distinct from insufficient data', () => {
  const noContext = buildSignalView({
    signal: noContextSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    evaluatedAt: new Date(),
    hasClosedCandles: true,
  });
  assert.equal(noContext.status, 'EVALUATED');
  assert.notEqual(noContext.status, 'INSUFFICIENT DATA');
  assert.equal(noContext.decision, 'NO TRADE');
  assert.deepEqual(noContext.rejections.map((r) => r.code), ['NO_CONTEXT']);
});

test('SIGNAL-VIEW — a valid LONG signal keeps EVALUATED display behaviour', () => {
  const v = buildSignalView({
    signal: longSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    direction: 'BULLISH',
    evaluatedAt: new Date(),
    hasClosedCandles: true,
  });
  assert.equal(v.status, 'EVALUATED');
  assert.equal(v.decision, 'LONG');
  assert.equal(v.confidence, '78%');
});

test('SIGNAL-VIEW — switching to an insufficient pair never shows the prior analysis as ready', () => {
  const before = buildSignalView({
    signal: longSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    evaluatedAt: new Date(),
    hasClosedCandles: true,
  });
  const after = buildSignalView({
    signal: insufficientSignal,
    symbolId: 'GBPUSD',
    displayName: 'GBP/USD',
    timeframe: '5m',
    evaluatedAt: new Date(),
    hasClosedCandles: true,
  });
  assert.equal(before.status, 'EVALUATED');
  assert.equal(after.status, 'INSUFFICIENT DATA');
  assert.notEqual(after.status, 'EVALUATED');
  assert.equal(after.symbolLine, 'GBP/USD');
});

// --- Phase 17: retained (historical) signal is a distinct concept ------------

test('SIGNAL-VIEW — a retained LONG keeps its original values and timestamp', () => {
  const h = buildHistoricalSignalView({
    signal: longSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    decimals: 5,
  });

  assert.equal(h.present, true);
  assert.equal(h.label, HISTORICAL_SIGNAL_LABEL);
  assert.equal(h.direction, 'LONG');
  assert.equal(h.setup, 'SWEEP_REVERSAL');
  assert.equal(h.confidence, '78%');
  assert.equal(h.entry, '1.09345');
  assert.equal(h.stopLoss, '1.09123');
  assert.equal(h.takeProfit, '1.09789');
  assert.equal(h.riskReward, '1:2.05');
  assert.equal(h.symbolLine, 'EUR/USD');
  assert.equal(h.timeframe, '1m');
  assert.equal(h.signalTime, formatEpochTimeUTC(longSignal.signalEpoch));
  assert.equal(h.validityNote, HISTORICAL_SIGNAL_VALIDITY_NOTE);
});

test('SIGNAL-VIEW — a retained SHORT keeps its direction and values', () => {
  const short: SignalOutput = {
    ...longSignal,
    decision: 'SHORT',
    entry: 1.2,
    stopLoss: 1.21,
    takeProfit: 1.16,
    riskReward: 3,
    signalEpoch: 1750000200,
    timestamp: 1750000200,
  };
  const h = buildHistoricalSignalView({
    signal: short,
    symbolId: 'EURUSD',
    timeframe: '1m',
  });
  assert.equal(h.present, true);
  assert.equal(h.direction, 'SHORT');
  assert.equal(h.entry, '1.20000');
  assert.equal(h.signalTime, formatEpochTimeUTC(1750000200));
});

test('SIGNAL-VIEW — a NO_TRADE signal is never treated as a retained signal', () => {
  const h = buildHistoricalSignalView({
    signal: noTradeSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
  });
  assert.equal(h.present, false);
  assert.equal(h.direction, '—');
  assert.equal(h.entry, '—');
  assert.equal(h.emptyNote, HISTORICAL_SIGNAL_EMPTY_NOTE);
});

test('SIGNAL-VIEW — an absent retained signal renders the empty state, not fabricated values', () => {
  for (const missing of [null, undefined]) {
    const h = buildHistoricalSignalView({
      signal: missing,
      symbolId: 'EURUSD',
      timeframe: '1m',
    });
    assert.equal(h.present, false);
    assert.equal(h.emptyNote, HISTORICAL_SIGNAL_EMPTY_NOTE);
    assert.equal(h.signalTime, '—');
    assert.equal(h.entry, '—');
  }
});

test('SIGNAL-VIEW — the retained signal is never labelled ACTIVE or currently valid', () => {
  const h = buildHistoricalSignalView({
    signal: longSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
  });
  assert.doesNotMatch(h.label, /ACTIVE/i);
  assert.doesNotMatch(h.validityNote, /ACTIVE/i);
  assert.doesNotMatch(h.validityNote, /currently valid/i);
  assert.equal(h.validityNote, HISTORICAL_SIGNAL_VALIDITY_NOTE);
});

test('SIGNAL-VIEW — the retained signal timestamp honours the explicit override', () => {
  const h = buildHistoricalSignalView({
    signal: longSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
  });
  assert.equal(h.signalTime, formatEpochTimeUTC(longSignal.signalEpoch));
  assert.notEqual(h.signalTime, '—');
});
