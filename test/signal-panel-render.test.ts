import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignalPanel } from '../components/SignalPanel';
import type { SignalOutput } from '../lib/signals/signal-engine';

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

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(React.createElement(SignalPanel, props));
}

test('SIGNAL-PANEL — a valid LONG signal renders its actual values', () => {
  const html = render({
    signal: longSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    marketBias: 'BEARISH',
    region: 'PREMIUM',
    direction: 'BULLISH',
    evaluatedAt: new Date(Date.UTC(2026, 9, 11, 8, 5, 9)),
    hasClosedCandles: true,
    feedState: 'LIVE',
  });

  assert.match(html, />LONG</);
  assert.match(html, />78%</);
  assert.match(html, /EUR\/USD · 1M/);
  assert.match(html, />EVALUATED</);
  assert.match(html, />1\.09345</);
  assert.match(html, />1\.09123</);
  assert.match(html, />1\.09789</);
  assert.match(html, />1:2\.05</);
  assert.match(html, />SWEEP_REVERSAL</);
  assert.match(html, />PREMIUM</);
});

test('SIGNAL-PANEL — NO TRADE shows real reasons and fabricates nothing', () => {
  const html = render({
    signal: noTradeSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    marketBias: 'BEARISH',
    region: 'DISCOUNT',
    direction: 'BEARISH',
    evaluatedAt: new Date(Date.UTC(2026, 9, 11, 8, 5, 9)),
    hasClosedCandles: true,
    feedState: 'LIVE',
  });

  assert.match(html, />NO TRADE</);
  assert.match(html, /ZONE_MISALIGNED/);
  assert.match(html, /The identified zone does not support the intended trade direction\./);
  assert.match(html, /NO_FRESH_SWEEP/);
  assert.match(html, /No qualifying fresh liquidity sweep was identified\./);
  assert.match(html, />SHORT</); // intended direction still disclosed
  assert.doesNotMatch(html, />1\.09345</);
  assert.doesNotMatch(html, />78%</);
  assert.doesNotMatch(html, />1:2\.05</);
  assert.match(html, />—</);
});

test('SIGNAL-PANEL — waiting for data is distinct from a rejected setup', () => {
  const html = render({
    signal: null,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    hasClosedCandles: false,
    evaluatedAt: null,
    feedState: 'PENDING',
  });

  assert.match(html, />WAITING FOR DATA</);
  assert.match(html, />Waiting for market data before evaluation\.</);
  assert.doesNotMatch(html, /The identified zone does not support/);
});

test('SIGNAL-PANEL — reflects an updated signal across renders', () => {
  const first = render({
    signal: longSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    direction: 'BULLISH',
    evaluatedAt: new Date(),
    hasClosedCandles: true,
  });
  const second = render({
    signal: noTradeSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    direction: 'BEARISH',
    evaluatedAt: new Date(),
    hasClosedCandles: true,
  });

  assert.match(first, />LONG</);
  assert.match(first, />78%</);
  assert.match(second, />NO TRADE</);
  assert.doesNotMatch(second, />LONG</);
  assert.doesNotMatch(second, />78%</);
});

test('SIGNAL-PANEL — a symbol switch cannot leak the previous pair', () => {
  const before = render({
    signal: longSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    direction: 'BULLISH',
    evaluatedAt: new Date(),
    hasClosedCandles: true,
  });
  const after = render({
    signal: null,
    symbolId: 'XAUUSD',
    displayName: 'Gold',
    timeframe: '5m',
    direction: null,
    evaluatedAt: null,
    hasClosedCandles: false,
    feedState: 'CLOSED',
  });

  assert.match(before, />LONG</);
  assert.doesNotMatch(after, />LONG</);
  assert.match(after, />Gold · 5M</);
  assert.match(after, />WAITING FOR DATA</);
  assert.match(after, />—</); // direction placeholder
});

// --- Phase 8: signal freshness and timestamp integrity ---------------------

const SIGNAL_EPOCH = Math.floor(Date.UTC(2026, 9, 9, 17, 30, 0) / 1000); // Fri close
const LAST_CANDLE_EPOCH = Math.floor(Date.UTC(2026, 9, 9, 17, 30, 0) / 1000);
const EVAL_AT = new Date(Date.UTC(2026, 9, 11, 8, 5, 9)); // 08:05:09 UTC

