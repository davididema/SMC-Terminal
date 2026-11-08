import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  RiskPanel,
  formatAdaptiveNumber,
  formatLotSize,
  formatMoney,
  formatQuantity,
} from '../components/RiskPanel';
import type { SignalOutput } from '../lib/signals/signal-engine';

const longSignal: SignalOutput = {
  decision: 'LONG',
  confidence: 78,
  setup: 'SWEEP_REVERSAL',
  entry: 1.1,
  stopLoss: 1.098,
  takeProfit: 1.104,
  riskReward: 2,
  reason: 'test',
  timestamp: 1750000000,
  signalId: 'EURUSD:1m:trig:zone',
};

const shortGoldSignal: SignalOutput = {
  decision: 'SHORT',
  confidence: 70,
  setup: 'TREND_CONTINUATION',
  entry: 2000,
  stopLoss: 2005,
  takeProfit: 1990,
  riskReward: 2,
  reason: 'test',
  timestamp: 1750000100,
  signalId: 'XAUUSD:1m:trig:zone',
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
  timestamp: 1750000200,
  rejectionReasons: ['NO_CONTEXT'],
};

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(React.createElement(RiskPanel, props));
}

test('RISK PANEL - a valid signal auto-populates and renders the sizing result', () => {
  const html = render({
    signal: longSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    currentPrice: 1.1002,
  });

  assert.match(html, /RISK MANAGEMENT/);
  assert.match(html, /READ-ONLY/);
  assert.match(html, /EUR\/USD · 1M/);
  assert.match(html, /Auto-filled from the current signal\./);
  assert.match(html, /RECOMMENDED POSITION SIZE/);
  assert.match(html, /50,000\.00 base units/);
  assert.match(html, /\$100\.00/);
  assert.match(html, /\$200\.00/);
  assert.match(html, /1:2\.00/);
  assert.match(html, /0\.00200/);
  assert.match(html, /20\.0 pips/);
  assert.match(html, /0\.00400/);
  assert.match(html, /40\.0 pips/);
  assert.match(html, /\$9,900\.00/);
  assert.match(html, /\$10,200\.00/);
  assert.match(html, /value="1\.1"/);
  assert.match(html, /value="1\.098"/);
  assert.match(html, /value="1\.104"/);
  assert.match(html, /Advanced assumptions/);
  assert.match(html, /Contract Size \(units\/lot\)/);
  assert.match(html, /Broker contract size and lot limits are not configured/);
  assert.match(html, /Read-only estimate\. No orders are placed\./);
});

test('RISK PANEL - a SHORT gold signal uses gold precision, ounces and short direction', () => {
  const html = render({
    signal: shortGoldSignal,
    symbolId: 'XAUUSD',
    displayName: 'XAU/USD',
    timeframe: '1m',
  });

  assert.match(html, /Auto-filled from the current signal\./);
  assert.match(html, /SHORT/);
  assert.match(html, /20\.00 troy oz/);
  assert.match(html, /5\.00/);
  assert.match(html, /50\.0 pips/);
  assert.match(html, /10\.00/);
  assert.match(html, /100\.0 pips/);
  assert.match(html, /\$100\.00/);
  assert.match(html, /\$200\.00/);
  assert.match(html, /1:2\.00/);
});

test('RISK PANEL - NO_TRADE does not silently populate from the historical signal', () => {
  const html = render({
    signal: noTradeSignal,
    lastGeneratedSignal: longSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
  });

  assert.match(html, /Manual entry\./);
  assert.match(html, /Last generated LONG signal/);
  assert.match(html, /Use last signal/);
  assert.match(html, /Enter entry, stop loss, and take profit to calculate risk\./);
  assert.doesNotMatch(html, /RECOMMENDED POSITION SIZE/);
  assert.doesNotMatch(html, /50,000\.00 base units/);
});

test('RISK PANEL - a stale signal from another symbol cannot populate the panel', () => {
  const html = render({
    signal: longSignal,
    symbolId: 'XAUUSD',
    displayName: 'XAU/USD',
    timeframe: '1m',
  });

  assert.match(html, /Manual entry\./);
  assert.match(html, /Enter entry, stop loss, and take profit to calculate risk\./);
  assert.doesNotMatch(html, /50,000\.00 base units/);
});

