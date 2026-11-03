/**
 * Signal Diagnostics (read-only, in-memory statistics).
 *
 * Measures how the signal engine behaves without changing strategy, risk, or
 * evaluation order. Diagnostics are aggregated counters per symbol:timeframe.
 * They are NOT persisted to localStorage, databases, APIs, or analytics.
 */

import { Timeframe } from '../deriv/candles';
import { SignalOutput, SignalRejectionCode } from './signal-engine';
import { signalPairKey } from './signal-history';

export type EvaluationOutcome = 'LONG' | 'SHORT' | 'NO_TRADE';

export interface RejectionCounts {
  readonly codes: Partial<Record<SignalRejectionCode, number>>;
  readonly total: number;
  readonly duplicate: number;
}

export interface PairDiagnostics {
  readonly pairKey: string;
  readonly symbolId: string;
  readonly timeframe: Timeframe;
  readonly completedEvaluations: number;
  readonly longEmissions: number;
  readonly shortEmissions: number;
  readonly noTradeResults: number;
  readonly rejections: RejectionCounts;
  readonly firstEvaluatedAt: Date | null;
  readonly lastEvaluatedAt: Date | null;
  readonly evaluationTimestamps: readonly number[];
  readonly skippedEvaluations: number;
}

export interface SignalDiagnosticsStore {
  readonly pairs: Map<string, PairDiagnostics>;
  readonly maxRecentTimestamps: number;
}

export interface IncrementCompletedArgs {
  symbolId: string;
  timeframe: Timeframe;
  signal: SignalOutput;
  evaluatedAt: Date;
  skipped?: boolean;
}

const DEFAULT_MAX_RECENT_TIMESTAMPS = 32;

function nowEpochMs(d: Date): number {
  return d.getTime();
}

function createEmptyRejections(): RejectionCounts {
  return { codes: {}, total: 0, duplicate: 0 };
}

function clonePair(base: PairDiagnostics, updates: Partial<PairDiagnostics>): PairDiagnostics {
  return {
    ...base,
    ...updates,
    rejections: updates.rejections ? { ...updates.rejections, codes: { ...updates.rejections.codes } } : base.rejections,
  };
}

function pushTimestamp(list: readonly number[], ts: number, max: number): readonly number[] {
  if (max <= 0) return [];
  const next = [...list, ts];
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

function computeRejections(signal: SignalOutput): RejectionCounts {
  const codes: Partial<Record<SignalRejectionCode, number>> = {};
  let total = 0;
  let duplicate = 0;
  const reasons = signal.rejectionReasons ?? [];
  for (const r of reasons) {
    total += 1;
    if (r === 'DUPLICATE') duplicate += 1;
    codes[r] = (codes[r] ?? 0) + 1;
  }
  return { codes, total, duplicate };
}

export class SignalDiagnostics {
  private store: SignalDiagnosticsStore;

  constructor(maxRecentTimestamps = DEFAULT_MAX_RECENT_TIMESTAMPS) {
    this.store = {
      pairs: new Map<string, PairDiagnostics>(),
      maxRecentTimestamps: maxRecentTimestamps > 0 ? Math.floor(maxRecentTimestamps) : 0,
    };
  }

  private getOrCreatePair(symbolId: string, timeframe: Timeframe): PairDiagnostics {
    const key = signalPairKey(symbolId, timeframe);
    const existing = this.store.pairs.get(key);
    if (existing) return existing;
    const created: PairDiagnostics = {
      pairKey: key,
      symbolId,
      timeframe,
      completedEvaluations: 0,
      longEmissions: 0,
      shortEmissions: 0,
      noTradeResults: 0,
      rejections: createEmptyRejections(),
      firstEvaluatedAt: null,
      lastEvaluatedAt: null,
      evaluationTimestamps: [],
      skippedEvaluations: 0,
    };
    this.store.pairs.set(key, created);
    return created;
  }

  incrementCompletedEvaluation(args: IncrementCompletedArgs): void {
    const { symbolId, timeframe, signal, evaluatedAt, skipped = false } = args;
    const pair = this.getOrCreatePair(symbolId, timeframe);
    const ts = nowEpochMs(evaluatedAt);
    const rejections = computeRejections(signal);
    const isLong = signal.decision === 'LONG';
    const isShort = signal.decision === 'SHORT';

    const next: PairDiagnostics = clonePair(pair, {
      completedEvaluations: skipped ? pair.completedEvaluations : pair.completedEvaluations + 1,
      longEmissions: isLong && !skipped ? pair.longEmissions + 1 : pair.longEmissions,
      shortEmissions: isShort && !skipped ? pair.shortEmissions + 1 : pair.shortEmissions,
      noTradeResults: (!isLong && !isShort) && !skipped ? pair.noTradeResults + 1 : pair.noTradeResults,
      rejections: skipped ? pair.rejections : rejections,
      firstEvaluatedAt: pair.firstEvaluatedAt ? pair.firstEvaluatedAt : new Date(evaluatedAt),
      lastEvaluatedAt: new Date(evaluatedAt),
      evaluationTimestamps: skipped
        ? pair.evaluationTimestamps
        : pushTimestamp(pair.evaluationTimestamps, ts, this.store.maxRecentTimestamps),
      skippedEvaluations: skipped ? pair.skippedEvaluations + 1 : pair.skippedEvaluations,
    });

    const key = signalPairKey(symbolId, timeframe);
    this.store.pairs.set(key, next);
  }

  incrementSkippedEvaluation(symbolId: string, timeframe: Timeframe, evaluatedAt?: Date): void {
    const pair = this.getOrCreatePair(symbolId, timeframe);
    const at = evaluatedAt ?? new Date();
    const ts = nowEpochMs(at);
    const next: PairDiagnostics = clonePair(pair, {
      firstEvaluatedAt: pair.firstEvaluatedAt ? pair.firstEvaluatedAt : new Date(at),
      lastEvaluatedAt: new Date(at),
      evaluationTimestamps: pushTimestamp(pair.evaluationTimestamps, ts, this.store.maxRecentTimestamps),
      skippedEvaluations: pair.skippedEvaluations + 1,
    });
    this.store.pairs.set(signalPairKey(symbolId, timeframe), next);
  }

  getPairDiagnostics(symbolId: string, timeframe: Timeframe): PairDiagnostics {
    return this.getOrCreatePair(symbolId, timeframe);
  }

  getAllPairs(): PairDiagnostics[] {
    return Array.from(this.store.pairs.values());
  }

  resetAll(): void {
    this.store.pairs.clear();
  }

  resetPair(symbolId: string, timeframe: Timeframe): void {
    this.store.pairs.delete(signalPairKey(symbolId, timeframe));
  }

  getMaxRecentTimestamps(): number {
    return this.store.maxRecentTimestamps;
  }
}

export function formatDateTime(d: Date | null): string {
  if (!d) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function rejectionEntries(rejections: RejectionCounts): Array<{ code: SignalRejectionCode; count: number }> {
  const out = Object.entries(rejections.codes) as Array<[SignalRejectionCode, number]>;
  out.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return out.map(([code, count]) => ({ code, count }));
}
