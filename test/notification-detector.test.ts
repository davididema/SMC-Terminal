import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectNewSignal,
  signalConfirmingEpoch,
  NotificationSession,
} from '../lib/notifications/detector';
import { dispatchNotification } from '../lib/notifications/dispatch';
import type { SignalOutput } from '../lib/signals/signal-engine';
import type { DetectionInput, GeneratedSignalEvent } from '../lib/notifications/types';

const EPOCH = 1_700_000_000;

function baseSignal(overrides: Partial<SignalOutput> = {}): SignalOutput {
  return {
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
    triggerId: 'trig-long',
    signalId: 'EURUSD:1m:trig-long:zone-long',
    ...overrides,
  };
}

function input(overrides: Partial<DetectionInput> = {}): DetectionInput {
  return {
    signal: baseSignal(),
    symbolId: 'EURUSD',
    timeframe: '1m',
    pairKey: 'EURUSD:1m',
    confirmingCandleEpoch: EPOCH,
    ...overrides,
  };
}

test('DET 1 — a genuine LONG confirmed by the just-closed candle is accepted', () => {
  const signal = baseSignal();
  const result = detectNewSignal(input({ signal }), new Set());
  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'accepted');
  assert.ok(result.event);
  assert.equal(result.event?.signalId, 'EURUSD:1m:trig-long:zone-long');
  assert.equal(result.event?.pairKey, 'EURUSD:1m');
  assert.equal(result.event?.symbolId, 'EURUSD');
  assert.equal(result.event?.timeframe, '1m');
  assert.equal(result.event?.signal, signal);
});

test('DET 2 — a SHORT signal is accepted', () => {
  const signal = baseSignal({
    decision: 'SHORT',
    signalId: 'EURUSD:1m:trig-short:zone-short',
  });
  const result = detectNewSignal(input({ signal }), new Set());
  assert.equal(result.accepted, true);
});

test('DET 3 — a NO_TRADE evaluation is never a notification (not-generated)', () => {
  const signal = baseSignal({
    decision: 'NO_TRADE',
    confidence: null,
    setup: 'NONE',
    entry: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    signalId: undefined,
    rejectionReasons: ['DUPLICATE'],
  });
  const result = detectNewSignal(input({ signal }), new Set());
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'not-generated');
  assert.equal(result.event, null);
});

test('DET 4 — a generated signal without an engine identity is rejected', () => {
  const signal = baseSignal({ signalId: undefined });
  const result = detectNewSignal(input({ signal }), new Set());
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'missing-identity');
});

test('DET 5 — an epoch mismatch (backfill/historical/selection) is rejected', () => {
  const result = detectNewSignal(input({ confirmingCandleEpoch: EPOCH + 60 }), new Set());
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'epoch-mismatch');
});

test('DET 6 — an already-notified identity is rejected as duplicate', () => {
  const result = detectNewSignal(
    input(),
    new Set(['EURUSD:1m:trig-long:zone-long'])
  );
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'duplicate');
});

test('DET 7 — the session records an identity only when accepted', () => {
  const session = new NotificationSession();

  const rejected = session.detect(input({ confirmingCandleEpoch: EPOCH + 60 }));
  assert.equal(rejected.accepted, false);
  assert.equal(session.size(), 0);

  const accepted = session.detect(input());
  assert.equal(accepted.accepted, true);
  assert.equal(session.size(), 1);
  assert.equal(session.has('EURUSD:1m:trig-long:zone-long'), true);

  const again = session.detect(input());
  assert.equal(again.accepted, false);
  assert.equal(again.reason, 'duplicate');
  assert.equal(session.size(), 1);

  session.reset();
  assert.equal(session.size(), 0);
  assert.equal(session.detect(input()).accepted, true);
});

test('DET 8 — a new trigger id in the same pair is a distinct notification', () => {
  const session = new NotificationSession();
  assert.equal(session.detect(input()).accepted, true);
  const next = baseSignal({ triggerId: 'trig-long-2', signalId: 'EURUSD:1m:trig-long-2:zone-long' });
  assert.equal(session.detect(input({ signal: next })).accepted, true);
  assert.equal(session.size(), 2);
});

test('DET 9 — signalConfirmingEpoch prefers signalEpoch then falls back to timestamp', () => {
  assert.equal(signalConfirmingEpoch(baseSignal()), EPOCH);
  assert.equal(signalConfirmingEpoch(baseSignal({ signalEpoch: undefined })), EPOCH);
  // An explicit 0 (the engine's "no confirming candle" sentinel) is never invented around.
  assert.equal(signalConfirmingEpoch(baseSignal({ signalEpoch: 0 })), null);
  assert.equal(signalConfirmingEpoch(baseSignal({ signalEpoch: 0, timestamp: 0 })), null);
  assert.equal(signalConfirmingEpoch(null), null);
  assert.equal(signalConfirmingEpoch(undefined), null);
});

function event(): GeneratedSignalEvent {
  return {
    signalId: 'EURUSD:1m:trig-long:zone-long',
    pairKey: 'EURUSD:1m',
    symbolId: 'EURUSD',
    timeframe: '1m',
    signal: baseSignal(),
  };
}

test('DSP 1 — in-app delivery is always on; desktop and sound are opt-in', () => {
  const calls: string[] = [];
  const sinks = {
    inApp: () => calls.push('in-app'),
    desktop: () => calls.push('desktop'),
    sound: () => calls.push('sound'),
  };

  const off = dispatchNotification(
    event(),
    { desktop: false, sound: false, desktopPrompted: false },
    sinks
  );
  assert.deepEqual(calls, ['in-app']);
  assert.deepEqual(off, { inApp: true, desktop: false, sound: false });

  calls.length = 0;
  const on = dispatchNotification(
    event(),
    { desktop: true, sound: true, desktopPrompted: true },
    sinks
  );
  assert.deepEqual(calls, ['in-app', 'desktop', 'sound']);
  assert.deepEqual(on, { inApp: true, desktop: true, sound: true });
});

test('DSP 2 — a disabled desktop preference keeps suppressing until explicitly enabled', () => {
  const calls: string[] = [];
  const sinks = {
    inApp: () => calls.push('in-app'),
    desktop: () => calls.push('desktop'),
    sound: () => calls.push('sound'),
  };

  // Disabled: desktop must not be dispatched, and no prior grant changes that.
  dispatchNotification(
    event(),
    { desktop: false, sound: false, desktopPrompted: true },
    sinks
  );
  assert.deepEqual(calls, ['in-app']);

  // After the user explicitly opts in, desktop delivery begins.
  calls.length = 0;
  dispatchNotification(
    event(),
    { desktop: true, sound: false, desktopPrompted: true },
    sinks
  );
  assert.deepEqual(calls, ['in-app', 'desktop']);
});
