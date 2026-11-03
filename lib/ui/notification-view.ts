/**
 * Pure notification view-model. Reuses the existing signal formatting helpers so
 * notification content stays consistent with the SignalPanel and never invents
 * prices, confidence, setups, or timestamps.
 */

import type { SignalOutput } from '../signals/signal-engine';
import {
  formatSignalPrice,
  formatSignalConfidence,
  formatRiskReward,
  formatEpochTimeUTC,
  SIGNAL_TIMEZONE_LABEL,
  HISTORICAL_SIGNAL_VALIDITY_NOTE,
} from './signal-view';

/**
 * Explicit label so a generated signal is never presented as a currently valid
 * trade. The strategy has no rule establishing ongoing validity.
 */
export const NEW_SIGNAL_LABEL = 'NEWLY GENERATED SIGNAL';

export interface NotificationViewInput {
  signal: SignalOutput;
  symbolId: string;
  displayName?: string;
  timeframe: string;
  decimals?: number;
}

export interface NotificationView {
  label: string;
  /** Short title suitable for a desktop notification. */
  title: string;
  /** One-line detail summary suitable for a desktop notification body. */
  body: string;
  direction: string;
  symbolLine: string;
  timeframe: string;
  setup: string;
  confidence: string;
  entry: string;
  stopLoss: string;
  takeProfit: string;
  riskReward: string;
  signalTime: string;
  timezoneLabel: string;
  validityNote: string;
}

export function buildNotificationView(input: NotificationViewInput): NotificationView {
  const { signal } = input;
  const decimals = input.decimals ?? 5;
  const symbolLine = input.displayName || input.symbolId;
  const timeframe = String(input.timeframe);

  const signalEpoch =
    signal.signalEpoch !== undefined
      ? signal.signalEpoch
      : signal.timestamp > 0
        ? signal.timestamp
        : null;

  const direction = signal.decision;
  const confidence = formatSignalConfidence(signal.confidence);
  const entry = formatSignalPrice(signal.entry, decimals);
  const stopLoss = formatSignalPrice(signal.stopLoss, decimals);
  const takeProfit = formatSignalPrice(signal.takeProfit, decimals);
  const riskReward = formatRiskReward(signal.riskReward);
  const signalTime = formatEpochTimeUTC(signalEpoch);

  const title = `New ${direction} signal — ${symbolLine} · ${timeframe.toUpperCase()}`;
  const body =
    `Entry ${entry} · SL ${stopLoss} · TP ${takeProfit} · R:R ${riskReward}` +
    ` · Confidence ${confidence} · Signal time ${signalTime} UTC`;

  return {
    label: NEW_SIGNAL_LABEL,
    title,
    body,
    direction,
    symbolLine,
    timeframe,
    setup: signal.setup,
    confidence,
    entry,
    stopLoss,
    takeProfit,
    riskReward,
    signalTime,
    timezoneLabel: SIGNAL_TIMEZONE_LABEL,
    validityNote: HISTORICAL_SIGNAL_VALIDITY_NOTE,
  };
}
