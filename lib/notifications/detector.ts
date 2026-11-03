/**
 * New-signal detection (pure).
 *
 * Decides whether an evaluation result is a genuinely new notification-worthy
 * signal. It reuses the existing `isGeneratedSignal` helper and requires the
 * generated signal's confirming candle to be the candle that just closed
 * (`signalEpoch === confirmingCandleEpoch`). This is what prevents backfill,
 * selection switches, reconnections, and retained historical signals from being
 * mistaken for new signals.
 *
 * The engine's authoritative identity (`SignalOutput.signalId`) is used as-is;
 * no identity is reconstructed here.
 */

import { isGeneratedSignal } from '../signals/signal-history';
import type { SignalOutput } from '../signals/signal-engine';
import type { DetectionInput, DetectionResult, GeneratedSignalEvent } from './types';

/**
 * The confirming-candle epoch of a generated signal, or `null` when unavailable.
 * Prefers the engine's explicit `signalEpoch` and falls back to `timestamp`
 * (rejecting the engine's `0` "no confirming candle" sentinel).
 */
export function signalConfirmingEpoch(
  signal: SignalOutput | null | undefined
): number | null {
  if (!signal) return null;
  const epoch = signal.signalEpoch !== undefined ? signal.signalEpoch : signal.timestamp;
  return typeof epoch === 'number' && Number.isFinite(epoch) && epoch > 0 ? epoch : null;
}

/**
 * Pure decision function. `notifiedIds` is the set of already-notified identities
 * (typically from `NotificationSession`); it is read but never mutated here.
 */
export function detectNewSignal(
  input: DetectionInput,
  notifiedIds: ReadonlySet<string>
): DetectionResult {
  const { signal } = input;

  if (!isGeneratedSignal(signal)) {
    return { accepted: false, reason: 'not-generated', event: null };
  }

  const signalId = signal.signalId;
  if (typeof signalId !== 'string' || signalId.length === 0) {
    return { accepted: false, reason: 'missing-identity', event: null };
  }

  const epoch = signalConfirmingEpoch(signal);
  if (epoch !== input.confirmingCandleEpoch) {
    return { accepted: false, reason: 'epoch-mismatch', event: null };
  }

  if (notifiedIds.has(signalId)) {
    return { accepted: false, reason: 'duplicate', event: null };
  }

  const event: GeneratedSignalEvent = {
    signalId,
    pairKey: input.pairKey,
    symbolId: input.symbolId,
    timeframe: input.timeframe,
    signal,
  };
  return { accepted: true, reason: 'accepted', event };
}

/**
 * Session-scoped dedup store. State mutates only when a candidate is accepted,
 * mirroring the signal engine's "consume identity only on emission" semantics.
 * It is intentionally not persisted (Phase 1 in-app history is session-only).
 */
export class NotificationSession {
  private notified = new Set<string>();

  public detect(input: DetectionInput): DetectionResult {
    const result = detectNewSignal(input, this.notified);
    if (result.accepted && result.event) {
      this.notified.add(result.event.signalId);
    }
    return result;
  }

  public has(signalId: string): boolean {
    return this.notified.has(signalId);
  }

  public size(): number {
    return this.notified.size;
  }

  public reset(): void {
    this.notified.clear();
  }
}
