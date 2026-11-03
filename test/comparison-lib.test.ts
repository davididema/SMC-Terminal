/**
 * Deterministic unit tests for the offline broker comparison harness.
 *
 * ALL candle data below is SYNTHETIC TEST FIXTURE data, generated in-process.
 * It is NOT real market data and must never be interpreted as such. These tests
 * perform no network access and open no WebSocket.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOhlcDifferences,
  compareBrokerCandles,
  computeCoverage,
  computeDistribution,
  CSV_COLUMNS,
  DEFAULT_MIN_SAMPLES_FOR_DISTRIBUTION,
  normalizeTimeframe,
  parseConventionArg,
  parseCsvText,
  percentile,
  suggestAlignmentOffset,
  type DatasetSummary,
  type TimestampConvention,
} from './comparison-lib';

// ---------------------------------------------------------------------------
// SYNTHETIC TEST FIXTURE generators (not market data)
// ---------------------------------------------------------------------------

const START = 1_700_000_000;
const STEP = 900;
const TF = '15m';

interface Row {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

function makeSeries(
  count: number,
  opts: { start?: number; step?: number; base?: number; amp?: number; leg?: number; shift?: number } = {}
): Row[] {
  const start = opts.start ?? START;
  const step = opts.step ?? STEP;
  const base = opts.base ?? 2000;
  const amp = opts.amp ?? 8;
  const leg = opts.leg ?? 4;
  const shift = opts.shift ?? 0;
  const period = 2 * leg;
  const rows: Row[] = [];
  let prevClose = base;
  for (let i = 0; i < count; i += 1) {
    const pos = i % period;
    const ramp = pos < leg ? pos / leg : (period - pos) / leg;
    const close = base + i * 0.02 + ramp * amp;
    const open = i === 0 ? close : prevClose;
    const drift = 0.001 * i;
    const high = Math.max(open, close) + 0.5 + drift;
    const low = Math.min(open, close) - 0.5 - drift;
    rows.push({ ts: start + i * step, o: open + shift, h: high + shift, l: low + shift, c: close + shift });
    prevClose = close;
  }
  return rows;
}

function toCsv(rows: Row[], symbol = 'XAUUSD', timeframe = TF): string {
  const header = CSV_COLUMNS.join(',');
  const body = rows
    .map((r) => `${symbol},${timeframe},${r.ts},${r.o},${r.h},${r.l},${r.c}`)
    .join('\n');
  return `${header}\n${body}\n`;
}

const UTC: TimestampConvention = { kind: 'utc' };

function parse(csv: string, convention: TimestampConvention = UTC, label = 'deriv'): DatasetSummary {
  return parseCsvText(csv, { sourceLabel: label, convention });
}

// ---------------------------------------------------------------------------
// Timeframe + convention helpers
// ---------------------------------------------------------------------------

test('normalizeTimeframe accepts canonical values and MT5 aliases', () => {
  assert.equal(normalizeTimeframe('15m'), '15m');
  assert.equal(normalizeTimeframe('M15'), '15m');
  assert.equal(normalizeTimeframe('H1'), '1H');
  assert.equal(normalizeTimeframe('1H'), '1H');
  assert.equal(normalizeTimeframe('D1'), '1D');
  assert.equal(normalizeTimeframe('M7'), null);
});

test('parseConventionArg requires an explicit documented offset', () => {
  assert.deepEqual(parseConventionArg('utc'), { kind: 'utc' });
  assert.deepEqual(parseConventionArg('unknown'), { kind: 'unknown' });
  assert.equal(parseConventionArg('server:3600').kind, 'server-time');
  assert.throws(() => parseConventionArg('server'));
});

// ---------------------------------------------------------------------------
// CSV parsing / validation
// ---------------------------------------------------------------------------

test('parses a valid CSV and preserves source timestamps exactly', () => {
  const csv = toCsv(makeSeries(3));
  const summary = parse(csv);
  assert.equal(summary.validCandles, 3);
  assert.equal(summary.invalidRows, 0);
  assert.equal(summary.symbol, 'XAUUSD');
  assert.equal(summary.timeframe, '15m');
  assert.equal(summary.candles[0].sourceTimestamp, String(START));
  assert.equal(summary.candles[0].normalizedEpoch, START);
});

test('detects header and accepts MT5 timeframe aliases', () => {
  const csv = toCsv(makeSeries(2)) .replace(/,15m,/g, ',M15,');
  const summary = parse(csv);
  assert.equal(summary.validCandles, 2);
  assert.equal(summary.timeframe, '15m');
});

test('rejects non-finite and non-positive OHLC without repairing', () => {
  const header = CSV_COLUMNS.join(',');
  const csv = [
    header,
    `XAUUSD,${TF},${START},abc,1,1,1`,
    `XAUUSD,${TF},${START + STEP},1,Infinity,1,1`,
    `XAUUSD,${TF},${START + 2 * STEP},-1,1,1,1`,
  ].join('\n');
  const summary = parse(csv);
  assert.equal(summary.validCandles, 0);
  assert.equal(summary.invalidRows, 3);
  assert.equal(summary.issueCodeCounts.OHLC_NON_FINITE, 2);
  assert.equal(summary.issueCodeCounts.OHLC_NON_POSITIVE, 1);
});

test('rejects OHLC envelope violations', () => {
  const header = CSV_COLUMNS.join(',');
  const csv = `${header}\nXAUUSD,${TF},${START},10,5,8,9\n`;
  const summary = parse(csv);
  assert.equal(summary.validCandles, 0);
  assert.equal(summary.issueCodeCounts.OHLC_INVALID, 1);
});

test('rejects duplicate timestamps and counts them separately', () => {
  const header = CSV_COLUMNS.join(',');
  const csv = [
    header,
    `XAUUSD,${TF},${START},1,2,0.5,1.5`,
    `XAUUSD,${TF},${START},1,2,0.5,1.5`,
  ].join('\n');
  const summary = parse(csv);
  assert.equal(summary.validCandles, 1);
  assert.equal(summary.duplicateRows, 1);
  assert.equal(summary.invalidRows, 0);
});

test('rejects unsupported symbols and timeframes', () => {
  const header = CSV_COLUMNS.join(',');
  const csv = [
    header,
    `FOO,${TF},${START},1,2,0.5,1.5`,
    `XAUUSD,M7,${START + STEP},1,2,0.5,1.5`,
  ].join('\n');
  const summary = parse(csv);
  assert.equal(summary.validCandles, 0);
  assert.equal(summary.issueCodeCounts.SYMBOL_UNSUPPORTED, 1);
  assert.equal(summary.issueCodeCounts.TIMEFRAME_UNSUPPORTED, 1);
});

test('rejects rows with the wrong column count', () => {
  const header = CSV_COLUMNS.join(',');
  const csv = `${header}\nXAUUSD,${TF},${START},1,2,0.5\n`;
  const summary = parse(csv);
  assert.equal(summary.validCandles, 0);
  assert.equal(summary.issueCodeCounts.INVALID_COLUMN_COUNT, 1);
});

test('flags out-of-order timestamps but retains the rows', () => {
  const header = CSV_COLUMNS.join(',');
  const csv = [
    header,
    `XAUUSD,${TF},${START + STEP},1,2,0.5,1.5`,
    `XAUUSD,${TF},${START},1,2,0.5,1.5`,
  ].join('\n');
  const summary = parse(csv);
  assert.equal(summary.validCandles, 2);
  assert.equal(summary.outOfOrder, true);
});

test('applies a documented server-time offset deterministically', () => {
  const summary = parse(toCsv(makeSeries(1)), { kind: 'server-time', offsetSeconds: 3600, description: 'test' });
  assert.equal(summary.candles[0].normalizedEpoch, START - 3600);
});

test('leaves epochs unresolved under an unknown convention', () => {
  const summary = parse(toCsv(makeSeries(1)), { kind: 'unknown' });
  assert.equal(summary.candles[0].normalizedEpoch, null);
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

test('percentile and distribution statistics are correct', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 25), 1.75);
  assert.equal(percentile([1, 2, 3, 4], 75), 3.25);
  const stats = computeDistribution([1, 2, 3, 4]);
  assert.equal(stats.min, 1);
  assert.equal(stats.max, 4);
  assert.equal(stats.median, 2.5);
  assert.equal(stats.mean, 2.5);
});

// ---------------------------------------------------------------------------
// Matching + differences
// ---------------------------------------------------------------------------

test('computes coverage from overlapping timestamps', () => {
  const deriv = parse(toCsv(makeSeries(5))).candles;
  const hfm = parse(toCsv(makeSeries(3)), UTC, 'hfm').candles;
  const { coverage } = computeCoverage(deriv, hfm);
  assert.equal(coverage.matched, 3);
  assert.equal(coverage.onlyInDeriv, 2);
  assert.equal(coverage.onlyInHfm, 0);
});

test('computes OHLC absolute differences for matched candles', () => {
  const deriv = parse(toCsv(makeSeries(3))).candles;
  const hfm = parse(toCsv(makeSeries(3, { shift: 0.5 })), UTC, 'hfm').candles;
  const { pairs } = computeCoverage(deriv, hfm);
  const report = buildOhlcDifferences(pairs, DEFAULT_MIN_SAMPLES_FOR_DISTRIBUTION);
  assert.equal(report.fields.open.stats.max, 0.5);
  assert.equal(report.fields.range.stats.max, 0);
  assert.equal(report.sufficient, false);
});

// ---------------------------------------------------------------------------
// Full comparison verdicts
// ---------------------------------------------------------------------------

test('a missing HFM dataset can never yield PASS', () => {
  const deriv = parse(toCsv(makeSeries(80)));
  const report = compareBrokerCandles(deriv, null, { priceTolerance: 0.01, structureMatchTolerance: 0 });
  assert.equal(report.comparison.status, 'NOT_RUN');
  assert.notEqual(report.comparison.status, 'PASS');
  assert.equal(report.datasets.hfm, null);
});

test('an unknown timestamp convention yields UNRESOLVED', () => {
  const deriv = parse(toCsv(makeSeries(80)), { kind: 'unknown' });
  const hfm = parse(toCsv(makeSeries(80)), UTC, 'hfm');
  const report = compareBrokerCandles(deriv, hfm, { priceTolerance: 0.01, structureMatchTolerance: 0 });
  assert.equal(report.comparison.status, 'UNRESOLVED');
  assert.equal(report.comparison.timestampAlignment?.status, 'UNRESOLVED');
});

test('a symbol mismatch fails the comparison', () => {
  const deriv = parse(toCsv(makeSeries(80)));
  const hfm = parse(toCsv(makeSeries(80), 'EURUSD'), UTC, 'hfm');
  const report = compareBrokerCandles(deriv, hfm, { priceTolerance: 0.01, structureMatchTolerance: 0 });
  assert.equal(report.comparison.status, 'FAIL');
});

test('fully disjoint timestamps fail the comparison', () => {
  const deriv = parse(toCsv(makeSeries(40)));
  const hfm = parse(toCsv(makeSeries(40, { start: START + 40 * STEP })), UTC, 'hfm');
  const report = compareBrokerCandles(deriv, hfm, { priceTolerance: 100, structureMatchTolerance: 0 });
  assert.equal(report.comparison.status, 'FAIL');
  assert.equal(report.comparison.coverage?.matched, 0);
});

test('identical aligned datasets with configured tolerances yield PASS', () => {
  const deriv = parse(toCsv(makeSeries(80)));
  const hfm = parse(toCsv(makeSeries(80)), UTC, 'hfm');
  const report = compareBrokerCandles(deriv, hfm, { priceTolerance: 0.01, structureMatchTolerance: 0 });
  assert.equal(report.comparison.status, 'PASS');
  assert.equal(report.comparison.toleranceCheck?.status, 'PASS');
  assert.equal(report.comparison.smcComparison.status, 'PASS');
});

test('price differences beyond tolerance fail', () => {
  const deriv = parse(toCsv(makeSeries(80)));
  const hfm = parse(toCsv(makeSeries(80, { shift: 0.25 })), UTC, 'hfm');
  const report = compareBrokerCandles(deriv, hfm, { priceTolerance: 0.01, structureMatchTolerance: 1 });
  assert.equal(report.comparison.toleranceCheck?.status, 'FAIL');
  assert.equal(report.comparison.status, 'FAIL');
});

test('missing SMC events are detected when HFM history is shorter', () => {
  const deriv = parse(toCsv(makeSeries(80)));
  const hfm = parse(toCsv(makeSeries(60)), UTC, 'hfm');
  const report = compareBrokerCandles(deriv, hfm, { priceTolerance: 100, structureMatchTolerance: 0 });
  const swings = report.comparison.smcComparison.categories.find((c) => c.category === 'swings');
  assert.ok(swings !== undefined);
  assert.ok(swings.onlyInDeriv > 0 || swings.onlyInHfm > 0);
  assert.equal(report.comparison.status, 'FAIL');
});

test('price-shifted events are detected as differing', () => {
  const deriv = parse(toCsv(makeSeries(80)));
  const hfm = parse(toCsv(makeSeries(80, { shift: 0.25 })), UTC, 'hfm');
  const report = compareBrokerCandles(deriv, hfm, { priceTolerance: 100, structureMatchTolerance: 0 });
  const differing = report.comparison.smcComparison.categories.reduce(
    (acc, c) => acc + c.differingCount,
    0
  );
  assert.ok(differing > 0);
  assert.equal(report.comparison.smcComparison.status, 'FAIL');
});

test('report is JSON-serialisable and carries the schema version', () => {
  const deriv = parse(toCsv(makeSeries(40)));
  const report = compareBrokerCandles(deriv, null, { generatedAt: '2026-01-01T00:00:00.000Z' });
  const roundTripped = JSON.parse(JSON.stringify(report));
  assert.equal(roundTripped.schemaVersion, report.schemaVersion);
  assert.equal(roundTripped.generatedAt, '2026-01-01T00:00:00.000Z');
});

test('closure limitation is always reported', () => {
  const deriv = parse(toCsv(makeSeries(40)));
  const report = compareBrokerCandles(deriv, null);
  assert.ok(report.comparison.limitations.some((l) => l.includes('closed/forming flag')));
  assert.equal(report.datasets.deriv.closureVerified, false);
});

test('suggested alignment is an unapplied inference only', () => {
  const deriv = parse(toCsv(makeSeries(40))).candles;
  const shifted = makeSeries(40).map((r) => ({ ...r, ts: r.ts + 3600 }));
  const hfm = parse(toCsv(shifted), UTC, 'hfm').candles;
  const suggestion = suggestAlignmentOffset(deriv, hfm);
  assert.ok(suggestion !== null);
  assert.equal(suggestion?.applied, false);
  assert.equal(suggestion?.offsetSeconds, 3600);
});

test('expected instrument mismatch fails the comparison', () => {
  const deriv = parse(toCsv(makeSeries(40)));
  const hfm = parse(toCsv(makeSeries(40)), UTC, 'hfm');
  const report = compareBrokerCandles(deriv, hfm, { priceTolerance: 100, structureMatchTolerance: 1, expectedSymbol: 'GBPUSD' });
  assert.equal(report.comparison.status, 'FAIL');
});
