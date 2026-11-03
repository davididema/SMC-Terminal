/**
 * Pure helpers that retain the most recently *generated* signal separately from
 * the latest *evaluation* result, keyed by `symbol:timeframe`.
 *
 * This exists so the dashboard can honour two distinct concepts without touching
 * the signal engine:
 *
 * - latest evaluation: whatever `SignalEngine.evaluate` returned this run,
 *   including `NO_TRADE` (with rejection reasons);
 * - last generated signal: the most recent genuine `LONG`/`SHORT` emission,
 *   preserved even when later evaluations return `NO_TRADE`.
 *
 * The engine emits `LONG`/`SHORT` only for a fully-qualified setup; every
 * rejection — including `NO_TRADE`/`DUPLICATE` — carries `decision: 'NO_TRADE'`.
 * These helpers therefore treat only `LONG`/`SHORT` decisions as generated
 * signals. They never mutate engine state, duplicate-suppression state, or any
 * analysis input, and they never invent expiry or invalidation rules.
 */

import type { SignalOutput } from './signal-engine';

/** Canonical per-pair key. Symbol and timeframe never mix. */
export function signalPairKey(symbolId: string, timeframe: string): string {
  return `${symbolId}:${timeframe}`;
}

/**
 * True only for a genuine engine emission (`LONG`/`SHORT`). Rejected candidates
 * and `NO_TRADE` outputs (including `DUPLICATE`) are not generated signals.
 */
export function isGeneratedSignal(
  signal: SignalOutput | null | undefined
): signal is SignalOutput {
  return (
    signal !== null &&
    signal !== undefined &&
    (signal.decision === 'LONG' || signal.decision === 'SHORT')
  );
}

/**
 * Records `signal` under `key` and returns the resulting store. A non-generated
 * signal (or missing signal/direction) leaves the store untouched (same
 * reference), so a `NO_TRADE` evaluation never overwrites a retained signal.
 */
export function recordGeneratedSignal(
  store: ReadonlyMap<string, SignalOutput>,
  key: string,
  signal: SignalOutput | null | undefined
): Map<string, SignalOutput> {
  if (!isGeneratedSignal(signal)) {
    return store as Map<string, SignalOutput>;
  }
  const next = new Map(store);
  next.set(key, signal);
  return next;
}

/** Reads the retained signal for the exact pair; `null` when none exists. */
export function getGeneratedSignal(
  store: ReadonlyMap<string, SignalOutput>,
  key: string
): SignalOutput | null {
  return store.get(key) ?? null;
}

/**
 * Drops the retained signal of one pair and returns the resulting store.
 *
 * The store is returned unchanged (same reference) when the pair holds no
 * retained signal, so a caller that invalidates nothing does not produce a new
 * state. This is the only way a retained signal is removed: a retained signal
 * is never overwritten by a later evaluation, so an explicit removal is
 * required when the decision it belongs to stops being trustworthy.
 */
export function removeGeneratedSignal(
  store: ReadonlyMap<string, SignalOutput>,
  key: string
): Map<string, SignalOutput> {
  if (!store.has(key)) return store as Map<string, SignalOutput>;
  const next = new Map(store);
  next.delete(key);
  return next;
}
