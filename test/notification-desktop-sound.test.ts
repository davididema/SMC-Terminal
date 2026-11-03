import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDesktopNotifier,
  desktopPreferenceFromPermission,
  isDesktopDeliveryActive,
  type NotificationConstructorLike,
} from '../lib/notifications/desktop';
import {
  createSoundPlayer,
  type AudioContextLike,
} from '../lib/notifications/sound';
import type { GeneratedSignalEvent } from '../lib/notifications/types';
import type { SignalOutput } from '../lib/signals/signal-engine';

function makeCtor(
  permission: string,
  requestResult: string | null = permission
): {
  Ctor: NotificationConstructorLike;
  constructs: Array<{ title: string; options?: Record<string, unknown> }>;
  requests: () => number;
} {
  const constructs: Array<{ title: string; options?: Record<string, unknown> }> = [];
  let requests = 0;
  const Ctor = function (this: unknown, title: string, options?: Record<string, unknown>) {
    constructs.push({ title, options });
  } as unknown as NotificationConstructorLike;
  Ctor.permission = permission;
  Ctor.requestPermission = async () => {
    requests += 1;
    return requestResult ?? permission;
  };
  return { Ctor, constructs, requests: () => requests };
}

const event: GeneratedSignalEvent = {
  signalId: 'EURUSD:1m:trig-long:zone-long',
  pairKey: 'EURUSD:1m',
  symbolId: 'EURUSD',
  timeframe: '1m',
  signal: {
    decision: 'LONG',
    confidence: 75,
    setup: 'TREND_CONTINUATION',
    entry: 1.1,
    stopLoss: 1.0985,
    takeProfit: 1.105,
    riskReward: 3.33,
    reason: 'test',
    timestamp: 1,
    signalId: 'EURUSD:1m:trig-long:zone-long',
  } as SignalOutput,
};

test('DESK 1 — an unsupported environment is reported as unsupported', () => {
  const notifier = createDesktopNotifier({});
  assert.equal(notifier.isSupported(), false);
  assert.equal(notifier.getPermissionState(), 'unsupported');
  assert.equal(notifier.show(event, 't', 'b'), false);
});

test('DESK 2 — the initial permission state is mapped from the constructor', () => {
  assert.equal(createDesktopNotifier({ Notification: makeCtor('default').Ctor }).getPermissionState(), 'default');
  assert.equal(createDesktopNotifier({ Notification: makeCtor('granted').Ctor }).getPermissionState(), 'granted');
  assert.equal(createDesktopNotifier({ Notification: makeCtor('denied').Ctor }).getPermissionState(), 'denied');
});

test('DESK 3 — permission is requested once and never re-prompted after a grant', async () => {
  const { Ctor, requests } = makeCtor('default', 'granted');
  const notifier = createDesktopNotifier({ Notification: Ctor });
  assert.equal(await notifier.requestPermission(), 'granted');
  assert.equal(await notifier.requestPermission(), 'granted');
  assert.equal(requests(), 1);
  assert.equal(notifier.getPermissionState(), 'granted');
});

test('DESK 4 — permission is never re-requested after a denial', async () => {
  const { Ctor, requests } = makeCtor('denied');
  const notifier = createDesktopNotifier({ Notification: Ctor });
  assert.equal(await notifier.requestPermission(), 'denied');
  assert.equal(requests(), 0);
});

test('DESK 5 — show is suppressed until granted, then tags by signalId', () => {
  const { Ctor, constructs } = makeCtor('default');
  const notifier = createDesktopNotifier({ Notification: Ctor });
  assert.equal(notifier.show(event, 'title', 'body'), false);
  assert.equal(constructs.length, 0);

  const granted = makeCtor('granted');
  const grantedNotifier = createDesktopNotifier({ Notification: granted.Ctor });
  assert.equal(grantedNotifier.show(event, 'New LONG', 'Entry 1.1'), true);
  assert.equal(granted.constructs.length, 1);
  assert.equal(granted.constructs[0].title, 'New LONG');
  assert.deepEqual(granted.constructs[0].options, {
    body: 'Entry 1.1',
    tag: 'EURUSD:1m:trig-long:zone-long',
  });
});

