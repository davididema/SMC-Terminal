/**
 * Offline broker comparison harness (Phase 6).
 *
 * Read-only, network-free utilities that compare genuinely exported candle data
 * from two sources (for example a HFM/MT5 history export and a Deriv reference
 * export). The harness parses caller-supplied CSV text, validates it, and reports
 * observed differences.
 *
 * Guarantees:
 * - Performs NO network access and opens NO WebSocket.
 * - Fabricates NO candles. It only consumes text the caller supplies.
 * - Does NOT modify the live Deriv pipeline nor any SMC/signal logic.
 * - Preserves source timestamps exactly; never silently assumes a timezone.
 * - Never declares a PASS for the HFM side unless genuine HFM data was supplied
 *   and the configured criteria were actually met.
 */

import type { Candle, Timeframe } from '../lib/deriv/candles';
import { TIMEFRAMES } from '../lib/deriv/candles';
import { getSymbolConfig } from '../lib/deriv/symbols';
import { SMCEngine } from '../lib/analysis/smc';
import type { SMCAnalysisResult } from '../lib/analysis/smc';
import { SignalEngine } from '../lib/signals/signal-engine';
import { MIN_ANALYSIS_HISTORY } from './verification-lib';

export const COMPARISON_SCHEMA_VERSION = '1.0.0';

export const CSV_COLUMNS = [
  'symbol',
  'timeframe',
  'timestamp',
  'open',
  'high',
  'low',
  'close',
] as const;

export const DEFAULT_MIN_SAMPLES_FOR_DISTRIBUTION = 20;

export const PRICE_DIFFERENCE_FIELDS = ['open', 'high', 'low', 'close', 'range'] as const;
export type PriceField = (typeof PRICE_DIFFERENCE_FIELDS)[number];

const MAX_REPORTED_ISSUES = 200;
const SMC_SAMPLE_CAP = 50;

// ---------------------------------------------------------------------------
// Status vocabulary (shared with the verification phase)
// ---------------------------------------------------------------------------

/**
 * PASS       - the specific check ran and met its explicitly configured criteria.
 * FAIL       - the specific check ran and violated its configured criteria.
 * UNRESOLVED - the check could not reach a verdict because required information
 *              (e.g. a timestamp convention or a configured tolerance) is missing.
 * NOT_RUN    - the check could not run at all (e.g. the HFM dataset was absent).
 *
 * A missing HFM dataset can only ever yield NOT_RUN or UNRESOLVED, never PASS.
 */
export type ComparisonStatus = 'PASS' | 'FAIL' | 'UNRESOLVED' | 'NOT_RUN';

// ---------------------------------------------------------------------------
// Timeframe helpers (reuse application conventions, accept common MT5 aliases)
// ---------------------------------------------------------------------------

const TIMEFRAME_ALIASES: Record<string, Timeframe> = {
  m1: '1m',
  '1m': '1m',
  m5: '5m',
  '5m': '5m',
  m15: '15m',
  '15m': '15m',
  m30: '30m',
  '30m': '30m',
  h1: '1H',
  '1h': '1H',
  h4: '4H',
  '4h': '4H',
  d1: '1D',
  '1d': '1D',
};

/**
 * Normalise a timeframe token to the application's canonical `Timeframe` value.
 * Accepts the canonical values (`'15m'`, `'1H'`, ...) plus common MT5 aliases
 * (`M15`, `H1`, `D1`). Returns null when unrecognised - never guesses.
 */
export function normalizeTimeframe(value: string): Timeframe | null {
  const key = value.trim().toLowerCase();
  const resolved = TIMEFRAME_ALIASES[key];
  if (resolved !== undefined) return resolved;
  return null;
}

// ---------------------------------------------------------------------------
// Timestamp conventions
// ---------------------------------------------------------------------------

export type TimestampConvention =
  | { kind: 'utc' }
  | { kind: 'server-time'; offsetSeconds: number; description: string }
  | { kind: 'unknown' };

export function describeConvention(convention: TimestampConvention): string {
  switch (convention.kind) {
    case 'utc':
      return 'UTC (Unix seconds, explicit)';
    case 'server-time':
      return `broker server time, offset ${convention.offsetSeconds}s (${convention.description})`;
    case 'unknown':
      return 'UNKNOWN (no documented interpretation supplied)';
  }
}

/** Offset in seconds applied to convert a source timestamp into UTC. Null when unknown. */
export function conventionOffsetSeconds(convention: TimestampConvention): number | null {
  if (convention.kind === 'utc') return 0;
  if (convention.kind === 'server-time') return convention.offsetSeconds;
  return null;
}

/**
 * Parse an explicit timestamp convention from a CLI token. Bare `server` is
 * intentionally rejected: an offset must be documented, otherwise use `unknown`.
 */
export function parseConventionArg(value: string): TimestampConvention {
  const v = value.trim().toLowerCase();
  if (v === 'utc') return { kind: 'utc' };
  if (v === 'unknown') return { kind: 'unknown' };
  const match = /^server:(-?\d+)$/.exec(v);
  if (match) {
    const offsetSeconds = Number(match[1]);
    return {
      kind: 'server-time',
      offsetSeconds,
      description: `server time = UTC + ${offsetSeconds}s (documented)`,
    };
  }
  throw new Error(
    `Unrecognised timestamp convention "${value}". Use "utc", "server:<offsetSeconds>", or "unknown".`
  );
}

export function normalizeEpoch(raw: number, convention: TimestampConvention): number | null {
  const offset = conventionOffsetSeconds(convention);
  if (offset === null) return null;
  return raw - offset;
}

