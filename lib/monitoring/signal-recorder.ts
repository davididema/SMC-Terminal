/**
 * Genuine-signal fixture recorder (Phase 2B, Stage 3) — pure and fail-closed.
 *
 * Records the EXACT closed-candle input an accepted LONG/SHORT evaluation used
 * (the full ordered `CandleManager.getHistory` array, snapshotted at the same
 * synchronous point `evaluatePair` reads it) together with the detector's
 * accepted event, so the same pair can later be replayed through the unchanged
 * pipeline and compared field-for-field (test/signal-replay-harness.ts).
 *
 * Safety rules (never fabricate, never mutate, fail closed):
 * - recording happens ONLY after the existing detector accepts a candidate;
 *   NO_TRADE, rejected, duplicate, missing-identity, and manual test events
 *   are refused with an explicit reason and produce no fixture;
 * - every input is validated (closed, strictly time-ordered, invariant-valid
 *   candles; confirming-candle and identity cross-checks) before anything is
 *   built — any deviation refuses the recording;
 * - fixtures are deep-copied and allow-list field-constructed: no field
 *   outside the documented schema is ever written, and the recorded inputs
 *   are never mutated;
 * - this module performs NO I/O and reads NO environment variable. Persistence
 *   is an injected `RecordingSink` (see signal-recorder-file.ts for the opt-in,
 *   development-only file sink). Without a sink, recording refuses (`no-sink`).
 *
 * Nothing here changes strategy, identity, dedup, or evaluation behaviour:
 * `MonitoringCore` only calls the recorder when one is explicitly injected.
 */

import { assertCandleInvariants, type Candle } from '../deriv/candles';
import type { SignalOutput } from '../signals/signal-engine';
import { isGeneratedSignal, signalPairKey } from '../signals/signal-history';
import { signalConfirmingEpoch } from '../notifications/detector';
import type { DetectionResult } from '../notifications/types';

/** Discriminator written into every fixture (loader validates it). */
export const GENUINE_FIXTURE_KIND = 'genuine-recorded-signal';
/** Schema version of the fixture format. */
export const GENUINE_FIXTURE_VERSION = 1;
/** Refuse pathological inputs instead of buffering them (fail closed). */
export const DEFAULT_MAX_CANDLES = 50_000;

/** Exact top-level key allow-list of a fixture. */
export const FIXTURE_KEYS = [
  'fixtureKind',
  'fixtureVersion',
  'recordedAt',
  'source',
  'symbolId',
  'timeframe',
  'pairKey',
  'confirmingCandleEpoch',
  'candleCount',
  'candles',
  'signalId',
  'signal',
] as const;

/** Exact key allow-list of every recorded candle. */
export const RECORDED_CANDLE_KEYS = [
  'epoch',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'isClosed',
] as const;

/** Exact key allow-list of the recorded signal (verbatim `SignalOutput` subset). */
export const FIXTURE_SIGNAL_KEYS = [
  'decision',
  'confidence',
  'setup',
  'entry',
  'stopLoss',
  'takeProfit',
  'riskReward',
  'reason',
  'timestamp',
  'signalEpoch',
  'triggerId',
  'signalId',
  'confluenceBreakdown',
  'rejectionReasons',
] as const;

/** One recorded input candle, exactly as the evaluation saw it. */
export interface RecordedCandle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
}

/** A genuine, recorded fixture: real detector acceptance + its real candle input. */
export interface GenuineSignalFixture {
  fixtureKind: typeof GENUINE_FIXTURE_KIND;
  fixtureVersion: typeof GENUINE_FIXTURE_VERSION;
  /** ISO-8601 wall-clock time the fixture was recorded (metadata only). */
  recordedAt: string;
  /** Which configured recorder produced this fixture (e.g. `monitoring-core`). */
  source: string;
  symbolId: string;
  timeframe: string;
  pairKey: string;
  confirmingCandleEpoch: number;
  candleCount: number;
  /** Full ordered closed-candle input; never truncated, never reordered. */
  candles: RecordedCandle[];
  /** Engine-authoritative identity (`SignalOutput.signalId`). */
  signalId: string;
  /** The engine's emitted output, allow-list copied verbatim. */
  signal: SignalOutput;
}

