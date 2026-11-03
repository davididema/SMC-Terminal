/**
 * Pure view-model helpers for the Trade Signal panel.
 *
 * Kept side-effect free so the panel's display logic can be unit tested without
 * a browser. All labels are derived from the engine's own output; nothing here
 * invents prices, confidence, setups, or rejection causes.
 */

import type {
  SignalOutput,
  SignalRejectionCode,
  SignalDirection,
} from '../signals/signal-engine';
import type { PremiumDiscountZone } from '../analysis/smc';
import { formatPrice } from './smc-view';

export type SignalPanelStatus = 'EVALUATED' | 'INSUFFICIENT DATA' | 'WAITING FOR DATA';

/** Human-readable explanation for every engine rejection code. */
export const REJECTION_CODE_EXPLANATIONS: Record<SignalRejectionCode, string> = {
  INSUFFICIENT_DATA: 'Not enough confirmed market swings to evaluate.',
  FORMING_CANDLE: 'The last candle is still forming; evaluation runs on closed candles.',
  HTF_UNAVAILABLE: 'Higher-timeframe context is not available for this evaluation.',
  NO_CONTEXT: 'No actionable break of structure or change of character to set a direction.',
  STALE_TRIGGER: 'The latest actionable trigger is too old to act on.',
  ZONE_UNAVAILABLE: 'No dealing-range premium/discount zone is available.',
  NO_ELIGIBLE_ZONE: 'No fresh, usable zone of the intended direction is in range.',
  ZONE_MISALIGNED: 'The identified zone does not support the intended trade direction.',
  CONFLICTING_ZONES: 'The chosen zone conflicts with an overlapping opposing zone.',
  NO_FRESH_SWEEP: 'No qualifying fresh liquidity sweep was identified.',
  SL_UNRESOLVED: 'No structural location resolved for a stop loss.',
  SL_TOO_TIGHT: 'The stop loss sits within the minimum tolerance.',
  NO_TARGET: 'No valid opposing target structure was found.',
  RR_BELOW_MIN: 'Take-profit targets do not reach the minimum risk/reward.',
  DUPLICATE: 'This exact signal was already emitted and suppressed.',
};

export function describeRejection(code: SignalRejectionCode): string {
  return REJECTION_CODE_EXPLANATIONS[code] ?? `Signal rejected: ${code}.`;
}

export function explainRejections(
  codes: SignalRejectionCode[] | undefined
): { code: SignalRejectionCode; explanation: string }[] {
  return (codes ?? []).map((code) => ({ code, explanation: describeRejection(code) }));
}

/**
 * Truthful data-readiness / evaluation status, derived from state the UI
 * already holds — never from re-deriving the SMC engine's inputs.
 *
 * - `WAITING FOR DATA`: nothing has been evaluated yet — no closed candles, or
 *   no evaluation timestamp. The analysis has not run on valid completed data.
 * - `INSUFFICIENT DATA`: an evaluation ran on closed candles but the engine
 *   reported that the completed structure was not sufficient (`INSUFFICIENT_DATA`)
 *   or there was no valid closed confirming candle (`FORMING_CANDLE`). These are
 *   the engine's own structured reasons; the analysis is NOT complete.
 * - `EVALUATED`: the engine completed an analysis on sufficient closed-candle
 *   structure. The outcome may be LONG/SHORT or a genuine NO_TRADE (e.g.
 *   `NO_CONTEXT`, `ZONE_MISALIGNED`, `RR_BELOW_MIN`) — a valid no-trade is still
 *   a completed evaluation, not a data problem.
 *
 * Feed condition is reported separately (see `feedLabel`) and is unrelated to
 * this status.
 */
export function signalStatusLabel(
  hasClosedCandles: boolean,
  evaluatedAt: Date | null | undefined,
  rejectionCodes?: SignalRejectionCode[]
): SignalPanelStatus {
  if (!hasClosedCandles || !evaluatedAt) return 'WAITING FOR DATA';
  if (
    rejectionCodes !== undefined &&
    rejectionCodes.some(
      (code) => code === 'INSUFFICIENT_DATA' || code === 'FORMING_CANDLE'
    )
  ) {
    return 'INSUFFICIENT DATA';
  }
  return 'EVALUATED';
}