// ---------------------------------------------------------------------------
// Imported candle model
// ---------------------------------------------------------------------------

export interface ImportedCandle {
  symbol: string;
  timeframe: Timeframe;
  /** Source timestamp exactly as supplied (string), preserved verbatim. */
  sourceTimestamp: string;
  /** Numeric source timestamp before any documented conversion. */
  rawTimestamp: number;
  /** UTC epoch after applying the documented convention; null when unresolved. */
  normalizedEpoch: number | null;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface RowIssue {
  line: number;
  code: string;
  message: string;
  raw: string;
}

export interface DatasetSummary {
  sourceLabel: string;
  path?: string;
  symbol: string | null;
  timeframe: Timeframe | null;
  timestampConvention: TimestampConvention;
  totalRows: number;
  validCandles: number;
  invalidRows: number;
  duplicateRows: number;
  outOfOrder: boolean;
  closureVerified: boolean;
  closureNote: string;
  issues: RowIssue[];
  issueCodeCounts: Record<string, number>;
  candles: ImportedCandle[];
}

export interface ParseCsvOptions {
  sourceLabel: string;
  convention: TimestampConvention;
  path?: string;
}

const CLOSURE_NOTE =
  'CSV carries no closed/forming flag. Every row is treated as an exported, completed ' +
  'bar (standard for MT5 history exports). If a provider includes the current forming bar, ' +
  'results may be affected - this cannot be detected from the file.';

function recordIssue(
  summary: DatasetSummary,
  line: number,
  code: string,
  message: string,
  raw: string
): void {
  summary.issueCodeCounts[code] = (summary.issueCodeCounts[code] ?? 0) + 1;
  if (summary.issues.length < MAX_REPORTED_ISSUES) {
    summary.issues.push({ line, code, message, raw: raw.slice(0, 120) });
  }
}

function pushIssue(
  summary: DatasetSummary,
  line: number,
  code: string,
  message: string,
  raw: string
): void {
  summary.invalidRows += 1;
  recordIssue(summary, line, code, message, raw);
}

function parseFiniteNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function parseIntegerString(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

// ---------------------------------------------------------------------------
// CSV parsing + validation
// ---------------------------------------------------------------------------

/**
 * Parse and validate CSV text against the fixed schema:
 *   symbol,timeframe,timestamp,open,high,low,close
 *
 * Invalid rows are rejected (never repaired) and reported. Duplicate timestamps
 * are rejected and counted. Out-of-order rows are flagged but retained, because
 * ordering is not a data-value defect.
 */
export function parseCsvText(text: string, options: ParseCsvOptions): DatasetSummary {
  const summary: DatasetSummary = {
    sourceLabel: options.sourceLabel,
    path: options.path,
    symbol: null,
    timeframe: null,
    timestampConvention: options.convention,
    totalRows: 0,
    validCandles: 0,
    invalidRows: 0,
    duplicateRows: 0,
    outOfOrder: false,
    closureVerified: false,
    closureNote: CLOSURE_NOTE,
    issues: [],
    issueCodeCounts: {},
    candles: [],
  };

  const lines = text.split(/\r\n|\r|\n/);

  let firstDataIndex = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    const cells = lines[i].split(',').map((c) => c.trim().toLowerCase());
    if (cells[0] === 'symbol') {
      const matchesSchema =
        cells.length === CSV_COLUMNS.length &&
        CSV_COLUMNS.every((column, index) => cells[index] === column);
      if (!matchesSchema) {
        recordIssue(
          summary,
          i + 1,
          'HEADER_COLUMNS_UNEXPECTED',
          `Header does not match the expected columns (${CSV_COLUMNS.join(',')}); fixed column order is assumed.`,
          lines[i]
        );
      }
      firstDataIndex = i + 1;
    } else {
      firstDataIndex = i;
    }
    break;
  }

  const seenTimestamps = new Set<number>();
  let previousRaw: number | null = null;

  for (let i = firstDataIndex; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    summary.totalRows += 1;
    const lineNumber = i + 1;

    const fields = line.split(',');
    if (fields.length !== CSV_COLUMNS.length) {
      pushIssue(
        summary,
        lineNumber,
        'INVALID_COLUMN_COUNT',
        `Expected ${CSV_COLUMNS.length} columns, found ${fields.length}.`,
        line
      );
      continue;
    }

    const [symbolRaw, timeframeRaw, timestampRaw, openRaw, highRaw, lowRaw, closeRaw] = fields;

    const symbol = symbolRaw.trim();
    if (symbol === '' || getSymbolConfig(symbol) === undefined) {
      pushIssue(summary, lineNumber, 'SYMBOL_UNSUPPORTED', `Unsupported or empty symbol "${symbol}".`, line);
      continue;
    }

    const timeframe = normalizeTimeframe(timeframeRaw);
    if (timeframe === null) {
      pushIssue(
        summary,
        lineNumber,
        'TIMEFRAME_UNSUPPORTED',
        `Unsupported timeframe "${timeframeRaw.trim()}". Expected one of ${TIMEFRAMES.join(', ')}.`,
        line
      );
      continue;
    }

    const rawTimestamp = parseIntegerString(timestampRaw);
    if (rawTimestamp === null || rawTimestamp <= 0) {
      pushIssue(summary, lineNumber, 'TIMESTAMP_INVALID', `Invalid timestamp "${timestampRaw.trim()}".`, line);
      continue;
    }

    const open = parseFiniteNumber(openRaw);
    const high = parseFiniteNumber(highRaw);
    const low = parseFiniteNumber(lowRaw);
    const close = parseFiniteNumber(closeRaw);
    if (open === null || high === null || low === null || close === null) {
      pushIssue(summary, lineNumber, 'OHLC_NON_FINITE', 'OHLC contains a non-numeric or non-finite value.', line);
      continue;
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      pushIssue(summary, lineNumber, 'OHLC_NON_POSITIVE', 'OHLC prices must be positive.', line);
      continue;
    }
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      pushIssue(summary, lineNumber, 'OHLC_INVALID', 'OHLC violates high>=low and high/low envelope constraints.', line);
      continue;
    }

    if (summary.symbol === null) {
      summary.symbol = symbol;
      summary.timeframe = timeframe;
    } else if (symbol !== summary.symbol) {
      pushIssue(summary, lineNumber, 'SYMBOL_MISMATCH', `Row symbol "${symbol}" differs from dataset symbol "${summary.symbol}".`, line);
      continue;
    } else if (timeframe !== summary.timeframe) {
      pushIssue(summary, lineNumber, 'TIMEFRAME_MISMATCH', `Row timeframe "${timeframe}" differs from dataset timeframe "${summary.timeframe}".`, line);
      continue;
    }

    if (seenTimestamps.has(rawTimestamp)) {
      summary.duplicateRows += 1;
      summary.issueCodeCounts.DUPLICATE_TIMESTAMP = (summary.issueCodeCounts.DUPLICATE_TIMESTAMP ?? 0) + 1;
      if (summary.issues.length < MAX_REPORTED_ISSUES) {
        summary.issues.push({
          line: lineNumber,
          code: 'DUPLICATE_TIMESTAMP',
          message: `Duplicate timestamp ${rawTimestamp}; duplicate rejected.`,
          raw: line.slice(0, 120),
        });
      }
      continue;
    }
    seenTimestamps.add(rawTimestamp);

    if (previousRaw !== null && rawTimestamp <= previousRaw) {
      summary.outOfOrder = true;
    }
    previousRaw = rawTimestamp;

    summary.candles.push({
      symbol,
      timeframe,
      sourceTimestamp: timestampRaw.trim(),
      rawTimestamp,
      normalizedEpoch: normalizeEpoch(rawTimestamp, options.convention),
      open,
      high,
      low,
      close,
    });
  }