test('SIGNAL-PANEL — timing rows are labelled in UTC and separate signal from evaluation', () => {
  const html = render({
    signal: { ...longSignal, signalEpoch: SIGNAL_EPOCH, timestamp: SIGNAL_EPOCH },
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    direction: 'BULLISH',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    feedState: 'LIVE',
    lastClosedCandleEpoch: LAST_CANDLE_EPOCH,
  });

  assert.match(html, /Timing \(UTC\)/);
  assert.match(html, /Signal Time:/);
  assert.match(html, /Last Data Candle:/);
  assert.match(html, /Evaluated At:/);
  // The confirming candle and the evaluation instant are shown separately.
  assert.match(html, /17:30:00/);
  assert.match(html, /08:05:09/);
  assert.doesNotMatch(html, /Last Evaluation/);
});

test('SIGNAL-PANEL — a CLOSED feed keeps an existing signal but discloses the real feed', () => {
  const html = render({
    signal: { ...longSignal, signalEpoch: SIGNAL_EPOCH, timestamp: SIGNAL_EPOCH },
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    direction: 'BULLISH',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    feedState: 'CLOSED',
    lastClosedCandleEpoch: LAST_CANDLE_EPOCH,
  });

  assert.match(html, />LONG</);
  assert.match(html, /Market closed/);
  assert.match(html, /17:30:00/);
  assert.match(html, /08:05:09/);
});

test('SIGNAL-PANEL — a STALE feed is labelled and does not imply freshness', () => {
  const html = render({
    signal: { ...longSignal, signalEpoch: SIGNAL_EPOCH, timestamp: SIGNAL_EPOCH },
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    direction: 'BULLISH',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    feedState: 'STALE',
    lastClosedCandleEpoch: LAST_CANDLE_EPOCH,
  });

  assert.match(html, /Stalled/);
  assert.match(html, /17:30:00/);
});

test('SIGNAL-PANEL — WAITING and UNAVAILABLE feeds are labelled distinctly', () => {
  const base = {
    signal: null,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    hasClosedCandles: false,
    evaluatedAt: null,
    lastClosedCandleEpoch: null,
  };
  assert.match(render({ ...base, feedState: 'PENDING' }), /Waiting/);
  assert.match(render({ ...base, feedState: 'UNAVAILABLE' }), /Unavailable/);
});

