/**
 * Pure view-model helpers for the Signal Diagnostics panel.
 * Derives display strings only; no counters, no state mutation, no side effects.
 */

import { SignalRejectionCode } from '../signals/signal-engine';
import { Timeframe } from '../deriv/candles';
import { PairDiagnostics, formatDateTime, rejectionEntries } from '../signals/signal-diagnostics';

export interface SignalDiagnosticsViewRow {
  code: SignalRejectionCode;
  count: number;
}

export interface SignalDiagnosticsView {
  symbolId: string;
  timeframe: Timeframe | string;
  hasAnyEvaluations: boolean;
  hasSkippedMeasurement: boolean;
  completedEvaluations: string;
  longEmissions: string;
  shortEmissions: string;
  noTradeResults: string;
  duplicateRejections: string;
  totalRejectionCodes: string;
  skippedEvaluations: string;
  firstAt: string;
  lastAt: string;
  recentCount: string;
  rejectionsTop: SignalDiagnosticsViewRow[];
}

export interface SignalDiagnosticsViewInput {
  diagnostics: PairDiagnostics | null;
  symbolId: string;
  timeframe: Timeframe | string;
  showSkippedIfMeasured: boolean;
}

export function buildSignalDiagnosticsView(input: SignalDiagnosticsViewInput): SignalDiagnosticsView {
  const d = input.diagnostics;
  const tf = input.timeframe;
  const hasAny = d !== null && d.completedEvaluations > 0;
  const hasSkipped = input.showSkippedIfMeasured && d !== null && d.skippedEvaluations > 0;

  const rejectionsTop = d ? rejectionEntries(d.rejections).slice(0, 8) : [];

  return {
    symbolId: input.symbolId,
    timeframe: tf,
    hasAnyEvaluations: hasAny,
    hasSkippedMeasurement: hasSkipped,
    completedEvaluations: d ? String(d.completedEvaluations) : '—',
    longEmissions: d ? String(d.longEmissions) : '—',
    shortEmissions: d ? String(d.shortEmissions) : '—',
    noTradeResults: d ? String(d.noTradeResults) : '—',
    duplicateRejections: d ? String(d.rejections.duplicate) : '—',
    totalRejectionCodes: d ? String(d.rejections.total) : '—',
    skippedEvaluations: d ? String(d.skippedEvaluations) : '—',
    firstAt: formatDateTime(d?.firstEvaluatedAt ?? null),
    lastAt: formatDateTime(d?.lastEvaluatedAt ?? null),
    recentCount: d ? String(d.evaluationTimestamps.length) : '—',
    rejectionsTop,
  };
}

export function diagnosticsUnavailableText(): string {
  return 'Diagnostics unavailable for this metric.';
}