  summary.validCandles = summary.candles.length;
  return summary;
}

// ---------------------------------------------------------------------------
// Distribution statistics
// ---------------------------------------------------------------------------

export interface DistributionStats {
  count: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Linear-interpolation percentile over an already ascending-sorted array. */
export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return NaN;
  if (sortedAscending.length === 1) return sortedAscending[0];
  const rank = (p / 100) * (sortedAscending.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAscending[lower];
  const fraction = rank - lower;
  return sortedAscending[lower] * (1 - fraction) + sortedAscending[upper] * fraction;
}

export function computeDistribution(values: number[]): DistributionStats {
  if (values.length === 0) {
    return { count: 0, min: NaN, p25: NaN, median: NaN, p75: NaN, p95: NaN, p99: NaN, max: NaN, mean: NaN };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    p25: percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

// ---------------------------------------------------------------------------
// Coverage + OHLC differences
// ---------------------------------------------------------------------------

export interface MatchedPair {
  epoch: number;
  deriv: ImportedCandle;
  hfm: ImportedCandle;
}

export interface CoverageReport {
  derivCandles: number;
  hfmCandles: number;
  matched: number;
  onlyInDeriv: number;
  onlyInHfm: number;
}

function indexByEpoch(candles: ImportedCandle[]): Map<number, ImportedCandle> {
  const map = new Map<number, ImportedCandle>();
  for (const candle of candles) {
    if (candle.normalizedEpoch === null) continue;
    if (!map.has(candle.normalizedEpoch)) map.set(candle.normalizedEpoch, candle);
  }
  return map;
}

export function computeCoverage(deriv: ImportedCandle[], hfm: ImportedCandle[]): {
  coverage: CoverageReport;
  pairs: MatchedPair[];
} {
  const derivMap = indexByEpoch(deriv);
  const hfmMap = indexByEpoch(hfm);
  const pairs: MatchedPair[] = [];
  for (const [epoch, derivCandle] of derivMap) {
    const hfmCandle = hfmMap.get(epoch);
    if (hfmCandle !== undefined) pairs.push({ epoch, deriv: derivCandle, hfm: hfmCandle });
  }
  pairs.sort((a, b) => a.epoch - b.epoch);
  const coverage: CoverageReport = {
    derivCandles: derivMap.size,
    hfmCandles: hfmMap.size,
    matched: pairs.length,
    onlyInDeriv: derivMap.size - pairs.length,
    onlyInHfm: hfmMap.size - pairs.length,
  };
  return { coverage, pairs };
}

export interface FieldDifference {
  field: PriceField;
  count: number;
  maxAbs: number;
  stats: DistributionStats;
}

export interface OhlcDifferenceReport {
  minSamplesForDistribution: number;
  sufficient: boolean;
  fields: Record<PriceField, FieldDifference>;
}

function fieldValue(candle: ImportedCandle, field: PriceField): number {
  switch (field) {
    case 'open':
      return candle.open;
    case 'high':
      return candle.high;
    case 'low':
      return candle.low;
    case 'close':
      return candle.close;
    case 'range':
      return candle.high - candle.low;
  }
}

export function buildOhlcDifferences(
  pairs: MatchedPair[],
  minSamplesForDistribution: number
): OhlcDifferenceReport {
  const fields = {} as Record<PriceField, FieldDifference>;
  for (const field of PRICE_DIFFERENCE_FIELDS) {
    const diffs = pairs.map((pair) =>
      Math.abs(fieldValue(pair.deriv, field) - fieldValue(pair.hfm, field))
    );
    let maxAbs = NaN;
    for (const diff of diffs) {
      maxAbs = Number.isNaN(maxAbs) ? diff : Math.max(maxAbs, diff);
    }
    fields[field] = {
      field,
      count: diffs.length,
      maxAbs,
      stats: computeDistribution(diffs),
    };
  }
  return {
    minSamplesForDistribution,
    sufficient: pairs.length >= minSamplesForDistribution,
    fields,
  };
}

// ---------------------------------------------------------------------------
// Tolerance check
// ---------------------------------------------------------------------------

export interface ToleranceCheck {
  configured: number | null;
  status: ComparisonStatus;
  exceedances: number;
  maxAbsDifference: number;
}

export function evaluateTolerance(
  pairs: MatchedPair[],
  tolerance: number | null
): ToleranceCheck {
  let maxAbsDifference = NaN;
  let exceedances = 0;
  for (const pair of pairs) {
    let worst = 0;
    for (const field of PRICE_DIFFERENCE_FIELDS) {
      worst = Math.max(worst, Math.abs(fieldValue(pair.deriv, field) - fieldValue(pair.hfm, field)));
    }
    maxAbsDifference = Number.isNaN(maxAbsDifference) ? worst : Math.max(maxAbsDifference, worst);
    if (tolerance !== null && worst > tolerance) exceedances += 1;
  }
  if (tolerance === null) {
    return { configured: null, status: 'NOT_RUN', exceedances: 0, maxAbsDifference };
  }
  if (pairs.length === 0) {
    return { configured: tolerance, status: 'NOT_RUN', exceedances: 0, maxAbsDifference };
  }
  return { configured: tolerance, status: exceedances > 0 ? 'FAIL' : 'PASS', exceedances, maxAbsDifference };
}

// ---------------------------------------------------------------------------
// Timestamp alignment
// ---------------------------------------------------------------------------

export interface AlignmentReport {
  status: ComparisonStatus;
  derivConvention: TimestampConvention;
  hfmConvention: TimestampConvention;
  derivOffsetSeconds: number | null;
  hfmOffsetSeconds: number | null;
  note: string;
}

export function evaluateAlignment(
  derivConvention: TimestampConvention,
  hfmConvention: TimestampConvention,
  matched: number
): AlignmentReport {
  const derivOffsetSeconds = conventionOffsetSeconds(derivConvention);
  const hfmOffsetSeconds = conventionOffsetSeconds(hfmConvention);
  const base = { derivConvention, hfmConvention, derivOffsetSeconds, hfmOffsetSeconds };

  if (derivOffsetSeconds === null || hfmOffsetSeconds === null) {
    return {
      ...base,
      status: 'UNRESOLVED',
      note: 'At least one dataset has no documented timestamp interpretation; timestamps cannot be aligned without guessing.',
    };
  }
  if (matched === 0) {
    return {
      ...base,
      status: 'FAIL',
      note: 'Both conventions are documented but no timestamps overlap.',
    };
  }
  return {
    ...base,
    status: 'PASS',
    note: 'Both conventions documented; timestamps align without any inferred offset.',
  };
}

export interface SuggestedAlignment {
  offsetSeconds: number;
  overlap: number;
  applied: false;
  note: string;
}

/**
 * Diagnostic only. Searches whole-hour candidate offsets to find which documented
 * server offset would maximise timestamp overlap. This is an INFERENCE and is
 * never applied automatically - it may suggest a convention to document.
 */
export function suggestAlignmentOffset(
  deriv: ImportedCandle[],
  hfm: ImportedCandle[],
  candidateOffsets: number[] = defaultCandidateOffsets()
): SuggestedAlignment | null {
  const derivEpochs = new Set<number>();
  for (const candle of deriv) {
    if (candle.normalizedEpoch !== null) derivEpochs.add(candle.normalizedEpoch);
  }
  if (derivEpochs.size === 0) return null;

  let best: { offsetSeconds: number; overlap: number } | null = null;
  for (const offsetSeconds of candidateOffsets) {
    let overlap = 0;
    for (const candle of hfm) {
      if (candle.normalizedEpoch === null) continue;
      if (derivEpochs.has(candle.normalizedEpoch - offsetSeconds)) overlap += 1;
    }
    if (best === null || overlap > best.overlap) best = { offsetSeconds, overlap };
  }
  if (best === null || best.overlap === 0) {
    return {
      offsetSeconds: 0,
      overlap: 0,
      applied: false,
      note: 'No candidate offset produced any timestamp overlap. This is a timestamp-only inference and was NOT applied.',
    };
  }
  return {
    offsetSeconds: best.offsetSeconds,
    overlap: best.overlap,
    applied: false,
    note: `Best timestamp-only overlap (${best.overlap} candles) at an hfm offset of ${best.offsetSeconds}s. Reported as an INFERENCE only and NOT applied.`,
  };
}

function defaultCandidateOffsets(): number[] {
  const offsets: number[] = [];
  for (let hours = -12; hours <= 14; hours += 1) offsets.push(hours * 3600);
  return offsets;
}

// ---------------------------------------------------------------------------
// SMC comparison
// ---------------------------------------------------------------------------

interface SmcEvent {
  key: string;
  price: number;
}

export interface SmcEventRow {
  key: string;
  deriv: number | null;
  hfm: number | null;
  diff: number | null;
}

export interface SmcCategoryComparison {
  category: string;
  derivCount: number;
  hfmCount: number;
  matched: number;
  onlyInDeriv: number;
  onlyInHfm: number;
  differingCount: number;
  exceedingTolerance: number;
  maxAbsPriceDiff: number;
  samples: SmcEventRow[];
}

export interface SmcComparisonReport {
  status: ComparisonStatus;
  reason: string;
  derivZone: string | null;
  hfmZone: string | null;
  zoneMatch: boolean | null;
  derivDecision: string | null;
  hfmDecision: string | null;
  decisionMatch: boolean | null;
  structureMatchTolerance: number | null;
  categories: SmcCategoryComparison[];
}

export interface AnalyzedSide {
  analysis: SMCAnalysisResult;
  decision: string;
  lastCandle: Candle;
}

/**
 * Build the candle array fed to the SMC engine. Uses normalised epochs so both
 * sides share one timeline. Returns null when a side cannot be aligned or has
 * too little history to analyse.
 */
export function buildAnalyzableCandles(summary: DatasetSummary): Candle[] | null {
  if (summary.symbol === null || summary.timeframe === null) return null;
  if (summary.candles.length < MIN_ANALYSIS_HISTORY) return null;
  const candles: Candle[] = [];
  for (const candle of summary.candles) {
    if (candle.normalizedEpoch === null) return null;
    candles.push({
      epoch: candle.normalizedEpoch,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: 0,
      isClosed: true,
    });
  }
  candles.sort((a, b) => a.epoch - b.epoch);
  return candles;
}

export function analyzeSide(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[]
): AnalyzedSide {
  const analysis = new SMCEngine().analyze(symbol, timeframe, candles);
  const lastCandle = candles[candles.length - 1];
  const decision = new SignalEngine().evaluate(analysis, { lastClosedCandle: lastCandle }).decision;
  return { analysis, decision, lastCandle };
}

function swingsOf(side: AnalyzedSide): SmcEvent[] {
  return side.analysis.marketStructure.swings.map((swing) => ({
    key: `${swing.type}:${swing.swingCandleEpoch}`,
    price: swing.price,
  }));
}

function breaksOf(side: AnalyzedSide): SmcEvent[] {
  return side.analysis.marketStructure.breaks.map((brk) => ({
    key: `${brk.type}:${brk.breakCandleEpoch}`,
    price: brk.brokenPrice,
  }));
}

function liquidityOf(side: AnalyzedSide): SmcEvent[] {
  const levels = [
    ...side.analysis.liquidity.buySideLiquidity,
    ...side.analysis.liquidity.sellSideLiquidity,
  ];
  return levels.map((level) => ({ key: `${level.type}:${level.epoch}`, price: level.price }));
}

function fvgsOf(side: AnalyzedSide): SmcEvent[] {
  const gaps = [...side.analysis.fvg.bullishFVGs, ...side.analysis.fvg.bearishFVGs];
  return gaps.map((gap) => ({ key: `${gap.type}:${gap.epoch}`, price: gap.topPrice }));
}

function orderBlocksOf(side: AnalyzedSide): SmcEvent[] {
  const blocks = [
    ...side.analysis.orderBlocks.bullishOrderBlocks,
    ...side.analysis.orderBlocks.bearishOrderBlocks,
  ];
  return blocks.map((block) => ({ key: `${block.type}:${block.epoch}`, price: block.high }));
}

function compareCategory(
  category: string,
  derivEvents: SmcEvent[],
  hfmEvents: SmcEvent[],
  tolerance: number | null
): SmcCategoryComparison {
  const derivMap = new Map<string, number>();
  for (const event of derivEvents) derivMap.set(event.key, event.price);
  const hfmMap = new Map<string, number>();
  for (const event of hfmEvents) hfmMap.set(event.key, event.price);

  const samples: SmcEventRow[] = [];
  let matched = 0;
  let differingCount = 0;
  let exceedingTolerance = 0;
  let maxAbsPriceDiff = NaN;

  for (const [key, derivPrice] of derivMap) {
    const hfmPrice = hfmMap.get(key);
    if (hfmPrice === undefined) {
      if (samples.length < SMC_SAMPLE_CAP) samples.push({ key, deriv: derivPrice, hfm: null, diff: null });
      continue;
    }
    matched += 1;
    const diff = Math.abs(derivPrice - hfmPrice);
    maxAbsPriceDiff = Number.isNaN(maxAbsPriceDiff) ? diff : Math.max(maxAbsPriceDiff, diff);
    if (diff > 0) differingCount += 1;
    if (tolerance !== null && diff > tolerance) exceedingTolerance += 1;
    if (diff > 0 && samples.length < SMC_SAMPLE_CAP) samples.push({ key, deriv: derivPrice, hfm: hfmPrice, diff });
  }
  for (const [key, hfmPrice] of hfmMap) {
    if (!derivMap.has(key) && samples.length < SMC_SAMPLE_CAP) {
      samples.push({ key, deriv: null, hfm: hfmPrice, diff: null });
    }
  }

  return {
    category,
    derivCount: derivMap.size,
    hfmCount: hfmMap.size,
    matched,
    onlyInDeriv: derivMap.size - matched,
    onlyInHfm: hfmMap.size - matched,
    differingCount,
    exceedingTolerance,
    maxAbsPriceDiff,
    samples,
  };
}

function emptySmcReport(status: ComparisonStatus, reason: string): SmcComparisonReport {
  return {
    status,
    reason,
    derivZone: null,
    hfmZone: null,
    zoneMatch: null,
    derivDecision: null,
    hfmDecision: null,
    decisionMatch: null,
    structureMatchTolerance: null,
    categories: [],
  };
}

export function compareSmc(
  derivSide: AnalyzedSide | null,
  hfmSide: AnalyzedSide | null,
  structureMatchTolerance: number | null,
  unusableReason: string | null
): SmcComparisonReport {
  if (derivSide === null || hfmSide === null) {
    return emptySmcReport('NOT_RUN', unusableReason ?? 'One dataset could not be analysed.');
  }

  const categories = [
    compareCategory('swings', swingsOf(derivSide), swingsOf(hfmSide), structureMatchTolerance),
    compareCategory('breaks', breaksOf(derivSide), breaksOf(hfmSide), structureMatchTolerance),
    compareCategory('liquidity', liquidityOf(derivSide), liquidityOf(hfmSide), structureMatchTolerance),
    compareCategory('fvgs', fvgsOf(derivSide), fvgsOf(hfmSide), structureMatchTolerance),
    compareCategory('orderBlocks', orderBlocksOf(derivSide), orderBlocksOf(hfmSide), structureMatchTolerance),
  ];

  const zoneMatch = derivSide.analysis.zone === hfmSide.analysis.zone;
  const decisionMatch = derivSide.decision === hfmSide.decision;

  let status: ComparisonStatus;
  let reason: string;
  if (structureMatchTolerance === null) {
    status = 'UNRESOLVED';
    reason = 'SMC comparison executed but no structure-match tolerance was configured; results are informational only.';
  } else {
    const hasMissing = categories.some((c) => c.onlyInDeriv > 0 || c.onlyInHfm > 0);
    const hasExceeding = categories.some((c) => c.exceedingTolerance > 0);
    const failed = hasMissing || hasExceeding || !zoneMatch || !decisionMatch;
    status = failed ? 'FAIL' : 'PASS';
    reason = failed
      ? 'Structure/zone/signal decisions diverged under the configured structure-match tolerance.'
      : 'Structure, zone and signal decisions agree within the configured structure-match tolerance.';
  }

  return {
    status,
    reason,
    derivZone: derivSide.analysis.zone,
    hfmZone: hfmSide.analysis.zone,
    zoneMatch,
    derivDecision: derivSide.decision,
    hfmDecision: hfmSide.decision,
    decisionMatch,
    structureMatchTolerance,
    categories,
  };
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export interface DatasetReportSummary {
  sourceLabel: string;
  path?: string;
  symbol: string | null;
  timeframe: Timeframe | null;
  timestampConvention: TimestampConvention;
  timestampConventionDescription: string;
  totalRows: number;
  validCandles: number;
  invalidRows: number;
  duplicateRows: number;
  outOfOrder: boolean;
  closureVerified: boolean;
  closureNote: string;
  integrityStatus: ComparisonStatus;
  issueCodeCounts: Record<string, number>;
  issues: RowIssue[];
}

export interface BrokerComparisonReport {
  schemaVersion: string;
  generatedAt: string;
  disclaimer: string;
  symbol: string | null;
  timeframe: Timeframe | null;
  datasets: {
    deriv: DatasetReportSummary;
    hfm: DatasetReportSummary | null;
  };
  comparison: {
    status: ComparisonStatus;
    statusReason: string;
    timestampAlignment: AlignmentReport | null;
    coverage: CoverageReport | null;
    ohlcDifferences: OhlcDifferenceReport | null;
    toleranceCheck: ToleranceCheck | null;
    smcComparison: SmcComparisonReport;
    suggestedAlignment: SuggestedAlignment | null;
    limitations: string[];
  };
}

export interface CompareBrokerOptions {
  priceTolerance?: number;
  structureMatchTolerance?: number;
  minSamplesForDistribution?: number;
  expectedSymbol?: string;
  expectedTimeframe?: Timeframe;
  investigateOffset?: boolean;
  /** Injectable for deterministic tests; defaults to the current instant. */
  generatedAt?: string;
}

const DISCLAIMER =
  'Offline candle comparison only. Matching or differing candles are NOT evidence of strategy ' +
  'profitability, edge, or suitability. No result implies the application matches any broker.';

function summarizeDataset(summary: DatasetSummary): DatasetReportSummary {
  const integrityStatus: ComparisonStatus =
    summary.invalidRows > 0 || summary.duplicateRows > 0 ? 'FAIL' : 'PASS';
  return {
    sourceLabel: summary.sourceLabel,
    path: summary.path,
    symbol: summary.symbol,
    timeframe: summary.timeframe,
    timestampConvention: summary.timestampConvention,
    timestampConventionDescription: describeConvention(summary.timestampConvention),
    totalRows: summary.totalRows,
    validCandles: summary.validCandles,
    invalidRows: summary.invalidRows,
    duplicateRows: summary.duplicateRows,
    outOfOrder: summary.outOfOrder,
    closureVerified: summary.closureVerified,
    closureNote: summary.closureNote,
    integrityStatus,
    issueCodeCounts: summary.issueCodeCounts,
    issues: summary.issues,
  };
}

function instrumentMismatch(
  deriv: DatasetSummary,
  hfm: DatasetSummary,
  options: CompareBrokerOptions
): string | null {
  if (deriv.symbol === null || hfm.symbol === null) return 'One dataset has no valid symbol.';
  if (deriv.symbol !== hfm.symbol) {
    return `Symbol mismatch: deriv "${deriv.symbol}" vs hfm "${hfm.symbol}".`;
  }
  if (deriv.timeframe === null || hfm.timeframe === null) return 'One dataset has no valid timeframe.';
  if (deriv.timeframe !== hfm.timeframe) {
    return `Timeframe mismatch: deriv "${deriv.timeframe}" vs hfm "${hfm.timeframe}".`;
  }
  if (options.expectedSymbol !== undefined && deriv.symbol !== options.expectedSymbol) {
    return `Dataset symbol "${deriv.symbol}" does not match expected "${options.expectedSymbol}".`;
  }
  if (options.expectedTimeframe !== undefined && deriv.timeframe !== options.expectedTimeframe) {
    return `Dataset timeframe "${deriv.timeframe}" does not match expected "${options.expectedTimeframe}".`;
  }
  return null;
}

/**
 * Compare two parsed datasets. `hfm` may be null when no HFM data was supplied;
 * that always yields a NOT_RUN verdict (never PASS).
 */
export function compareBrokerCandles(
  deriv: DatasetSummary,
  hfm: DatasetSummary | null,
  options: CompareBrokerOptions = {}
): BrokerComparisonReport {
  const minSamples = options.minSamplesForDistribution ?? DEFAULT_MIN_SAMPLES_FOR_DISTRIBUTION;
  const priceTolerance = options.priceTolerance ?? null;
  const structureTolerance = options.structureMatchTolerance ?? null;

  const limitations: string[] = [
    DISCLAIMER,
    deriv.closureNote,
  ];

  const derivReport = summarizeDataset(deriv);
  const hfmReport = hfm === null ? null : summarizeDataset(hfm);

  const symbol = deriv.symbol ?? hfm?.symbol ?? null;
  const timeframe = deriv.timeframe ?? hfm?.timeframe ?? null;

  if (hfm === null || hfm.validCandles === 0) {
    return {
      schemaVersion: COMPARISON_SCHEMA_VERSION,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      disclaimer: DISCLAIMER,
      symbol,
      timeframe,
      datasets: { deriv: derivReport, hfm: hfmReport },
      comparison: {
        status: 'NOT_RUN',
        statusReason:
          'No HFM dataset was supplied (or it contained no valid candles). HFM-side validation cannot run; status is NOT_RUN, never PASS.',
        timestampAlignment: null,
        coverage: null,
        ohlcDifferences: null,
        toleranceCheck: null,
        smcComparison: emptySmcReport('NOT_RUN', 'No HFM dataset supplied.'),
        suggestedAlignment: null,
        limitations,
      },
    };
  }

  const mismatch = instrumentMismatch(deriv, hfm, options);
  const coverageResult = computeCoverage(deriv.candles, hfm.candles);
  const alignment = evaluateAlignment(deriv.timestampConvention, hfm.timestampConvention, coverageResult.coverage.matched);
  const ohlcDifferences = buildOhlcDifferences(coverageResult.pairs, minSamples);
  const toleranceCheck = evaluateTolerance(coverageResult.pairs, priceTolerance);

  const derivCandles = buildAnalyzableCandles(deriv);
  const hfmCandles = buildAnalyzableCandles(hfm);
  let smcReason: string | null = null;
  if (alignment.status !== 'PASS') {
    smcReason = 'SMC comparison requires a resolved timestamp alignment.';
  } else if (derivCandles === null || hfmCandles === null) {
    smcReason = `SMC comparison requires aligned timestamps and >= ${MIN_ANALYSIS_HISTORY} candles per side.`;
  }
  const derivSide =
    smcReason === null && derivCandles !== null && deriv.symbol !== null && deriv.timeframe !== null
      ? analyzeSide(deriv.symbol, deriv.timeframe, derivCandles)
      : null;
  const hfmSide =
    smcReason === null && hfmCandles !== null && hfm.symbol !== null && hfm.timeframe !== null
      ? analyzeSide(hfm.symbol, hfm.timeframe, hfmCandles)
      : null;
  const smcComparison = compareSmc(derivSide, hfmSide, structureTolerance, smcReason);

  let suggestedAlignment: SuggestedAlignment | null = null;
  if (options.investigateOffset === true && alignment.status === 'UNRESOLVED') {
    suggestedAlignment = suggestAlignmentOffset(deriv.candles, hfm.candles);
    if (suggestedAlignment !== null) limitations.push(suggestedAlignment.note);
  }

  if (!ohlcDifferences.sufficient) {
    limitations.push(
      `Only ${coverageResult.coverage.matched} matched candles; distribution percentiles are unreliable below ${minSamples} observations.`
    );
  }
  if (priceTolerance === null) {
    limitations.push('No price tolerance configured; raw differences are reported but no price PASS/FAIL verdict is produced.');
  }

  const { status, statusReason } = deriveStatus({
    mismatch,
    derivIntegrity: derivReport.integrityStatus,
    hfmIntegrity: hfmReport?.integrityStatus ?? 'PASS',
    alignment,
    matched: coverageResult.coverage.matched,
    toleranceCheck,
    smcStatus: smcComparison.status,
  });

  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    disclaimer: DISCLAIMER,
    symbol,
    timeframe,
    datasets: { deriv: derivReport, hfm: hfmReport },
    comparison: {
      status,
      statusReason,
      timestampAlignment: alignment,
      coverage: coverageResult.coverage,
      ohlcDifferences,
      toleranceCheck,
      smcComparison,
      suggestedAlignment,
      limitations,
    },
  };
}

interface StatusInputs {
  mismatch: string | null;
  derivIntegrity: ComparisonStatus;
  hfmIntegrity: ComparisonStatus;
  alignment: AlignmentReport;
  matched: number;
  toleranceCheck: ToleranceCheck;
  smcStatus: ComparisonStatus;
}

function deriveStatus(inputs: StatusInputs): { status: ComparisonStatus; statusReason: string } {
  if (inputs.mismatch !== null) {
    return { status: 'FAIL', statusReason: inputs.mismatch };
  }
  if (inputs.derivIntegrity === 'FAIL' || inputs.hfmIntegrity === 'FAIL') {
    return { status: 'FAIL', statusReason: 'A dataset failed integrity validation (invalid or duplicate rows).' };
  }
  if (inputs.alignment.status === 'UNRESOLVED') {
    return { status: 'UNRESOLVED', statusReason: inputs.alignment.note };
  }
  if (inputs.alignment.status === 'FAIL') {
    return { status: 'FAIL', statusReason: inputs.alignment.note };
  }
  if (inputs.matched === 0) {
    return { status: 'FAIL', statusReason: 'No candle timestamps overlapped after alignment.' };
  }
  if (inputs.toleranceCheck.status === 'FAIL') {
    return {
      status: 'FAIL',
      statusReason: `${inputs.toleranceCheck.exceedances} matched candles exceeded the configured price tolerance.`,
    };
  }
  if (inputs.smcStatus === 'FAIL') {
    return { status: 'FAIL', statusReason: 'SMC comparison diverged under the configured structure-match tolerance.' };
  }
  if (inputs.toleranceCheck.status === 'NOT_RUN') {
    return {
      status: 'UNRESOLVED',
      statusReason: 'Comparison ran but no price tolerance was configured, so no PASS/FAIL verdict is possible.',
    };
  }
  if (inputs.smcStatus !== 'PASS') {
    return {
      status: 'UNRESOLVED',
      statusReason: 'Price tolerance was met, but the SMC comparison did not reach a PASS verdict (unconfigured or not runnable).',
    };
  }
  return { status: 'PASS', statusReason: 'All configured checks ran and met their criteria.' };
}

// ---------------------------------------------------------------------------
// Human-readable summary
// ---------------------------------------------------------------------------

export function renderHumanSummary(report: BrokerComparisonReport): string {
  const lines: string[] = [];
  const push = (line: string): void => {
    lines.push(line);
  };

  push('Broker Candle Comparison (offline)');
  push('==================================');
  push(`Schema       : ${report.schemaVersion}`);
  push(`Generated    : ${report.generatedAt}`);
  push(`Instrument   : ${report.symbol ?? 'n/a'} ${report.timeframe ?? ''}`.trimEnd());
  push(`Verdict      : ${report.comparison.status}`);
  push(`Reason       : ${report.comparison.statusReason}`);
  push('');
  push(`DERIV dataset: ${report.datasets.deriv.validCandles} valid / ${report.datasets.deriv.invalidRows} invalid / ${report.datasets.deriv.duplicateRows} duplicate (tz: ${report.datasets.deriv.timestampConventionDescription})`);
  if (report.datasets.hfm !== null) {
    push(`HFM dataset  : ${report.datasets.hfm.validCandles} valid / ${report.datasets.hfm.invalidRows} invalid / ${report.datasets.hfm.duplicateRows} duplicate (tz: ${report.datasets.hfm.timestampConventionDescription})`);
  } else {
    push('HFM dataset  : NOT SUPPLIED');
  }

  if (report.comparison.coverage !== null) {
    const c = report.comparison.coverage;
    push('');
    push(`Matched: ${c.matched}  |  only-in-Deriv: ${c.onlyInDeriv}  |  only-in-HFM: ${c.onlyInHfm}`);
  }

  if (report.comparison.ohlcDifferences !== null) {
    push('');
    push('OHLC absolute differences (matched candles):');
    for (const field of PRICE_DIFFERENCE_FIELDS) {
      const diff = report.comparison.ohlcDifferences.fields[field];
      const s = diff.stats;
      if (s.count === 0) {
        push(`  ${field.padEnd(6)} : no matched candles`);
      } else {
        push(
          `  ${field.padEnd(6)} : min=${s.min.toFixed(6)} median=${s.median.toFixed(6)} p95=${s.p95.toFixed(6)} max=${s.max.toFixed(6)}`
        );
      }
    }
    push(`  sufficient for percentile verdict: ${report.comparison.ohlcDifferences.sufficient ? 'yes' : 'no'}`);
  }

  if (report.comparison.toleranceCheck !== null) {
    const t = report.comparison.toleranceCheck;
    push('');
    push(`Tolerance check : ${t.status} (configured=${t.configured ?? 'none'}, exceedances=${t.exceedances})`);
  }

  push('');
  push(`SMC comparison status: ${report.comparison.smcComparison.status}`);
  push(`  reason: ${report.comparison.smcComparison.reason}`);
  for (const category of report.comparison.smcComparison.categories) {
    push(
      `  ${category.category.padEnd(12)}: deriv=${category.derivCount} hfm=${category.hfmCount} matched=${category.matched} onlyDeriv=${category.onlyInDeriv} onlyHfm=${category.onlyInHfm} differing=${category.differingCount}`
    );
  }
  if (report.comparison.smcComparison.zoneMatch !== null) {
    push(`  zone match: ${report.comparison.smcComparison.zoneMatch} (${report.comparison.smcComparison.derivZone} vs ${report.comparison.smcComparison.hfmZone})`);
    push(`  signal match: ${report.comparison.smcComparison.decisionMatch} (${report.comparison.smcComparison.derivDecision} vs ${report.comparison.smcComparison.hfmDecision})`);
  }

  push('');
  push('Limitations:');
  for (const limitation of report.comparison.limitations) push(`  - ${limitation}`);

  if (report.comparison.suggestedAlignment !== null) {
    push('');
    push(`Suggested alignment (NOT APPLIED): offset ${report.comparison.suggestedAlignment.offsetSeconds}s, overlap ${report.comparison.suggestedAlignment.overlap}`);
  }

  return lines.join('\n');
}