test('DESK 6 — delivery requires both the stored opt-in and a granted permission', () => {
  assert.equal(isDesktopDeliveryActive(true, 'granted'), true);
  // Permission alone is never consent: a disabled preference suppresses delivery.
  assert.equal(isDesktopDeliveryActive(false, 'granted'), false);
  assert.equal(isDesktopDeliveryActive(true, 'default'), false);
  assert.equal(isDesktopDeliveryActive(true, 'denied'), false);
  assert.equal(isDesktopDeliveryActive(true, 'unsupported'), false);
  assert.equal(isDesktopDeliveryActive(false, 'denied'), false);
});

test('DESK 7 — only a granted permission becomes the stored opt-in', () => {
  assert.equal(desktopPreferenceFromPermission('granted'), true);
  assert.equal(desktopPreferenceFromPermission('default'), false);
  assert.equal(desktopPreferenceFromPermission('denied'), false);
  assert.equal(desktopPreferenceFromPermission('unsupported'), false);
});

test('DESK 8 — an explicit enable with permission already granted opts in without re-prompting', async () => {
  // Permission already granted: requestPermission resolves granted with no prompt.
  const { Ctor, requests } = makeCtor('granted');
  const notifier = createDesktopNotifier({ Notification: Ctor });
  assert.equal(notifier.getPermissionState(), 'granted');

  const state = await notifier.requestPermission();
  assert.equal(state, 'granted');
  assert.equal(requests(), 0);
  // The hook persists the opt-in from this resolved state, enabling delivery.
  assert.equal(desktopPreferenceFromPermission(state), true);
  assert.equal(isDesktopDeliveryActive(desktopPreferenceFromPermission(state), state), true);
});

test('DESK 9 — a denied permission never becomes an opt-in and stays blocked', async () => {
  const { Ctor } = makeCtor('denied');
  const notifier = createDesktopNotifier({ Notification: Ctor });
  const state = await notifier.requestPermission();
  assert.equal(state, 'denied');
  assert.equal(desktopPreferenceFromPermission(state), false);
  assert.equal(isDesktopDeliveryActive(desktopPreferenceFromPermission(state), state), false);
});

function fakeContext(): { ctx: AudioContextLike; calls: string[] } {
  const calls: string[] = [];
  const param = (name: string) => ({
    value: 0,
    setValueAtTime: (v: number) => calls.push(`${name}:set:${v}`),
    exponentialRampToValueAtTime: (v: number) => calls.push(`${name}:ramp:${v}`),
  });
  const ctx: AudioContextLike = {
    state: 'running',
    currentTime: 0,
    destination: {},
    resume: async () => {
      calls.push('resume');
    },
    createOscillator: () => ({
      type: '',
      frequency: param('osc'),
      connect: () => calls.push('osc:connect'),
      start: (w?: number) => calls.push(`osc:start:${w}`),
      stop: (w?: number) => calls.push(`osc:stop:${w}`),
    }),
    createGain: () => ({
      gain: param('gain'),
      connect: () => calls.push('gain:connect'),
    }),
  };
  return { ctx, calls };
}

test('SND 1 — play returns false when no audio context is available', () => {
  const player = createSoundPlayer(() => null);
  assert.equal(player.play(), false);
  assert.doesNotThrow(() => player.unlock());
});

test('SND 2 — play schedules a tone and returns true when available', () => {
  const { ctx, calls } = fakeContext();
  const player = createSoundPlayer(() => ctx, { frequency: 660, durationSeconds: 0.2, volume: 0.1 });
  assert.equal(player.play(), true);
  assert.ok(calls.includes('osc:set:660'));
  assert.ok(calls.includes('gain:set:0.1'));
  assert.ok(calls.some((c) => c.startsWith('osc:start:')));
  assert.ok(calls.some((c) => c.startsWith('osc:stop:')));
});

test('SND 3 — a throwing factory degrades gracefully', () => {
  const player = createSoundPlayer(() => {
    throw new Error('no audio');
  });
  assert.equal(player.play(), false);
  assert.doesNotThrow(() => player.unlock());
});
