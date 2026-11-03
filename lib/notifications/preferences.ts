/**
 * Notification preferences with safe defaults.
 *
 * The store interface is deliberately small so a future authenticated,
 * server-backed implementation can replace the local browser store without
 * changing the notification pipeline. All reads/writes are defensive: corrupt
 * JSON, missing storage, or privacy-mode failures fall back to defaults.
 */

export interface NotificationPreferences {
  /** Desktop browser notifications enabled (only delivered when permission is granted). */
  desktop: boolean;
  /** Optional sound alerts. Disabled by default. */
  sound: boolean;
  /** Whether the desktop permission prompt has already been offered once. */
  desktopPrompted: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<NotificationPreferences> = Object.freeze({
  desktop: false,
  sound: false,
  desktopPrompted: false,
});

/** Minimal subset of the Web Storage API used here (keeps this module testable). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface NotificationPreferencesStore {
  load(): NotificationPreferences;
  save(prefs: NotificationPreferences): void;
  /** Whether durable storage is actually available in this environment. */
  isAvailable(): boolean;
}

export const NOTIFICATION_PREFERENCES_KEY = 'uche.notificationPreferences.v1';

/** Coerces arbitrary stored data into valid preferences; never throws. */
export function sanitizePreferences(raw: unknown): NotificationPreferences {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }
  const r = raw as Record<string, unknown>;
  return {
    desktop: r.desktop === true,
    sound: r.sound === true,
    desktopPrompted: r.desktopPrompted === true,
  };
}

/** In-memory store, used as a fallback and in tests. */
export function createMemoryPreferencesStore(
  initial: NotificationPreferences = DEFAULT_NOTIFICATION_PREFERENCES
): NotificationPreferencesStore {
  let current = sanitizePreferences(initial);
  return {
    load: () => ({ ...current }),
    save: (prefs) => {
      current = sanitizePreferences(prefs);
    },
    isAvailable: () => false,
  };
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    // Accessing localStorage can throw in restricted/privacy contexts.
    return null;
  }
}

/**
 * localStorage-backed store. When `storage` is omitted it resolves
 * `window.localStorage` lazily. If durable storage is unavailable (or `null` is
 * passed explicitly, as in privacy-restricted contexts) the store transparently
 * degrades to an in-memory store so preferences still round-trip for the session
 * and `isAvailable()` truthfully reports the absence of durable storage.
 */
export function createLocalPreferencesStore(
  storage?: StorageLike | null
): NotificationPreferencesStore {
  let resolved: StorageLike | null | undefined = storage;
  let memoryValue: string | null = null;

  const get = (): StorageLike | null => {
    if (resolved === undefined) {
      resolved = resolveStorage(undefined);
    }
    return resolved;
  };

  const read = (): string | null => {
    const s = get();
    if (s) return s.getItem(NOTIFICATION_PREFERENCES_KEY);
    return memoryValue;
  };

  const write = (value: string): void => {
    const s = get();
    if (s) {
      s.setItem(NOTIFICATION_PREFERENCES_KEY, value);
      return;
    }
    memoryValue = value;
  };

  return {
    load() {
      try {
        const raw = read();
        if (!raw) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
        return sanitizePreferences(JSON.parse(raw));
      } catch {
        return { ...DEFAULT_NOTIFICATION_PREFERENCES };
      }
    },
    save(prefs) {
      try {
        write(JSON.stringify(sanitizePreferences(prefs)));
      } catch {
        // Ignore write failures (quota, privacy mode) — preferences are best-effort.
      }
    },
    isAvailable() {
      try {
        return get() !== null;
      } catch {
        return false;
      }
    },
  };
}