/**
 * Persistence port. Implementations MUST be synchronous and MUST throw on
 * failure (the recorder converts any throw into a `write-failed:*` refusal).
 */
export interface RecordingSink {
  writeFixture(fixture: GenuineSignalFixture): void;
}

/** Outcome of one recording attempt. `fixture` is non-null only on success. */
export interface SignalRecordingAttempt {
  recorded: boolean;
  /** Refusal reason when `recorded` is false; `null` when recorded. */
  reason: string | null;
  fixture: GenuineSignalFixture | null;
}

/** Everything the recorder needs; symbol/timeframe are cross-checked too. */
export interface SignalRecordingInput {
  /** The detector's verdict — recording is gated on `accepted === true`. */
  detection: DetectionResult;
  /** Pair actually evaluated (cross-checked against the accepted event). */
  symbolId: string;
  timeframe: string;
  /** Epoch of the candle that just closed and confirmed the signal. */
  confirmingCandleEpoch: number | null;
  /** The exact ordered closed-candle input array of this evaluation. */
  candles: readonly Candle[];
}

export interface SignalRecorderOptions {
  /** Where accepted fixtures go. Omit to refuse every recording (`no-sink`). */
  sink?: RecordingSink;
  /** Fixture label written into `source` (metadata only). */
  source?: string;
  /** Refuse inputs longer than this (default 50,000 candles). */
  maxCandles?: number;
  /** Clock injection point (defaults to `() => new Date()`). */
  now?: () => Date;
  /** Observer for every attempt (success or refusal); never breaks recording. */
  onAttempt?: (attempt: SignalRecordingAttempt) => void;
}

function fail(reason: string): SignalRecordingAttempt {
  return { recorded: false, reason, fixture: null };
}

