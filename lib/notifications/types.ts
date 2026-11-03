/**
 * Shared, browser-free notification types.
 *
 * A notification is only ever created from a `SignalOutput` the engine actually
 * emitted (decision `LONG`/`SHORT`). `signalId` is the engine's authoritative
 * identity (`symbol:timeframe:triggerId:selectedZoneId`); this layer never
 * reconstructs or invents an identity.
 */

import type { SignalOutput } from '../signals/signal-engine';

/** A genuinely generated LONG/SHORT signal captured for notification delivery. */
export interface GeneratedSignalEvent {
  /** Engine-authoritative identity (`SignalOutput.signalId`). */
  signalId: string;
  /** `${symbolId}:${timeframe}` — never mixes pairs. */
  pairKey: string;
  symbolId: string;
  timeframe: string;
  /** The engine's emitted output, carried verbatim. */
  signal: SignalOutput;
  /**
   * True only for a manually triggered delivery test. A test event never comes
   * from the detector or engine, is never a LONG/SHORT, and is rendered with a
   * distinct "NOTIFICATION TEST" presentation. Absent on all real signals.
   */
  isTest?: boolean;
}

/** Why a candidate was or was not accepted as a new notification. */
export type DetectionReason =
  | 'accepted'
  | 'not-generated'
  | 'missing-identity'
  | 'epoch-mismatch'
  | 'duplicate';

export interface DetectionResult {
  accepted: boolean;
  reason: DetectionReason;
  /** Present only when `accepted` is true. */
  event: GeneratedSignalEvent | null;
}

export interface DetectionInput {
  /** The latest evaluation result for the pair. */
  signal: SignalOutput | null | undefined;
  symbolId: string;
  timeframe: string;
  pairKey: string;
  /** Epoch of the candle that just closed and triggered this evaluation. */
  confirmingCandleEpoch: number;
}