export function formatSignalTime(d: Date | null | undefined): string {
  if (!d) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Explicit timezone label applied to every timestamp this panel renders, so a
 * wall-clock evaluation time and candle (signal) times are never mixed silently.
 */
export const SIGNAL_TIMEZONE_LABEL = 'UTC';

/**
 * Formats a candle/signal epoch (Unix seconds, UTC by definition) as `HH:MM:SS`.
 *
 * Returns an em dash for a missing, non-finite, or non-positive epoch so a
 * signal time is never invented. The engine uses `timestamp = 0` to mean "no
 * valid confirming candle", which is therefore rendered as unavailable.
 */
export function formatEpochTimeUTC(epoch: number | null | undefined): string {
  if (epoch === null || epoch === undefined || !Number.isFinite(epoch) || epoch <= 0) {
    return '—';
  }
  return formatSignalTime(new Date(epoch * 1000));
}

export function formatDirection(direction: SignalDirection | null | undefined): string {
  if (direction === 'BULLISH') return 'LONG';
  if (direction === 'BEARISH') return 'SHORT';
  return '—';
}

export function formatSignalConfidence(value: number | null | undefined): string {
  if (value !== null && value !== undefined) return `${value}%`;
  return '—';
}

export function formatSignalPrice(
  value: number | null | undefined,
  decimals: number
): string {
  if (value === null || value === undefined) return '—';
  return formatPrice(value, decimals);
}

export function formatRiskReward(value: number | null | undefined): string {
  if (value !== null && value !== undefined) return `1:${value}`;
  return '—';
}

export function defaultSignalReason(
  hasSignal: boolean,
  hasClosedCandles: boolean,
  evaluatedAt: Date | null | undefined
): string {
  if (!hasSignal && !hasClosedCandles) return 'Waiting for market data before evaluation.';
  if (!hasSignal && !evaluatedAt) return 'Waiting for market structure confirmation.';
  return 'Waiting for market structure confirmation.';
}

export interface SignalViewInput {
  signal: SignalOutput | null | undefined;
  symbolId: string;
  displayName?: string;
  timeframe: string;
  marketBias?: string | null;
  region?: PremiumDiscountZone | null;
  direction?: SignalDirection | null;
  evaluatedAt?: Date | null;
  hasClosedCandles?: boolean;
  decimals?: number;
  feedLabel?: string;
  /** Confirming closed-candle epoch (signal generation/confirmation time). */
  signalEpoch?: number | null;
  /** Epoch of the most recent completed candle for the pair, when known. */
  lastClosedCandleEpoch?: number | null;
}

export interface SignalView {
  hasSignal: boolean;
  decision: string;
  status: SignalPanelStatus;
  symbolLine: string;
  timeframe: string;
  marketBias: string;
  region: string;
  direction: string;
  confidence: string;
  setup: string;
  entry: string;
  stopLoss: string;
  takeProfit: string;
  riskReward: string;
  rejections: { code: SignalRejectionCode; explanation: string }[];
  reason: string;
  /** When the signal's confirming candle occurred (candle/UTC), or '—'. */
  signalTime: string;
  /** When the latest completed candle occurred (candle/UTC), or '—'. */
  lastCandleTime: string;
  /** When the app last evaluated the available data (wall clock/UTC), or '—'. */
  evaluatedAt: string;
  timezoneLabel: string;
  feedLabel: string;
}

/**
 * Explicit label for the retained signal, so a historical emission is never
 * mistaken for the latest evaluation.
 */
export const HISTORICAL_SIGNAL_LABEL = 'LAST GENERATED SIGNAL — HISTORICAL';

/**
 * Truthful validity wording. The existing strategy has no rule that establishes
 * an emitted signal remains valid, so the panel must not assert validity or
 * invalidation — only the absence of re-confirmation.
 */
export const HISTORICAL_SIGNAL_VALIDITY_NOTE = 'Not re-confirmed; current validity is unknown.';

export const HISTORICAL_SIGNAL_EMPTY_NOTE = 'No signal has been generated for this pair yet.';

export interface HistoricalSignalViewInput {
  signal: SignalOutput | null | undefined;
  symbolId: string;
  displayName?: string;
  timeframe: string;
  decimals?: number;
}

export interface HistoricalSignalView {
  present: boolean;
  label: string;
  /** 'LONG' / 'SHORT' when present, otherwise '—'. */
  direction: string;
  setup: string;
  confidence: string;
  entry: string;
  stopLoss: string;
  takeProfit: string;
  riskReward: string;
  symbolLine: string;
  timeframe: string;
  /** Confirming candle epoch of the original emission, or '—'. */
  signalTime: string;
  timezoneLabel: string;
  validityNote: string;
  emptyNote: string;
}

/**
 * Builds the display model for the retained signal. Only a genuine `LONG`/`SHORT`
 * is shown; anything else (including `NO_TRADE`) yields the empty state. Values
 * and timestamps come from the original `SignalOutput` unchanged.
 */
export function buildHistoricalSignalView(
  input: HistoricalSignalViewInput
): HistoricalSignalView {
  const decimals = input.decimals ?? 5;
  const present =
    !!input.signal &&
    (input.signal.decision === 'LONG' || input.signal.decision === 'SHORT');
  const signal = present ? input.signal : null;

  const signalEpoch = signal
    ? signal.signalEpoch !== undefined
      ? signal.signalEpoch
      : signal.timestamp !== undefined && signal.timestamp > 0
        ? signal.timestamp
        : null
    : null;

  return {
    present,
    label: HISTORICAL_SIGNAL_LABEL,
    direction: signal ? signal.decision : '—',
    setup: signal ? signal.setup : '—',
    confidence: formatSignalConfidence(signal?.confidence),
    entry: formatSignalPrice(signal?.entry, decimals),
    stopLoss: formatSignalPrice(signal?.stopLoss, decimals),
    takeProfit: formatSignalPrice(signal?.takeProfit, decimals),
    riskReward: formatRiskReward(signal?.riskReward),
    symbolLine: `${input.displayName || input.symbolId}`,
    timeframe: input.timeframe,
    signalTime: formatEpochTimeUTC(signalEpoch),
    timezoneLabel: SIGNAL_TIMEZONE_LABEL,
    validityNote: HISTORICAL_SIGNAL_VALIDITY_NOTE,
    emptyNote: HISTORICAL_SIGNAL_EMPTY_NOTE,
  };
}

export function buildSignalView(input: SignalViewInput): SignalView {
  const { signal } = input;
  const hasClosedCandles = input.hasClosedCandles ?? false;
  const evaluatedAt = input.evaluatedAt ?? null;
  const decimals = input.decimals ?? 5;

  const rejectionReasons = signal?.rejectionReasons;
  const status = signalStatusLabel(hasClosedCandles, evaluatedAt, rejectionReasons);
  const decision = signal?.decision ?? 'NO_TRADE';
  const rejections = explainRejections(rejectionReasons);

  // Signal time is the confirming candle's epoch, never the evaluation wall
  // clock. Prefer an explicit override, then the engine's signalEpoch, then the
  // engine's timestamp (rejecting the 0 sentinel the engine uses for "none").
  const signalEpoch =
    input.signalEpoch !== undefined
      ? input.signalEpoch
      : signal?.signalEpoch !== undefined
        ? signal.signalEpoch
        : signal?.timestamp !== undefined && signal.timestamp > 0
          ? signal.timestamp
          : null;

  return {
    hasSignal: !!signal,
    decision: decision.replace('_', ' '),
    status,
    symbolLine: `${input.displayName || input.symbolId}`,
    timeframe: input.timeframe,
    marketBias: input.marketBias ?? '—',
    region: input.region ?? '—',
    direction: formatDirection(input.direction),
    confidence: formatSignalConfidence(signal?.confidence),
    setup: signal?.setup ?? '—',
    entry: formatSignalPrice(signal?.entry, decimals),
    stopLoss: formatSignalPrice(signal?.stopLoss, decimals),
    takeProfit: formatSignalPrice(signal?.takeProfit, decimals),
    riskReward: formatRiskReward(signal?.riskReward),
    rejections,
    reason:
      signal?.reason ?? defaultSignalReason(!!signal, hasClosedCandles, evaluatedAt),
    signalTime: formatEpochTimeUTC(signalEpoch),
    lastCandleTime: formatEpochTimeUTC(input.lastClosedCandleEpoch),
    evaluatedAt: formatSignalTime(evaluatedAt),
    timezoneLabel: SIGNAL_TIMEZONE_LABEL,
    feedLabel: input.feedLabel ?? '—',
  };
}