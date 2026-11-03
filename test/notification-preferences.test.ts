import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCES_KEY,
  sanitizePreferences,
  createMemoryPreferencesStore,
  createLocalPreferencesStore,
  type StorageLike,
} from '../lib/notifications/preferences';

function fakeStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Record<string, string>;
  setCount: number;
} {
  const store = {
    data: { ...initial },
    setCount: 0,
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store.data, key) ? store.data[key] : null;
    },
    setItem(key: string, value: string) {
      store.setCount += 1;
      store.data[key] = value;
    },
  };
  return store;
}

test('PREF 1 — defaults are all opt-out (desktop off, sound off, not prompted)', () => {
  assert.deepEqual(DEFAULT_NOTIFICATION_PREFERENCES, {
    desktop: false,
    sound: false,
    desktopPrompted: false,
  });
  assert.equal(Object.isFrozen(DEFAULT_NOTIFICATION_PREFERENCES), true);
});

test('PREF 2 — sanitize coerces arbitrary data and ignores non-booleans', () => {
  assert.deepEqual(sanitizePreferences(null), { ...DEFAULT_NOTIFICATION_PREFERENCES });
  assert.deepEqual(sanitizePreferences('nope'), { ...DEFAULT_NOTIFICATION_PREFERENCES });
  assert.deepEqual(sanitizePreferences({ desktop: 'yes', sound: 1, desktopPrompted: {} }), {
    desktop: false,
    sound: false,
    desktopPrompted: false,
  });
  assert.deepEqual(sanitizePreferences({ desktop: true, sound: true, desktopPrompted: true }), {
    desktop: true,
    sound: true,
    desktopPrompted: true,
  });
});

test('PREF 3 — memory store round-trips and reports no durable storage', () => {
  const store = createMemoryPreferencesStore();
  assert.equal(store.isAvailable(), false);
  assert.deepEqual(store.load(), { ...DEFAULT_NOTIFICATION_PREFERENCES });
  store.save({ desktop: true, sound: true, desktopPrompted: true });
  assert.deepEqual(store.load(), { desktop: true, sound: true, desktopPrompted: true });
});

test('PREF 4 — local store persists under the versioned key and uses defaults when empty', () => {
  const storage = fakeStorage();
  const store = createLocalPreferencesStore(storage);
  assert.equal(store.isAvailable(), true);
  assert.deepEqual(store.load(), { ...DEFAULT_NOTIFICATION_PREFERENCES });

  store.save({ desktop: true, sound: false, desktopPrompted: true });
  assert.equal(storage.setCount, 1);
  assert.equal(NOTIFICATION_PREFERENCES_KEY, 'uche.notificationPreferences.v1');
  const raw = storage.data[NOTIFICATION_PREFERENCES_KEY];
  assert.deepEqual(JSON.parse(raw), { desktop: true, sound: false, desktopPrompted: true });

  const reloaded = createLocalPreferencesStore(storage);
  assert.deepEqual(reloaded.load(), { desktop: true, sound: false, desktopPrompted: true });
});

test('PREF 5 — corrupt stored JSON falls back to defaults without throwing', () => {
  const storage = fakeStorage({ [NOTIFICATION_PREFERENCES_KEY]: '{not json' });
  const store = createLocalPreferencesStore(storage);
  assert.deepEqual(store.load(), { ...DEFAULT_NOTIFICATION_PREFERENCES });
});

test('PREF 6 — a throwing storage degrades to defaults and swallows writes', () => {
  const throwing: StorageLike = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  const store = createLocalPreferencesStore(throwing);
  assert.equal(store.isAvailable(), true);
  assert.deepEqual(store.load(), { ...DEFAULT_NOTIFICATION_PREFERENCES });
  assert.doesNotThrow(() => store.save({ desktop: true, sound: true, desktopPrompted: true }));
});

test('PREF 7 — a null storage forces the memory fallback', () => {
  const store = createLocalPreferencesStore(null);
  assert.equal(store.isAvailable(), false);
  store.save({ desktop: true, sound: false, desktopPrompted: false });
  assert.deepEqual(store.load(), { desktop: true, sound: false, desktopPrompted: false });
});