test('SIGNAL-PANEL — a missing signal timestamp renders as unavailable, not a fabricated time', () => {
  const html = render({
    signal: { ...noTradeSignal, timestamp: 0 },
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    direction: 'BEARISH',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    feedState: 'LIVE',
    lastClosedCandleEpoch: null,
  });

  assert.match(html, /Signal Time:<\/span><span>—<\/span>/);
  assert.match(html, /Last Data Candle:<\/span><span>—<\/span>/);
  assert.match(html, /08:05:09/); // evaluation still shown under its own label
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

test('SIGNAL-PANEL — insufficient structure is not rendered as a completed evaluation', () => {
  const html = render({
    signal: insufficientSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    direction: null,
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    feedState: 'LIVE',
  });

  assert.match(html, />INSUFFICIENT DATA</);
  assert.doesNotMatch(html, />EVALUATED</);
  assert.match(html, />NO TRADE</);
  assert.match(html, /INSUFFICIENT_DATA/);
  assert.match(html, /Not enough confirmed market swings to evaluate\./);
});

test('SIGNAL-PANEL — zero closed candles is never a completed evaluation', () => {
  const html = render({
    signal: null,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    hasClosedCandles: false,
    evaluatedAt: null,
    feedState: 'PENDING',
  });

  assert.match(html, />WAITING FOR DATA</);
  assert.doesNotMatch(html, />EVALUATED</);
});

test('SIGNAL-PANEL — a valid no-trade evaluation stays EVALUATED', () => {
  const html = render({
    signal: noTradeSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    direction: 'BEARISH',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    feedState: 'LIVE',
  });

  assert.match(html, />EVALUATED</);
  assert.doesNotMatch(html, />INSUFFICIENT DATA</);
  assert.match(html, />NO TRADE</);
});

test('SIGNAL-PANEL — FORMING_CANDLE is distinguished from INSUFFICIENT_DATA', () => {
  const forming = render({
    signal: formingSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    feedState: 'LIVE',
  });
  assert.match(forming, />INSUFFICIENT DATA</);
  assert.match(forming, /FORMING_CANDLE/);
  assert.match(forming, /The last candle is still forming/);
  assert.doesNotMatch(forming, /Not enough confirmed market swings/);

  const insufficient = render({
    signal: insufficientSignal,
    symbolId: 'EURUSD',
    timeframe: '1m',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    feedState: 'LIVE',
  });
  assert.match(insufficient, /INSUFFICIENT_DATA/);
  assert.match(insufficient, /Not enough confirmed market swings/);
  assert.doesNotMatch(insufficient, /still forming/);
});

test('SIGNAL-PANEL — feed state stays visible independently of analysis readiness', () => {
  const base = {
    signal: insufficientSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
  };

  const closed = render({ ...base, feedState: 'CLOSED' });
  assert.match(closed, />INSUFFICIENT DATA</);
  assert.match(closed, /Market closed/);

  const stale = render({ ...base, feedState: 'STALE' });
  assert.match(stale, />INSUFFICIENT DATA</);
  assert.match(stale, /Stalled/);

  const waiting = render({ ...base, feedState: 'PENDING' });
  assert.match(waiting, />INSUFFICIENT DATA</);
  assert.match(waiting, /Waiting/);

  const unavailable = render({ ...base, feedState: 'UNAVAILABLE' });
  assert.match(unavailable, />INSUFFICIENT DATA</);
  assert.match(unavailable, /Unavailable/);
});

test('SIGNAL-PANEL — switching to an insufficient pair never shows the prior analysis as ready', () => {
  const before = render({
    signal: longSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    direction: 'BULLISH',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    feedState: 'LIVE',
  });
  const after = render({
    signal: insufficientSignal,
    symbolId: 'XAUUSD',
    displayName: 'Gold',
    timeframe: '5m',
    evaluatedAt: EVAL_AT,
    hasClosedCandles: true,
    feedState: 'LIVE',
  });

  assert.match(before, />EVALUATED</);
  assert.match(before, />LONG</);
  assert.match(after, />INSUFFICIENT DATA</);
  assert.doesNotMatch(after, />EVALUATED</);
  assert.doesNotMatch(after, />LONG</);
  assert.match(after, />Gold · 5M</);
});

// --- Phase 17: latest evaluation vs retained (historical) signal -------------

const duplicateSignal: SignalOutput = {
  decision: 'NO_TRADE',
  confidence: null,
  setup: 'NONE',
  entry: null,
  stopLoss: null,
  takeProfit: null,
  riskReward: null,
  reason: 'Signal rejected: identical signal identity was already consumed (DUPLICATE)',
  timestamp: 1750000200,
  rejectionReasons: ['DUPLICATE'],
};

const shortSignal: SignalOutput = {
  decision: 'SHORT',
  confidence: 66,
  setup: 'TREND_CONTINUATION',
  entry: 1.2055,
  stopLoss: 1.2081,
  takeProfit: 1.1999,
  riskReward: 2.15,
  reason: 'Continuation short on a bearish BOS.',
  timestamp: 1750000300,
  signalEpoch: 1750000300,
  triggerId: 'trig-short',
};

test('SIGNAL-PANEL — LONG then NO_TRADE/DUPLICATE keeps the historical LONG visible', () => {
  const html = render({
    signal: duplicateSignal,
    lastGeneratedSignal: longSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    direction: 'BULLISH',
    evaluatedAt: new Date(Date.UTC(2026, 9, 11, 8, 5, 9)),
    hasClosedCandles: true,
    feedState: 'LIVE',
  });

  // Latest evaluation section: the real rejection.
  assert.match(html, />NO TRADE</);
  assert.match(html, /DUPLICATE/);
  assert.match(html, /This exact signal was already emitted and suppressed\./);

  // Retained section: the original signal's values, still available.
  assert.match(html, /LAST GENERATED SIGNAL — HISTORICAL/);
  assert.match(html, />1\.09345</);
  assert.match(html, />1\.09123</);
  assert.match(html, />1\.09789</);
  assert.match(html, />1:2\.05</);
  assert.match(html, /Not re-confirmed; current validity is unknown\./);
});

test('SIGNAL-PANEL — SHORT then NO_TRADE/DUPLICATE keeps the historical SHORT visible', () => {
  const html = render({
    signal: duplicateSignal,
    lastGeneratedSignal: shortSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    direction: 'BEARISH',
    evaluatedAt: new Date(Date.UTC(2026, 9, 11, 8, 5, 9)),
    hasClosedCandles: true,
    feedState: 'LIVE',
  });

  assert.match(html, />NO TRADE</);
  assert.match(html, /DUPLICATE/);
  assert.match(html, /LAST GENERATED SIGNAL — HISTORICAL/);
  assert.match(html, />SHORT</);
  assert.match(html, />1\.20550</);
  assert.match(html, />1\.20810</);
  assert.match(html, />1\.19990</);
  assert.match(html, />1:2\.15</);
});

test('SIGNAL-PANEL — a different rejection keeps details historical without implying validity', () => {
  const html = render({
    signal: noTradeSignal, // ZONE_MISALIGNED, NO_FRESH_SWEEP
    lastGeneratedSignal: longSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    direction: 'BULLISH',
    evaluatedAt: new Date(Date.UTC(2026, 9, 11, 8, 5, 9)),
    hasClosedCandles: true,
    feedState: 'LIVE',
  });

  // The latest evaluation's own rejection reasons are shown unchanged.
  assert.match(html, /ZONE_MISALIGNED/);
  assert.match(html, /NO_FRESH_SWEEP/);
  // The historical signal is still shown, with the unknown-validity warning.
  assert.match(html, /LAST GENERATED SIGNAL — HISTORICAL/);
  assert.match(html, />1\.09345</);
  assert.match(html, /Not re-confirmed; current validity is unknown\./);
  assert.doesNotMatch(html, /ACTIVE/);
});

test('SIGNAL-PANEL — no retained signal renders a clear empty state, not values', () => {
  const html = render({
    signal: duplicateSignal,
    lastGeneratedSignal: null,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    evaluatedAt: new Date(Date.UTC(2026, 9, 11, 8, 5, 9)),
    hasClosedCandles: true,
    feedState: 'LIVE',
  });

  assert.match(html, /LAST GENERATED SIGNAL — HISTORICAL/);
  assert.match(html, /No signal has been generated for this pair yet\./);
  assert.doesNotMatch(html, />1\.09345</);
});

test('SIGNAL-PANEL — waiting-for-data keeps its semantics with an empty retained section', () => {
  const html = render({
    signal: null,
    lastGeneratedSignal: null,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    hasClosedCandles: false,
    evaluatedAt: null,
    feedState: 'PENDING',
  });

  assert.match(html, />WAITING FOR DATA</);
  assert.doesNotMatch(html, />EVALUATED</);
  assert.match(html, /No signal has been generated for this pair yet\./);
});

test('SIGNAL-PANEL — latest evaluation does not show historical rejection reasons', () => {
  const html = render({
    signal: duplicateSignal,
    lastGeneratedSignal: longSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    evaluatedAt: new Date(Date.UTC(2026, 9, 11, 8, 5, 9)),
    hasClosedCandles: true,
    feedState: 'LIVE',
  });

  // The latest section names only DUPLICATE and never a code the engine did not report.
  assert.match(html, /DUPLICATE/);
  assert.doesNotMatch(html, /ZONE_MISALIGNED/);
  assert.doesNotMatch(html, /NO_FRESH_SWEEP/);
});

test('SIGNAL-PANEL — a switched pair never shows another pair historical signal', () => {
  const html = render({
    signal: null,
    lastGeneratedSignal: null, // dashboard keys by pair, so switching yields no record
    symbolId: 'XAUUSD',
    displayName: 'Gold',
    timeframe: '1m',
    hasClosedCandles: false,
    evaluatedAt: null,
    feedState: 'PENDING',
  });

  assert.doesNotMatch(html, />LONG</);
  assert.match(html, /No signal has been generated for this pair yet\./);
  assert.match(html, />Gold · 1M</);
});