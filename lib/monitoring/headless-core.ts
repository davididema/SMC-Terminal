/**
 * Headless monitoring core (Phase 2B, Stage 1).
 *
 * A transport-agnostic, Node-compatible orchestration layer that reuses the
 * EXISTING market-data, SMC-analysis, signal-evaluation, and
 * notification-detection modules unchanged. It exists so the same strategy
 * pipeline can later run in a background worker without the dashboard.
 *
 * What this layer deliberately does NOT do (Stage 1 scope):
 * - it never opens a network connection (no WebSocket, no Deriv);
 * - it never delivers desktop/sound/Web-Push notifications;
 * - it never persists anything by default (no database; the only persistence
 *   is the Stage 3 development-only signal fixture recorder, which is
 *   development-only, opt-in, and inert unless explicitly injected);
 * - it never re-implements strategy logic. `evaluatePair` delegates to the same
 *   `evaluateSignalForPair` entry point the dashboard uses and feeds the same
 *   reused `SignalEngine` / `NotificationSession` instances, so identical
 *   ordered closed candles produce identical outputs.
 *
 * Candle ingestion: a caller injects *closed* candles. `ingestClosedCandles`
 * delegates to the existing `CandleManager.seedHistory`, which merges by epoch
 * (dedup) and marks seeded candles closed. State is held per `symbol:timeframe`,
 * exactly as the dashboard holds it, so pairs never leak into each other.
 */

import { CandleManager, Timeframe, Candle } from '../deriv/candles';
import { SMCEngine } from '../analysis/smc';
import { SignalEngine } from '../signals/signal-engine';
import { evaluateSignalForPair, PairEvaluation } from '../signals/signal-eval';
import { NotificationSession } from '../notifications/detector';
import type { DetectionResult, GeneratedSignalEvent } from '../notifications/types';
import { signalPairKey } from '../signals/signal-history';
import type { SignalRecorder, SignalRecordingAttempt } from './signal-recorder';

/**
 * Collaborators the core drives. All are the existing production classes and
 * all are injectable so a worker (or a test) can share a single instance across
 * many pairs. Defaults are fresh instances with dashboard-equivalent config.
 */
export interface MonitoringCoreDependencies {
  candleManager?: CandleManager;
  smcEngine?: SMCEngine;
  signalEngine?: SignalEngine;
  session?: NotificationSession;
  /**
   * Stage 3 genuine-signal fixture recorder. `undefined` (the default) means
   * recording is completely inert: no report carries a `recording` field and
   * nothing is written anywhere. When injected, the recorder itself fails
   * closed — it only ever records a candidate the existing detector accepted
   * with its exact candle input, and refuses everything else.
   */
  recorder?: SignalRecorder;
}

/** Everything a caller needs after evaluating one pair on the latest closed candle. */
export interface PairEvaluationReport {
  /** Canonical `${symbolId}:${timeframe}` key (never mixes pairs). */
  pairKey: string;
  symbolId: string;
  timeframe: Timeframe;
  /**
   * Epoch of the candle that just closed and was used as the confirming candle,
   * or `null` when the pair has no closed candles yet (nothing evaluated).
   */
  confirmingCandleEpoch: number | null;
  /** The dashboard-equivalent evaluation result (same entry point, same engines). */
  evaluation: PairEvaluation;
  /** The existing detector's verdict for this evaluation. */
  detection: DetectionResult;
  /** The accepted notification candidate, or `null` when none was accepted. */
  candidate: GeneratedSignalEvent | null;
  /**
   * Stage 3 fixture-recording attempt. Present ONLY when a recorder was
   * explicitly injected into the core; absent entirely otherwise (default).
   * `recorded: true` ⟺ a genuine fixture of this evaluation's exact candle
   * input was handed to the injected sink.
   */
  recording?: SignalRecordingAttempt;
}

