import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { NotificationCenter } from '../components/NotificationCenter';
import type { DesktopPermissionState } from '../lib/notifications/desktop';
import type { GeneratedSignalEvent } from '../lib/notifications/types';
import { buildTestNotificationEvent } from '../lib/notifications/test-signal';

interface RenderOverrides {
  notifications?: GeneratedSignalEvent[];
  desktopState?: DesktopPermissionState;
  desktopPreferenceEnabled?: boolean;
  soundEnabled?: boolean;
  storageAvailable?: boolean;
  onSendTestNotification?: () => void;
}

function render(overrides: RenderOverrides = {}): string {
  return renderToStaticMarkup(
    React.createElement(NotificationCenter, {
      notifications: overrides.notifications ?? [],
      onDismiss: () => {},
      onClear: () => {},
      desktopState: overrides.desktopState ?? 'default',
      desktopPreferenceEnabled: overrides.desktopPreferenceEnabled ?? false,
      onEnableDesktop: () => {},
      soundEnabled: overrides.soundEnabled ?? false,
      onToggleSound: () => {},
      storageAvailable: overrides.storageAvailable ?? false,
      onSendTestNotification: overrides.onSendTestNotification,
    })
  );
}

test('CENTER 1 — granted + opted in shows enabled and no enable button', () => {
  const html = render({ desktopState: 'granted', desktopPreferenceEnabled: true });
  assert.match(html, /Desktop notifications enabled/);
  assert.doesNotMatch(html, /ENABLE DESKTOP NOTIFICATIONS/);
});

test('CENTER 2 — granted but not opted in offers enabling instead of claiming enabled', () => {
  const html = render({ desktopState: 'granted', desktopPreferenceEnabled: false });
  assert.doesNotMatch(html, /Desktop notifications enabled/);
  assert.match(html, /ENABLE DESKTOP NOTIFICATIONS/);
});

test('CENTER 3 — a not-yet-decided permission offers enabling', () => {
  const html = render({ desktopState: 'default', desktopPreferenceEnabled: false });
  assert.match(html, /ENABLE DESKTOP NOTIFICATIONS/);
  assert.doesNotMatch(html, /Desktop notifications enabled/);
});

test('CENTER 4 — a denied permission is reported as blocked with no enable button', () => {
  const html = render({ desktopState: 'denied', desktopPreferenceEnabled: false });
  assert.match(html, /Desktop notifications blocked/);
  assert.doesNotMatch(html, /ENABLE DESKTOP NOTIFICATIONS/);
  assert.doesNotMatch(html, /Desktop notifications enabled/);
});

test('CENTER 5 — an unsupported browser is reported as unavailable with no enable button', () => {
  const html = render({ desktopState: 'unsupported', desktopPreferenceEnabled: false });
  assert.match(html, /Desktop notifications unavailable in this browser/);
  assert.doesNotMatch(html, /ENABLE DESKTOP NOTIFICATIONS/);
});

test('CENTER 6 — the sound toggle reflects the stored sound preference', () => {
  assert.match(render({ soundEnabled: true }), /checked/);
  assert.doesNotMatch(render({ soundEnabled: false }), /checked/);
});

test('CENTER 7 — the dev test control renders only when its handler is provided', () => {
  assert.match(render({ onSendTestNotification: () => {} }), /SEND TEST NOTIFICATION \(DEV\)/);
  assert.doesNotMatch(render({}), /SEND TEST NOTIFICATION/);
});

test('CENTER 8 — a test notification is labelled as a test, never as a real signal', () => {
  const html = render({ notifications: [buildTestNotificationEvent('abc')] });
  assert.match(html, /NOTIFICATION TEST/);
  assert.match(html, /this is not a trading signal/);
  // No real-signal framing: no "NEWLY GENERATED SIGNAL" label and no LONG/SHORT title.
  assert.doesNotMatch(html, /NEWLY GENERATED SIGNAL/);
  assert.doesNotMatch(html, /New (LONG|SHORT) signal/);
});
