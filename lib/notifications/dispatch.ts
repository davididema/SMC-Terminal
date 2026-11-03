/**
 * Pure channel routing for an accepted signal event.
 *
 * In-app delivery is always on. Desktop and sound are opt-in per preferences.
 * This function must only ever be called for an event the detector accepted, so
 * NO_TRADE/duplicate/historical signals can never reach a channel.
 */

import type { GeneratedSignalEvent } from './types';
import type { NotificationPreferences } from './preferences';

export interface NotificationSinks {
  inApp(event: GeneratedSignalEvent): void;
  desktop(event: GeneratedSignalEvent): void;
  sound(event: GeneratedSignalEvent): void;
}

export interface DispatchResult {
  inApp: boolean;
  desktop: boolean;
  sound: boolean;
}

export function dispatchNotification(
  event: GeneratedSignalEvent,
  preferences: NotificationPreferences,
  sinks: NotificationSinks
): DispatchResult {
  sinks.inApp(event);

  const desktop = preferences.desktop === true;
  const sound = preferences.sound === true;

  if (desktop) sinks.desktop(event);
  if (sound) sinks.sound(event);

  return { inApp: true, desktop, sound };
}
