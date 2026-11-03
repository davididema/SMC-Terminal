'use client';

/**
 * Phase 1 notification orchestration.
 *
 * Detection is driven exclusively by the active pair's candle-close event (the
 * only caller is the dashboard's `onCandleClose` handler). It never runs from a
 * render or effect, so re-renders, selection switches, backfill, and reconnects
 * cannot raise alerts. Desktop and sound are opt-in; in-app delivery is always on.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SignalOutput } from '@/lib/signals/signal-engine';
import { signalPairKey } from '@/lib/signals/signal-history';
import { getSymbolConfig } from '@/lib/deriv/symbols';
import { NotificationSession } from '@/lib/notifications/detector';
import { dispatchNotification } from '@/lib/notifications/dispatch';
import {
  createLocalPreferencesStore,
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
  type NotificationPreferencesStore,
} from '@/lib/notifications/preferences';
import {
  createDesktopNotifier,
  desktopPreferenceFromPermission,
  type DesktopEnvironment,
  type DesktopNotifier,
  type DesktopPermissionState,
} from '@/lib/notifications/desktop';
import {
  browserAudioContextFactory,
  createSoundPlayer,
  type SoundPlayer,
} from '@/lib/notifications/sound';
import { buildNotificationView } from '@/lib/ui/notification-view';
import type { GeneratedSignalEvent } from '@/lib/notifications/types';
import {
  buildTestNotificationEvent,
  isNotificationTestEnabled,
  TEST_NOTIFICATION_BODY,
  TEST_NOTIFICATION_TITLE,
} from '@/lib/notifications/test-signal';

const MAX_NOTIFICATIONS = 20;

export interface CandleCloseSignalInput {
  signal: SignalOutput | null | undefined;
  symbolId: string;
  timeframe: string;
  /** Epoch of the candle that just closed and produced this evaluation. */
  confirmingCandleEpoch: number;
}

export interface UseSignalNotificationsResult {
  /** Newest-first, bounded to the latest 20, session-only. */
  notifications: GeneratedSignalEvent[];
  desktopState: DesktopPermissionState;
  preferences: NotificationPreferences;
  storageAvailable: boolean;
  /** Called only from the active pair's candle-close handler. */
  handleCandleClose: (input: CandleCloseSignalInput) => void;
  /**
   * Development-only manual delivery test. No-op in production builds. Never
   * touches the engine, detector, or retained signal history.
   */
  sendTestNotification: () => void;
  dismiss: (signalId: string) => void;
  clear: () => void;
  enableDesktop: () => void;
  setSoundEnabled: (value: boolean) => void;
}

function resolveBrowserNotification(): DesktopNotifier | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { Notification?: DesktopEnvironment['Notification'] })
    .Notification;
  return createDesktopNotifier({ Notification: ctor });
}

export function useSignalNotifications(): UseSignalNotificationsResult {
  const [notifications, setNotifications] = useState<GeneratedSignalEvent[]>([]);
  const [preferences, setPreferences] = useState<NotificationPreferences>({
    ...DEFAULT_NOTIFICATION_PREFERENCES,
  });
  const [desktopState, setDesktopState] =
    useState<DesktopPermissionState>('unsupported');
  const [storageAvailable, setStorageAvailable] = useState(false);

  const sessionRef = useRef<NotificationSession | null>(null);
  const storeRef = useRef<NotificationPreferencesStore | null>(null);
  const desktopRef = useRef<DesktopNotifier | null>(null);
  const soundRef = useRef<SoundPlayer | null>(null);
  const prefsRef = useRef<NotificationPreferences>({ ...DEFAULT_NOTIFICATION_PREFERENCES });
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    const store = createLocalPreferencesStore();
    storeRef.current = store;
    const loaded = store.load();
    prefsRef.current = loaded;
    setPreferences(loaded);
    setStorageAvailable(store.isAvailable());

    const notifier = resolveBrowserNotification();
    desktopRef.current = notifier;
    setDesktopState(notifier ? notifier.getPermissionState() : 'unsupported');

    soundRef.current = createSoundPlayer(browserAudioContextFactory());

    // Autoplay policies require a user gesture before audio can start.
    const unlock = () => soundRef.current?.unlock();
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', unlock, { once: true });
      window.addEventListener('keydown', unlock, { once: true });
    }

    return () => {
      mountedRef.current = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
      }
    };
  }, []);

  const persist = useCallback((next: NotificationPreferences) => {
    prefsRef.current = next;
    setPreferences(next);
    storeRef.current?.save(next);
  }, []);

  // Shared delivery: routes an already-accepted event to the in-app list and,
  // when opted in, to the desktop and sound sinks. Used by both the real
  // candle-close path and the manual delivery test.
  const deliver = useCallback((event: GeneratedSignalEvent, title: string, body: string) => {
    dispatchNotification(event, prefsRef.current, {
      inApp: (ev) => {
        setNotifications((prev) => [ev, ...prev].slice(0, MAX_NOTIFICATIONS));
      },
      desktop: (ev) => {
        desktopRef.current?.show(ev, title, body);
      },
      sound: () => {
        soundRef.current?.play();
      },
    });
  }, []);

  const handleCandleClose = useCallback((input: CandleCloseSignalInput) => {
    if (!mountedRef.current) return;

    const session = sessionRef.current ?? (sessionRef.current = new NotificationSession());
    const pairKey = signalPairKey(input.symbolId, input.timeframe);
    const result = session.detect({
      signal: input.signal,
      symbolId: input.symbolId,
      timeframe: input.timeframe,
      pairKey,
      confirmingCandleEpoch: input.confirmingCandleEpoch,
    });
    if (!result.accepted || !result.event) return;

    const event = result.event;
    const config = getSymbolConfig(input.symbolId);
    const view = buildNotificationView({
      signal: event.signal,
      symbolId: input.symbolId,
      displayName: config?.displayName,
      timeframe: input.timeframe,
      decimals: config?.pipSize,
    });

    deliver(event, view.title, view.body);
  }, [deliver]);

  // Development-only manual delivery test. Guarded defensively here as well as
  // at the call site so it can never fire in a production build.
  const sendTestNotification = useCallback(() => {
    if (!mountedRef.current) return;
    if (!isNotificationTestEnabled()) return;
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    deliver(buildTestNotificationEvent(nonce), TEST_NOTIFICATION_TITLE, TEST_NOTIFICATION_BODY);
  }, [deliver]);

  const dismiss = useCallback((signalId: string) => {
    setNotifications((prev) => prev.filter((n) => n.signalId !== signalId));
  }, []);

  const clear = useCallback(() => {
    setNotifications([]);
  }, []);

  const enableDesktop = useCallback(() => {
    const notifier = desktopRef.current ?? resolveBrowserNotification();
    desktopRef.current = notifier;
    if (!notifier) {
      setDesktopState('unsupported');
      return;
    }
    void notifier.requestPermission().then((state) => {
      if (!mountedRef.current) return;
      setDesktopState(state);
      persist({
        ...prefsRef.current,
        desktop: desktopPreferenceFromPermission(state),
        desktopPrompted: true,
      });
    });
  }, [persist]);

  const setSoundEnabled = useCallback(
    (value: boolean) => {
      const enabled = value === true;
      persist({ ...prefsRef.current, sound: enabled });
      if (enabled) soundRef.current?.unlock();
    },
    [persist]
  );

  return {
    notifications,
    desktopState,
    preferences,
    storageAvailable,
    handleCandleClose,
    sendTestNotification,
    dismiss,
    clear,
    enableDesktop,
    setSoundEnabled,
  };
}
