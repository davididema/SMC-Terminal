import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTestNotificationEvent,
  isNotificationTestEnabled,
  NOTIFICATION_TEST_SIGNAL_ID_PREFIX,
  TEST_NOTIFICATION_BODY,
  TEST_NOTIFICATION_TITLE,
} from '../lib/notifications/test-signal';
import { isGeneratedSignal } from '../lib/signals/signal-history';
import { detectNewSignal } from '../lib/notifications/detector';
import { dispatchNotification } from '../lib/notifications/dispatch';

test('TEST 1 — a test event is clearly labelled and carries no trading values', () => {
  const event = buildTestNotificationEvent('abc');
  assert.equal(event.isTest, true);
  assert.equal(event.signalId, `${NOTIFICATION_TEST_SIGNAL_ID_PREFIX}:abc`);
  assert.equal(event.signal.decision, 'NO_TRADE');
  assert.equal(event.signal.confidence, null);
  assert.equal(event.signal.entry, null);
  assert.equal(event.signal.stopLoss, null);
  assert.equal(event.signal.takeProfit, null);
  assert.equal(event.signal.riskReward, null);
  assert.equal(event.signal.setup, 'NONE');
  assert.equal(TEST_NOTIFICATION_TITLE, 'Notification test');
  assert.match(TEST_NOTIFICATION_BODY, /not a trading signal/i);
});

test('TEST 2 — a test event is never a generated signal', () => {
  const event = buildTestNotificationEvent('abc');
  assert.equal(isGeneratedSignal(event.signal), false);
});

test('TEST 3 — the detector rejects a test event (it never enters the real pipeline)', () => {
  const event = buildTestNotificationEvent('abc');
  const result = detectNewSignal(
    {
      signal: event.signal,
      symbolId: event.symbolId,
      timeframe: event.timeframe,
      pairKey: event.pairKey,
      confirmingCandleEpoch: 0,
    },
    new Set()
  );
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'not-generated');
});

test('TEST 4 — each invocation yields a unique identity so tests never collide', () => {
  assert.notEqual(
    buildTestNotificationEvent('a').signalId,
    buildTestNotificationEvent('b').signalId
  );
});

test('TEST 5 — the dev test control is disabled for production and enabled otherwise', () => {
  assert.equal(isNotificationTestEnabled('production'), false);
  assert.equal(isNotificationTestEnabled('development'), true);
  assert.equal(isNotificationTestEnabled(undefined), true);
  assert.equal(isNotificationTestEnabled('test'), true);
});

test('TEST 6 — the test event reuses delivery: in-app always, desktop/sound opt-in', () => {
  const event = buildTestNotificationEvent('abc');
  const calls: string[] = [];
  const sinks = {
    inApp: () => calls.push('in-app'),
    desktop: () => calls.push('desktop'),
    sound: () => calls.push('sound'),
  };

  dispatchNotification(event, { desktop: false, sound: false, desktopPrompted: false }, sinks);
  assert.deepEqual(calls, ['in-app']);

  calls.length = 0;
  dispatchNotification(event, { desktop: true, sound: true, desktopPrompted: true }, sinks);
  assert.deepEqual(calls, ['in-app', 'desktop', 'sound']);
});