test('RISK PANEL - an unsupported instrument is reported, never guessed', () => {
  const unsupportedSignal: SignalOutput = {
    ...longSignal,
    signalId: 'UNKNOWN:1m:trig:zone',
  };
  const html = render({
    signal: unsupportedSignal,
    symbolId: 'UNKNOWN',
    displayName: 'Unknown',
    timeframe: '1m',
  });

  assert.match(html, /UNSUPPORTED_INSTRUMENT/);
  assert.match(html, /No verified risk specification/);
  assert.doesNotMatch(html, /RECOMMENDED POSITION SIZE/);
});

test('RISK PANEL - manual entry mode renders empty, editable levels and no invented result', () => {
  const html = render({
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '15m',
  });

  assert.match(html, /Manual entry\./);
  assert.match(html, /id="risk-entry"/);
  assert.match(html, /id="risk-stop"/);
  assert.match(html, /id="risk-target"/);
  assert.match(html, /id="risk-balance"/);
  assert.match(html, /id="risk-percent"/);
  assert.match(html, /Enter entry, stop loss, and take profit to calculate risk\./);
  assert.doesNotMatch(html, /RECOMMENDED POSITION SIZE/);
});

test('RISK PANEL - tiny nonzero lots are never displayed as 0.0000', () => {
  assert.equal(formatLotSize(0.0001, 0.0001), '0.0001');
  assert.notEqual(formatLotSize(0.000001, 0.000001), '0.0000');
  assert.match(formatLotSize(1e-15, 1e-12), /^</);
});

test('RISK PANEL - tiny nonzero unit sizes are never displayed as zero', () => {
  assert.equal(formatQuantity(0), '0');
  assert.equal(formatQuantity(0.000001), '0.0000010');
  assert.equal(formatQuantity(1e-7), '1.0000e-7');
  assert.equal(formatQuantity(-1e-9), '-1.0000e-9');
  for (const value of [1e-6, 1e-7, 1e-9, 1.23e-10, -4.56e-8]) {
    assert.doesNotMatch(formatQuantity(value), /^[-]?0(\.0+)?$/);
  }
});

test('RISK PANEL - monetary amounts keep two decimals unless precision is needed', () => {
  assert.equal(formatMoney(100, 'USD'), '$100.00');
  assert.equal(formatMoney(1000.5, 'USD'), '$1,000.50');
  assert.equal(formatMoney(0, 'USD'), '$0.00');
  assert.equal(formatMoney(0.01, 'USD'), '$0.01');
  assert.equal(formatMoney(0.004444641984088182, 'USD'), '$0.00444');
  assert.equal(formatMoney(0.000044446419840881815, 'USD'), '$0.0000444');
  assert.equal(formatMoney(1e-15, 'USD'), '$1.0000e-15');
  assert.equal(formatMoney(1e-15, 'EUR'), '€1.0000e-15');
  assert.equal(
    formatMoney(1e21, 'USD'),
    '$1,000,000,000,000,000,000,000.00'
  );
});

test('RISK PANEL - monetary R:R keeps ordinary precision but never zeroes a nonzero value', () => {
  assert.equal(formatAdaptiveNumber(1.9801324503311257), '1.98');
  assert.equal(formatAdaptiveNumber(0.000044446419840881815), '0.0000444');
  assert.equal(formatAdaptiveNumber(0), '0.00');
  assert.equal(formatAdaptiveNumber(1e-15), '1.0000e-15');
  assert.equal(
    formatAdaptiveNumber(1e21),
    '1,000,000,000,000,000,000,000.00'
  );
});