/**
 * Orchestrates the existing evaluation + detection pipeline for many pairs over
 * an injected, closed-candle source. It is the smallest Node-compatible unit
 * that reproduces dashboard evaluation semantics.
 */
export class MonitoringCore {
  public readonly candleManager: CandleManager;
  public readonly smcEngine: SMCEngine;
  /**
   * The reused signal engine. Its duplicate-suppression state
   * (`consumedIdentities`) persists across all evaluations it performs,
   * exactly as in the dashboard, and is keyed per pair.
   */
  public readonly signalEngine: SignalEngine;
  /** The reused notification dedup session (session-only, never persisted). */
  public readonly session: NotificationSession;
  /** Opt-in fixture recorder; `undefined` (default) = recording inert. */
  private readonly recorder: SignalRecorder | undefined;

  constructor(deps: MonitoringCoreDependencies = {}) {
    this.candleManager = deps.candleManager ?? new CandleManager();
    this.smcEngine = deps.smcEngine ?? new SMCEngine();
    this.signalEngine = deps.signalEngine ?? new SignalEngine();
    this.session = deps.session ?? new NotificationSession();
    this.recorder = deps.recorder;
  }

  /**
   * Seed/replay closed candles for a pair. Delegates to `CandleManager.seedHistory`:
   * candles are merged and de-duplicated by epoch, and the newest candle is only
   * treated as still-forming when the observed reference time actually falls
   * inside its period (so genuinely closed candles — whose period has ended —
   * always land in closed history). No candle, price, or zone is fabricated.
   */
  public ingestClosedCandles(
    symbolId: string,
    timeframe: Timeframe,
    candles: readonly Candle[]
  ): void {
    if (candles.length === 0) {
      return;
    }
    this.candleManager.seedHistory(
      symbolId,
      timeframe,
      candles.map((c) => ({
        epoch: c.epoch,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );
  }

  /**
   * Evaluate a pair from its closed-candle history and apply the existing
   * notification detector. Uses the exact same entry point as the dashboard
   * (`evaluateSignalForPair`) and the reused engine/session, so results are
   * strategy-equivalent. The confirming candle is the pair's latest closed
   * candle; with no closed candles the engine returns `signal: null` and the
   * detector reports `not-generated` (never a new signal).
   */
  public evaluatePair(symbolId: string, timeframe: Timeframe): PairEvaluationReport {
    const evaluation = evaluateSignalForPair(
      this.candleManager,
      this.smcEngine,
      this.signalEngine,
      symbolId,
      timeframe
    );

    const history = this.candleManager.getHistory(symbolId, timeframe);
    const lastClosed = history.length > 0 ? history[history.length - 1] : null;
    const confirmingCandleEpoch = lastClosed !== null ? lastClosed.epoch : null;

    const pairKey = signalPairKey(symbolId, timeframe);
    const detection = this.session.detect({
      signal: evaluation.signal,
      symbolId,
      timeframe,
      pairKey,
      confirmingCandleEpoch: confirmingCandleEpoch !== null ? confirmingCandleEpoch : Number.NaN,
    });

    const report: PairEvaluationReport = {
      pairKey,
      symbolId,
      timeframe,
      confirmingCandleEpoch,
      evaluation,
      detection,
      candidate: detection.accepted ? detection.event : null,
    };

    // Stage 3 (opt-in only): snapshot the EXACT closed-candle input this
    // evaluation just used — `history` was read synchronously from the same
    // `getHistory` call evaluation consumed, so content is identical — but
    // only after the existing detector accepted a genuine candidate. Without
    // an injected recorder no `recording` field exists at all.
    if (this.recorder) {
      if (detection.accepted && confirmingCandleEpoch !== null) {
        report.recording = this.recorder.record({
          detection,
          symbolId,
          timeframe,
          confirmingCandleEpoch,
          candles: history,
        });
      } else {
        report.recording = { recorded: false, reason: 'not-accepted', fixture: null };
      }
    }

    return report;
  }
}
