import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNotificationView,
  NEW_SIGNAL_LABEL,
} from '../lib/ui/notification-view';
import {
  HISTORICAL_SIGNAL_VALIDITY_NOTE,
  SIGNAL_TIMEZONE_LABEL,
  formatEpochTimeUTC,
} from '../lib/ui/signal-view';
import type { SignalOutput } from '../lib/signals/signal-engine';

const EPOCH = 1_700_000_000;

const signal: SignalOutput = {
  decision: 'LONG',
  confidence: 75,
  setup: 'TREND_CONTINUATION',
  entry: 1.1,
  stopLoss: 1.0985,
  takeProfit: 1.105,
  riskReward: 3.33,
  reason: 'test',
  timestamp: EPOCH,
  signalEpoch: EPOCH,
  signalId: 'EURUSD:1m:trig-long:zone-long',
};

test('VIEW 1 — the view model carries engine values and reuses shared labels', () => {
  const view = buildNotificationView({
    signal,
    symbolId: 'EURUSD',
    displayName: 'EUR/USD',
    timeframe: '1m',
    decimals: 5,
  });

  assert.equal(view.label, NEW_SIGNAL_LABEL);
  assert.equal(view.direction, 'LONG');
  assert.equal(view.symbolLine, 'EUR/USD');
  assert.equal(view.timeframe, '1m');
  assert.equal(view.setup, 'TREND_CONTINUATION');
  assert.equal(view.confidence, '75%');
  assert.equal(view.timezoneLabel, SIGNAL_TIMEZONE_LABEL);
  assert.equal(view.signalTime, formatEpochTimeUTC(EPOCH));
  assert.equal(view.validityNote, HISTORICAL_SIGNAL_VALIDITY_NOTE);
  assert.equal(view.riskReward, '1:3.33');
});

test('VIEW 2 — the title names the direction, symbol and timeframe', () => {
  const view = buildNotificationView({ signal, symbolId: 'EURUSD', timeframe: '5m' });
  assert.equal(view.title, 'New LONG signal — EURUSD · 5M');
});

test('VIEW 3 — the desktop body includes the full trade summary', () => {
  const view = buildNotificationView({ signal, symbolId: 'EURUSD', timeframe: '1m' });
  assert.ok(view.body.includes('Entry'));
  assert.ok(view.body.includes('SL'));
  assert.ok(view.body.includes('TP'));
  assert.ok(view.body.includes('R:R 1:3.33'));
  assert.ok(view.body.includes('Confidence 75%'));
  assert.ok(view.body.includes('UTC'));
});

test('VIEW 4 — missing values degrade to em dashes, never invented', () => {
  const noTrade: SignalOutput = {
    decision: 'NO_TRADE',
    confidence: null,
    setup: 'NONE',
    entry: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    reason: 'none',
    timestamp: 0,
  };
  const view = buildNotificationView({ signal: noTrade, symbolId: 'EURUSD', timeframe: '1m' });
  assert.equal(view.direction, 'NO_TRADE');
  assert.equal(view.confidence, '—');
  assert.equal(view.entry, '—');
  assert.equal(view.stopLoss, '—');
  assert.equal(view.takeProfit, '—');
  assert.equal(view.riskReward, '—');
  assert.equal(view.signalTime, '—');
});