test('RISK PANEL - extreme USDJPY keeps tiny profit and monetary R:R visible', () => {
  const extremeSignal: SignalOutput = {
    decision: 'LONG',
    confidence: 80,
    setup: 'TREND_CONTINUATION',
    entry: 150,
    stopLoss: 1,
    takeProfit: 151,
    riskReward: 0.006711409395973154,
    reason: 'test',
    timestamp: 1750000000,
    signalId: 'USDJPY:1m:trig:zone',
  };
  const html = render({
    signal: extremeSignal,
    symbolId: 'USDJPY',
    displayName: 'USD/JPY',
    timeframe: '1m',
  });

  assert.match(html, /\$0\.00444/);
  assert.match(html, /1:0\.0000444/);
  assert.doesNotMatch(html, /<strong>\$0\.00<\/strong>/);
  assert.doesNotMatch(html, /<strong>1:0\.00<\/strong>/);
});

test('RISK PANEL - a unit position too small for six decimals is not rendered as 0.000000', () => {
  const tinyUnitSignal: SignalOutput = {
    decision: 'LONG',
    confidence: 80,
    setup: 'TREND_CONTINUATION',
    entry: 1_000_000_000,
    stopLoss: 1,
    takeProfit: 2_000_000_000,
    riskReward: 2,
    reason: 'test',
    timestamp: 1750000000,
    signalId: 'V75:1m:trig:zone',
  };
  const html = render({
    signal: tinyUnitSignal,
    symbolId: 'V75',
    displayName: 'Volatility 75',
    timeframe: '1m',
  });

  assert.match(html, /RECOMMENDED POSITION SIZE/);
  assert.doesNotMatch(html, /0\.000000/);
  assert.match(html, /e-7/);
});

test('RISK PANEL - synthetic instruments use points and disclose the estimated exposure', () => {
  const v75Signal: SignalOutput = {
    decision: 'LONG',
    confidence: 80,
    setup: 'TREND_CONTINUATION',
    entry: 100000,
    stopLoss: 99000,
    takeProfit: 102000,
    riskReward: 2,
    reason: 'test',
    timestamp: 1750000000,
    signalId: 'V75:1m:trig:zone',
  };
  const html = render({
    signal: v75Signal,
    symbolId: 'V75',
    displayName: 'Volatility 75',
    timeframe: '1m',
  });

  assert.match(html, /points/);
  assert.doesNotMatch(html, /pips/);
  assert.match(html, /Estimated synthetic P\/L/);
  assert.match(html, /not guaranteed broker P\/L/);
  assert.match(html, /linear exposure/i);
  assert.match(html, /assumed point-value multiplier/i);
});

test('RISK PANEL - USDJPY separates price R:R from monetary R:R and discloses exit conversion', () => {
  const usdjpySignal: SignalOutput = {
    decision: 'LONG',
    confidence: 80,
    setup: 'TREND_CONTINUATION',
    entry: 150,
    stopLoss: 149.5,
    takeProfit: 151,
    riskReward: 2,
    reason: 'test',
    timestamp: 1750000000,
    signalId: 'USDJPY:1m:trig:zone',
  };
  const html = render({
    signal: usdjpySignal,
    symbolId: 'USDJPY',
    displayName: 'USD/JPY',
    timeframe: '1m',
  });

  assert.match(html, /Price R:R/);
  assert.match(html, /Monetary R:R/);
  assert.match(html, /Conversion approximation/);
  assert.match(html, /stop-loss exit price/);
});

test('RISK PANEL - unsupported instrument warning is shown even with blank levels', () => {
  const html = render({
    symbolId: 'UNKNOWN',
    displayName: 'Unknown',
    timeframe: '1m',
  });

  assert.match(html, /UNSUPPORTED_INSTRUMENT/);
  assert.match(html, /No verified risk specification/);
  assert.doesNotMatch(html, /RECOMMENDED POSITION SIZE/);
});

test('RISK PANEL - a signal with a mismatched timeframe cannot auto-populate', () => {
  const html = render({
    signal: longSignal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '5m',
  });

  assert.match(html, /Manual entry\./);
  assert.match(html, /Enter entry, stop loss, and take profit to calculate risk\./);
  assert.doesNotMatch(html, /Auto-filled from the current signal\./);
});

test('RISK PANEL - a signal without a signalId cannot auto-populate', () => {
  const html = render({
    signal: { ...longSignal, signalId: undefined },
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
  });

  assert.match(html, /Manual entry\./);
  assert.doesNotMatch(html, /Auto-filled from the current signal\./);
});