function sanitizeReason(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function copyCandle(c: Candle): RecordedCandle {
  return {
    epoch: c.epoch,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    isClosed: c.isClosed,
  };
}

/** Allow-list copy: unknown/extraneous fields on the signal are dropped. */
function copySignal(signal: SignalOutput): SignalOutput {
  const out: SignalOutput = {
    decision: signal.decision,
    confidence: signal.confidence,
    setup: signal.setup,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    riskReward: signal.riskReward,
    reason: signal.reason,
    timestamp: signal.timestamp,
  };
  if (signal.signalEpoch !== undefined) out.signalEpoch = signal.signalEpoch;
  if (signal.triggerId !== undefined) out.triggerId = signal.triggerId;
  if (signal.signalId !== undefined) out.signalId = signal.signalId;
  if (signal.confluenceBreakdown !== undefined) {
    out.confluenceBreakdown = [...signal.confluenceBreakdown];
  }
  if (signal.rejectionReasons !== undefined) {
    out.rejectionReasons = [...signal.rejectionReasons];
  }
  return out;
}

/**
 * Records genuine signal fixtures. Construction performs no I/O; `record`
 * performs no I/O either — only the injected sink does, and only for inputs
 * that passed every gate.
 */
export class SignalRecorder {
  private readonly sink: RecordingSink | undefined;
  private readonly source: string;
  private readonly maxCandles: number;
  private readonly now: () => Date;
  private readonly onAttempt: ((attempt: SignalRecordingAttempt) => void) | undefined;

  constructor(options: SignalRecorderOptions = {}) {
    this.sink = options.sink;
    this.source = options.source ?? 'monitoring-core';
    this.maxCandles = options.maxCandles ?? DEFAULT_MAX_CANDLES;
    this.now = options.now ?? (() => new Date());
    this.onAttempt = options.onAttempt;
  }

  /**
   * Attempt to record one evaluation. Returns (never throws) an explicit
   * attempt: `recorded: true` only when the detector accepted a genuine,
   * identity-bearing signal AND every input check passed AND the sink wrote
   * the fixture. Otherwise `fixture` is `null` and `reason` says why.
   */
  public record(input: SignalRecordingInput): SignalRecordingAttempt {
    let attempt: SignalRecordingAttempt;
    try {
      attempt = this.tryRecord(input);
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Unknown';
      attempt = fail(`recorder-error:${name}`);
    }
    this.notify(attempt);
    return attempt;
  }

  private tryRecord(input: SignalRecordingInput): SignalRecordingAttempt {
    const { detection, symbolId, timeframe, confirmingCandleEpoch, candles } = input;

    // --- Gate 1: the existing detector must have accepted this candidate. ---
    if (!detection || typeof detection.accepted !== 'boolean') {
      return fail('invalid-detection');
    }
    if (!detection.accepted) {
      return fail(`detection-rejected:${detection.reason}`);
    }
    const event = detection.event;
    if (!event) {
      return fail('missing-event');
    }

    // --- Gate 2: manual notification tests are never genuine signals. ---
    if (event.isTest === true) {
      return fail('test-event');
    }

    // --- Gate 3: genuine LONG/SHORT with an engine-authoritative identity. ---
    if (!isGeneratedSignal(event.signal)) {
      return fail('not-generated');
    }
    const signal = event.signal;
    const signalId = signal.signalId;
    if (typeof signalId !== 'string' || signalId.length === 0) {
      return fail('missing-identity');
    }
    if (event.signalId !== signalId) {
      return fail('identity-mismatch');
    }

    // --- Gate 4: the event and identity belong to the evaluated pair. ---
    const expectedPairKey = signalPairKey(symbolId, timeframe);
    if (event.pairKey !== expectedPairKey) {
      return fail('pair-mismatch');
    }
    if (event.symbolId !== symbolId || event.timeframe !== timeframe) {
      return fail('identity-pair-mismatch');
    }
    if (!signalId.startsWith(`${symbolId}:${timeframe}:`)) {
      return fail('identity-pair-mismatch');
    }

    // --- Gate 5: confirming-candle agreement (detector rule, re-checked). ---
    if (typeof confirmingCandleEpoch !== 'number' || !Number.isFinite(confirmingCandleEpoch)) {
      return fail('confirming-mismatch');
    }
    if (signalConfirmingEpoch(signal) !== confirmingCandleEpoch) {
      return fail('signal-epoch-mismatch');
    }

    // --- Gate 6: the candle input is complete, ordered, and valid. ---
    if (candles.length === 0) {
      return fail('empty-input');
    }
    if (candles.length > this.maxCandles) {
      return fail('input-too-large');
    }
    let previousEpoch = Number.NEGATIVE_INFINITY;
    for (const c of candles) {
      if (c.isClosed !== true) {
        return fail('incomplete-candle');
      }
      if (!Number.isInteger(c.epoch) || c.epoch <= 0) {
        return fail('invalid-candle');
      }
      if (c.epoch <= previousEpoch) {
        return fail('unordered-input');
      }
      previousEpoch = c.epoch;
      if (!assertCandleInvariants(c)) {
        return fail('invalid-candle');
      }
    }
    const lastCandle = candles[candles.length - 1];
    if (lastCandle.epoch !== confirmingCandleEpoch) {
      return fail('confirming-candle-mismatch');
    }

    // --- Build the fixture (deep copy, allow-listed fields only). ---
    const fixture: GenuineSignalFixture = {
      fixtureKind: GENUINE_FIXTURE_KIND,
      fixtureVersion: GENUINE_FIXTURE_VERSION,
      recordedAt: this.now().toISOString(),
      source: this.source,
      symbolId,
      timeframe,
      pairKey: expectedPairKey,
      confirmingCandleEpoch,
      candleCount: candles.length,
      candles: candles.map(copyCandle),
      signalId,
      signal: copySignal(signal),
    };

    if (!this.sink) {
      return fail('no-sink');
    }
    try {
      this.sink.writeFixture(fixture);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(`write-failed:${sanitizeReason(message)}`);
    }

    return { recorded: true, reason: null, fixture };
  }

  private notify(attempt: SignalRecordingAttempt): void {
    if (!this.onAttempt) return;
    try {
      this.onAttempt(attempt);
    } catch {
      // An observer must never break the evaluation pipeline.
    }
  }
}
