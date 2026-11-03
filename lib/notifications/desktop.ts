/**
 * Desktop browser notifications (Notifications API) behind an injectable,
 * testable interface.
 *
 * Permission is only ever requested when the caller explicitly asks
 * (`requestPermission`), which the dashboard invokes solely from a user click.
 * After a denial the notifier never requests again. Unsupported environments
 * degrade gracefully (callers fall back to in-app notifications).
 */

import type { GeneratedSignalEvent } from './types';

export type DesktopPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

export interface NotificationHandle {
  close?(): void;
}

/** Structural subset of the DOM `Notification` constructor. */
export interface NotificationConstructorLike {
  permission: string;
  requestPermission(): Promise<string>;
  new (title: string, options?: Record<string, unknown>): NotificationHandle;
}

export interface DesktopEnvironment {
  Notification?: NotificationConstructorLike;
}

export interface DesktopNotifier {
  isSupported(): boolean;
  getPermissionState(): DesktopPermissionState;
  /** Requests permission once; never re-requests after a denial. */
  requestPermission(): Promise<DesktopPermissionState>;
  /** Shows a notification; returns false when unsupported/not granted. */
  show(event: GeneratedSignalEvent, title: string, body: string): boolean;
}

function mapPermission(value: string | null | undefined): DesktopPermissionState {
  if (value === 'granted') return 'granted';
  if (value === 'denied') return 'denied';
  if (value === 'default') return 'default';
  return 'unsupported';
}

/**
 * Desktop alerts are delivered only when BOTH hold: the user explicitly opted in
 * (stored preference) AND the browser has granted permission. Browser permission
 * alone is never treated as consent, so a previously disabled preference stays
 * disabled even while permission is `granted`.
 */
export function isDesktopDeliveryActive(
  desktopPreferenceEnabled: boolean,
  permission: DesktopPermissionState
): boolean {
  return desktopPreferenceEnabled === true && permission === 'granted';
}

/**
 * The preference to persist after an explicit enable request resolves to
 * `permission`. Only a granted result opts in; denied/default/unsupported leave
 * the preference disabled.
 */
export function desktopPreferenceFromPermission(
  permission: DesktopPermissionState
): boolean {
  return permission === 'granted';
}

export function createDesktopNotifier(env: DesktopEnvironment = {}): DesktopNotifier {
  const Ctor = env.Notification;
  let permission: DesktopPermissionState = Ctor ? mapPermission(Ctor.permission) : 'unsupported';

  return {
    isSupported() {
      return Ctor !== undefined;
    },
    getPermissionState() {
      return permission;
    },
    async requestPermission() {
      if (!Ctor) {
        permission = 'unsupported';
        return permission;
      }
      // Never re-prompt after a denial or when already granted.
      if (permission === 'denied' || permission === 'granted') {
        return permission;
      }
      try {
        const result = await Ctor.requestPermission();
        permission = mapPermission(result);
      } catch {
        // Permission request failed; leave the current state unchanged.
      }
      return permission;
    },
    show(event, title, body) {
      if (!Ctor || permission !== 'granted') return false;
      try {
        const handle = new Ctor(title, { body, tag: event.signalId });
        void handle;
        return true;
      } catch {
        return false;
      }
    },
  };
}
