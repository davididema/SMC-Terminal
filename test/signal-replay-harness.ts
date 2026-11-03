/**
 * Genuine-signal replay harness (Phase 2B Stage 3) - shared helpers only.
 *
 * This file is NOT a test (it does not match `test/*.test.ts`, so `npm run
 * test:all` never executes it as a suite). It provides the shared pieces the
 * Stage C/D suites need:
 *
 * 1. `loadGenuineFixtures` / `validateFixture` - read fixtures from
 *    `test/fixtures/genuine/` and fail closed on ANY schema deviation
 *    (unknown/missing fields, unordered/open candles, identity or epoch
 *    inconsistencies). A missing directory loads as `[]`, never as an error.
 * 2. `replayFixture` / `assertReplayMatchesFixture` - replay a fixture's exact
 *    candle input through a FRESH `MonitoringCore` (fresh engine + session, so
 *    duplicate suppression behaves as it did at first acceptance) and compare
 *    the resulting signal field-for-field against the recorded one.
 * 3. Constructed-analysis test doubles (`genuineLongAnalysis`,
 *    `constructedLongSignal`, `constructedFixtureDouble`) and the existing
 *    `bearZigZag` candle fixture, so the suites can exercise the recorder and
 *    comparator WITHOUT claiming any market data. Nothing here ever writes to
 *    the genuine fixture directory.
 *
 * Honest labels: `bearZigZag`/`flatSeries` are SYNTHETIC candle fixtures;
 * `constructedFixtureDouble.source` is `'constructed-analysis-test-double'`.
 * Neither is genuine recorded market data and neither may be described as such.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  Candle,
  CandleManager,
  TIMEFRAMES,
  TIMEFRAME_SECONDS,
  assertCandleInvariants,
  type Timeframe,
} from '../lib/deriv/candles';
import { SMCEngine, type SMCAnalysisResult } from '../lib/analysis/smc';
import { SignalEngine, type SignalOutput } from '../lib/signals/signal-engine';
import { detectNewSignal, signalConfirmingEpoch } from '../lib/notifications/detector';
import type { DetectionResult } from '../lib/notifications/types';
import { signalPairKey } from '../lib/signals/signal-history';
import { MonitoringCore, type PairEvaluationReport } from '../lib/monitoring/headless-core';
import {
  FIXTURE_KEYS,
  FIXTURE_SIGNAL_KEYS,
  GENUINE_FIXTURE_KIND,
  GENUINE_FIXTURE_VERSION,
  RECORDED_CANDLE_KEYS,
  type GenuineSignalFixture,
  type RecordedCandle,
  type RecordingSink,
} from '../lib/monitoring/signal-recorder';
import { DEFAULT_FIXTURE_DIR } from '../lib/monitoring/signal-recorder-file';
import type { MarketStructureState, StructuralBias, SwingPoint } from '../lib/analysis/market-structure';
import type { BreakType, StructureBreak } from '../lib/analysis/structure-breaks';
import type { FairValueGap, FVGState } from '../lib/analysis/fvg';
import type { LiquidityLevel, LiquidityState } from '../lib/analysis/liquidity';

// =============================================================================================
// Test-double candle fixtures (SYNTHETIC - never genuine recorded market data)
// =============================================================================================

function candle(epoch: number, open: number, high: number, low: number, close: number): Candle {
  return { epoch, open, high, low, close, volume: 10, isClosed: true };
}

/** 5-leg bearish zig-zag (30 closed candles). Real structure, honestly rejected. */
export function bearZigZag(): Candle[] {
  const out: Candle[] = [];
  // The base is period-aligned: the candles below describe whole 1m periods,
  // exactly like the history a provider delivers.
  let e = 1749999960;
  let p = 1.115;
  for (let leg = 0; leg < 5; leg++) {
    const target = p - 0.006;
    for (let i = 0; i < 4; i++) {
      p -= 0.0004;
      out.push(candle((e += 60), p, p + 0.0002, p - 0.0003, p));
    }
    for (let i = 0; i < 2; i++) {
      p += 0.001;
      out.push(candle((e += 60), p, p + 0.0002, p - 0.0003, p));
    }
    p = target + 0.002;
  }
  return out;
}

/**
 * SYNTHETIC flat closed series ending at `lastEpoch` with a constant close,
 * so the constructed-analysis double's last closed candle matches the exact
 * context the existing suites emit LONG with (see `constructedLongSignal`).
 */
export function flatSeries(lastEpoch: number, close: number, count: number): Candle[] {
  const out: Candle[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(candle(lastEpoch - i * 60, close, close, close, close));
  }
  return out;
}

// =============================================================================================
// Constructed-analysis test double (same technique as signal-engine.test.ts and
// monitoring-equivalence.test.ts: constructed SMCAnalysisResult, REAL engine on top)
// =============================================================================================

function brk(
  symbol: string,
  timeframe: Timeframe,
  type: BreakType,
  confirmedAtEpoch: number,
  breakCandleEpoch: number,
  id: string
): StructureBreak {
  const direction: 'BULLISH' | 'BEARISH' = type.startsWith('BULLISH') ? 'BULLISH' : 'BEARISH';
  return {
    id,
    type,
    symbol,
    timeframe,
    breakCandleEpoch,
    brokenSwingEpoch: breakCandleEpoch - 100,
    brokenPrice: 1.1,
    confirmationPrice: 1.1,
    confirmedAtEpoch,
    direction,
    sourceStructure: 'NEUTRAL',
  };
}

function makeSwingPoint(
  symbol: string,
  timeframe: Timeframe,
  id: string,
  type: 'HIGH' | 'LOW',
  price: number
): SwingPoint {
  return {
    id,
    symbol,
    timeframe,
    type,
    candleEpoch: 100,
    swingCandleEpoch: 100,
    confirmedAtEpoch: 200,
    price,
    candleIndex: 0,
    structureType: type === 'HIGH' ? 'HH' : 'LL',
  };
}

function makeLiquidityLevel(id: string, price: number, type: 'BUY_SIDE' | 'SELL_SIDE'): LiquidityLevel {
  return { id, price, type, swept: false, epoch: 100 };
}

function emptyAnalysis(symbol: string, timeframe: Timeframe): SMCAnalysisResult {
  const marketStructure: MarketStructureState = {
    symbol,
    timeframe,
    structuralBias: 'NEUTRAL' as StructuralBias,
    swings: [],
    latestSwingHigh: null,
    latestSwingLow: null,
    latestHH: null,
    latestHL: null,
    latestLH: null,
    latestLL: null,
    latestEQH: null,
    latestEQL: null,
    recentStructureSequence: [],
    lastAnalyzedEpoch: 0,
    breaks: [],
    latestBOS: null,
    latestCHoCH: null,
    protectedHigh: null,
    protectedLow: null,
  };
  return {
    symbol,
    timeframe,
    marketStructure,
    liquidity: {
      symbol,
      timeframe,
      buySideLiquidity: [],
      sellSideLiquidity: [],
      equalHighs: [],
      equalLows: [],
      status: 'WAITING FOR DATA',
    },
    fvg: {
      symbol,
      timeframe,
      bullishFVGs: [],
      bearishFVGs: [],
      unmitigatedCount: 0,
      status: 'WAITING FOR DATA',
    },
    orderBlocks: {
      symbol,
      timeframe,
      bullishOrderBlocks: [],
      bearishOrderBlocks: [],
      status: 'WAITING FOR DATA',
    },
    zone: 'WAITING FOR DATA',
    analyzedAt: 0,
  };
}

function fvgState(
  symbol: string,
  timeframe: Timeframe,
  bull: FairValueGap[],
  bear: FairValueGap[]
): FVGState {
  return {
    symbol,
    timeframe,
    bullishFVGs: bull,
    bearishFVGs: bear,
    unmitigatedCount: 0,
    status: 'ACTIVE',
  };
}

function liqState(
  symbol: string,
  timeframe: Timeframe,
  buy: LiquidityLevel[],
  sell: LiquidityLevel[]
): LiquidityState {
  return {
    symbol,
    timeframe,
    buySideLiquidity: buy,
    sellSideLiquidity: sell,
    equalHighs: [],
    equalLows: [],
    status: 'ACTIVE',
  };
}

/**
 * Constructed LONG TREND_CONTINUATION analysis (mirrors the ORCH 1 fixture of
 * signal-engine.test.ts). CONSTRUCTED ANALYSIS - not derived from candles.
 */
export function genuineLongAnalysis(
  symbol: string,
  timeframe: Timeframe,
  signalEpoch: number
): SMCAnalysisResult {
  const bar = TIMEFRAME_SECONDS[timeframe];
  const trigger: StructureBreak = {
    ...brk(symbol, timeframe, 'BULLISH_BOS', signalEpoch - bar, signalEpoch - 2 * bar, 'trig-long'),
    brokenPrice: 1.1,
  };
  const base = emptyAnalysis(symbol, timeframe);
  const marketStructure: MarketStructureState = {
    ...base.marketStructure,
    structuralBias: 'BULLISH' as StructuralBias,
    swings: [makeSwingPoint(symbol, timeframe, 'sw1', 'LOW', 1.095)],
    protectedLow: makeSwingPoint(symbol, timeframe, 'pl', 'LOW', 1.0985),
    breaks: [trigger],
  };
  return {
    ...base,
    marketStructure,
    fvg: fvgState(
      symbol,
      timeframe,
      [
        {
          id: 'zone-long',
          type: 'BULLISH',
          topPrice: 1.0995,
          bottomPrice: 1.099,
          epoch: signalEpoch - 5 * bar,
          mitigated: false,
        },
      ],
      []
    ),
    liquidity: liqState(symbol, timeframe, [makeLiquidityLevel('tgt-long', 1.105, 'BUY_SIDE')], []),
    zone: 'DISCOUNT',
  };
}

/**
 * REAL `SignalEngine` over the constructed analysis - the established test
 * technique for producing a genuine-identity LONG without touching candles.
 * With the given epoch and close 1.1 this is exactly the CORE 6 emission of
 * monitoring-equivalence.test.ts (signalId `EURUSD:1m:trig-long:zone-long`).
 */
export function constructedLongSignal(
  symbol: string,
  timeframe: Timeframe,
  epoch: number,
  close: number
): SignalOutput {
  const ctxCandle: Candle = { epoch, open: close, high: close, low: close, close, volume: 1, isClosed: true };
  return new SignalEngine().evaluate(genuineLongAnalysis(symbol, timeframe, epoch), {
    lastClosedCandle: ctxCandle,
  });
}

/** Detector verdict for a signal, using the EXISTING pure detector. */
export function acceptedDetectionFor(
  signal: SignalOutput,
  symbolId: string,
  timeframe: string,
  confirmingCandleEpoch: number
): DetectionResult {
  return detectNewSignal(
    {
      signal,
      symbolId,
      timeframe,
      pairKey: signalPairKey(symbolId, timeframe),
      confirmingCandleEpoch,
    },
    new Set<string>()
  );
}

/** In-memory sink so tests never touch the genuine fixture directory. */
export interface MemorySink extends RecordingSink {
  readonly written: GenuineSignalFixture[];
}

export function memorySink(): MemorySink {
  const written: GenuineSignalFixture[] = [];
  return {
    written,
    writeFixture(fixture: GenuineSignalFixture): void {
      written.push(fixture);
    },
  };
}

/**
 * A STRUCTURALLY VALID fixture built from constructed analysis + synthetic
 * candles. It passes `validateFixture` (that is its purpose: schema round-trip
 * and comparator tests) but it is NOT genuine recorded market data, is never
 * written to disk, and replaying its candles with the real analysis engine
 * deliberately does NOT reproduce its signal (REPLAY 1d asserts that).
 */
export function constructedFixtureDouble(): GenuineSignalFixture {
  const lastEpoch = 1_700_000_040;
  const candles = flatSeries(lastEpoch, 1.1, 30);
  const signal = constructedLongSignal('EURUSD', '1m', lastEpoch, 1.1);
  return {
    fixtureKind: GENUINE_FIXTURE_KIND,
    fixtureVersion: GENUINE_FIXTURE_VERSION,
    recordedAt: new Date().toISOString(),
    source: 'constructed-analysis-test-double',
    symbolId: 'EURUSD',
    timeframe: '1m',
    pairKey: 'EURUSD:1m',
    confirmingCandleEpoch: lastEpoch,
    candleCount: candles.length,
    candles: candles.map((c) => ({
      epoch: c.epoch,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      isClosed: c.isClosed,
    })),
    signalId: signal.signalId as string,
    signal,
  };
}

/**
 * An `SMCEngine` stand-in that returns the constructed analysis, derived from
 * the last candle's epoch. Used ONLY in tests that need `evaluatePair` to
 * produce an accepted candidate end-to-end; the engine, detector, recorder,
 * and core under it are all real.
 */
export function constructedLongSmcEngine(): SMCEngine {
  return {
    analyze: (symbol: string, timeframe: Timeframe, candles: Candle[]): SMCAnalysisResult =>
      genuineLongAnalysis(symbol, timeframe, candles.length > 0 ? candles[candles.length - 1].epoch : 0),
  } as unknown as SMCEngine;
}

// =============================================================================================
// Fixture loading - fail closed on ANY schema deviation
// =============================================================================================

function invalidFixture(source: string, message: string): never {
  throw new Error(`invalid genuine fixture (${source}): ${message}`);
}

const SIGNAL_REQUIRED_KEYS = [
  'decision',
  'confidence',
  'setup',
  'entry',
  'stopLoss',
  'takeProfit',
  'riskReward',
  'reason',
  'timestamp',
] as const;

function hasExactKeys(value: object, allowed: readonly string[]): { extra: string[]; missing: string[] } {
  const keys = Object.keys(value);
  return {
    extra: keys.filter((k) => !allowed.includes(k)),
    missing: allowed.filter((k) => !Object.prototype.hasOwnProperty.call(value, k)),
  };
}

/** Validate one parsed fixture value against the exact schema. Throws on ANY deviation. */
export function validateFixture(value: unknown, source: string): GenuineSignalFixture {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidFixture(source, 'fixture must be a JSON object');
  }
  const obj = value as Record<string, unknown>;

  const top = hasExactKeys(obj, FIXTURE_KEYS);
  if (top.extra.length > 0) invalidFixture(source, `unexpected field(s): ${top.extra.join(', ')}`);
  if (top.missing.length > 0) invalidFixture(source, `missing field(s): ${top.missing.join(', ')}`);

  if (obj.fixtureKind !== GENUINE_FIXTURE_KIND) {
    invalidFixture(source, `fixtureKind must be '${GENUINE_FIXTURE_KIND}'`);
  }
  if (obj.fixtureVersion !== GENUINE_FIXTURE_VERSION) {
    invalidFixture(source, `fixtureVersion must be ${GENUINE_FIXTURE_VERSION}`);
  }
  if (typeof obj.recordedAt !== 'string' || !Number.isFinite(Date.parse(obj.recordedAt))) {
    invalidFixture(source, 'recordedAt must be a valid ISO-8601 timestamp');
  }
  if (typeof obj.source !== 'string' || obj.source.length === 0) {
    invalidFixture(source, 'source must be a non-empty string');
  }
  if (typeof obj.symbolId !== 'string' || obj.symbolId.length === 0) {
    invalidFixture(source, 'symbolId must be a non-empty string');
  }
  if (typeof obj.timeframe !== 'string' || !TIMEFRAMES.includes(obj.timeframe as Timeframe)) {
    invalidFixture(source, `timeframe must be one of ${TIMEFRAMES.join('/')} (got ${String(obj.timeframe)})`);
  }
  const timeframe = obj.timeframe as Timeframe;
  const expectedPairKey = `${obj.symbolId}:${timeframe}`;
  if (obj.pairKey !== expectedPairKey) {
    invalidFixture(source, `pairKey must be '${expectedPairKey}' (got ${String(obj.pairKey)})`);
  }
  if (typeof obj.confirmingCandleEpoch !== 'number' || !Number.isInteger(obj.confirmingCandleEpoch)) {
    invalidFixture(source, 'confirmingCandleEpoch must be an integer');
  }
  const confirmingCandleEpoch = obj.confirmingCandleEpoch as number;
  if (typeof obj.signalId !== 'string' || obj.signalId.length === 0) {
    invalidFixture(source, 'signalId must be a non-empty string');
  }
  const signalId = obj.signalId as string;
  if (!signalId.startsWith(`${expectedPairKey}:`)) {
    invalidFixture(source, `signalId '${signalId}' does not belong to pair '${expectedPairKey}'`);
  }

  // --- candles: exact keys, closed, strictly ordered, valid, confirming candle last ---
  if (!Array.isArray(obj.candles)) {
    invalidFixture(source, 'candles must be an array');
  }
  const rawCandles = obj.candles as unknown[];
  if (rawCandles.length === 0) {
    invalidFixture(source, 'candles must not be empty');
  }
  if (typeof obj.candleCount !== 'number' || obj.candleCount !== rawCandles.length) {
    invalidFixture(source, `candleCount (${String(obj.candleCount)}) does not match candles length (${rawCandles.length})`);
  }

  const candles: RecordedCandle[] = [];
  let previousEpoch = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < rawCandles.length; i++) {
    const raw = rawCandles[i];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      invalidFixture(source, `candles[${i}] must be an object`);
    }
    const ck = hasExactKeys(raw as object, RECORDED_CANDLE_KEYS);
    if (ck.extra.length > 0) invalidFixture(source, `candles[${i}] unexpected field(s): ${ck.extra.join(', ')}`);
    if (ck.missing.length > 0) invalidFixture(source, `candles[${i}] missing field(s): ${ck.missing.join(', ')}`);

    const c = raw as Record<string, unknown>;
    const numeric = ['epoch', 'open', 'high', 'low', 'close', 'volume'];
    for (const key of numeric) {
      if (typeof c[key] !== 'number' || !Number.isFinite(c[key] as number)) {
        invalidFixture(source, `candles[${i}].${key} must be a finite number`);
      }
    }
    if (typeof c.isClosed !== 'boolean') {
      invalidFixture(source, `candles[${i}].isClosed must be a boolean`);
    }
    const candleValue: RecordedCandle = {
      epoch: c.epoch as number,
      open: c.open as number,
      high: c.high as number,
      low: c.low as number,
      close: c.close as number,
      volume: c.volume as number,
      isClosed: c.isClosed as boolean,
    };
    if (candleValue.isClosed !== true) {
      invalidFixture(source, `candles[${i}] is not a closed candle`);
    }
    if (!Number.isInteger(candleValue.epoch) || candleValue.epoch <= 0) {
      invalidFixture(source, `candles[${i}].epoch must be a positive integer`);
    }
    if (candleValue.epoch <= previousEpoch) {
      invalidFixture(source, `candles[${i}].epoch is not strictly greater than the previous epoch`);
    }
    previousEpoch = candleValue.epoch;
    if (
      !assertCandleInvariants({
        epoch: candleValue.epoch,
        open: candleValue.open,
        high: candleValue.high,
        low: candleValue.low,
        close: candleValue.close,
        volume: candleValue.volume,
        isClosed: candleValue.isClosed,
      })
    ) {
      invalidFixture(source, `candles[${i}] violates OHLC/volume invariants`);
    }
    candles.push(candleValue);
  }
  const lastCandle = candles[candles.length - 1];
  if (lastCandle.epoch !== confirmingCandleEpoch) {
    invalidFixture(
      source,
      `confirmingCandleEpoch (${confirmingCandleEpoch}) must equal the last candle epoch (${lastCandle.epoch})`
    );
  }

  // --- signal: exact allowed keys, required keys, genuine decision, identity + epoch agreement ---
  const rawSignal = obj.signal;
  if (typeof rawSignal !== 'object' || rawSignal === null || Array.isArray(rawSignal)) {
    invalidFixture(source, 'signal must be an object');
  }
  const signalKeys = Object.keys(rawSignal as object);
  const unknownKeys = signalKeys.filter((k) => !(FIXTURE_SIGNAL_KEYS as readonly string[]).includes(k));
  if (unknownKeys.length > 0) {
    invalidFixture(source, `signal has unexpected field(s): ${unknownKeys.join(', ')}`);
  }
  const sig = rawSignal as Record<string, unknown>;
  for (const key of SIGNAL_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(sig, key)) {
      invalidFixture(source, `signal is missing field '${key}'`);
    }
  }
  if (sig.decision !== 'LONG' && sig.decision !== 'SHORT') {
    invalidFixture(source, `signal.decision must be LONG or SHORT (got ${String(sig.decision)})`);
  }
  if (sig.signalId !== signalId) {
    invalidFixture(source, `signal.signalId (${String(sig.signalId)}) does not match fixture.signalId (${signalId})`);
  }
  const signal = sig as unknown as SignalOutput;
  const signalEpoch = signalConfirmingEpoch(signal);
  if (signalEpoch !== confirmingCandleEpoch) {
    invalidFixture(
      source,
      `signal confirming epoch (${String(signalEpoch)}) does not equal confirmingCandleEpoch (${confirmingCandleEpoch})`
    );
  }

  return {
    fixtureKind: GENUINE_FIXTURE_KIND,
    fixtureVersion: GENUINE_FIXTURE_VERSION,
    recordedAt: obj.recordedAt as string,
    source: obj.source as string,
    symbolId: obj.symbolId as string,
    timeframe,
    pairKey: expectedPairKey,
    confirmingCandleEpoch,
    candleCount: candles.length,
    candles,
    signalId,
    signal,
  };
}

/**
 * Load every `*.json` fixture in the directory (sorted by filename), validating
 * each one. Missing directory or no fixtures -> `[]`. A malformed fixture throws
 * (fail closed): an invalid file must never silently disappear from replay.
 */
export function loadGenuineFixtures(dir: string = DEFAULT_FIXTURE_DIR): GenuineSignalFixture[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  return files.map((name) => {
    const path = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid genuine fixture (${name}): unreadable JSON - ${detail}`);
    }
    return validateFixture(parsed, name);
  });
}

// =============================================================================================
// Replay - fresh core, exact candle input, precondition + field-for-field comparison
// =============================================================================================

/** JSON round-trip clone so `undefined` keys compare exactly like on disk. */
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Replay a fixture through a FRESH `MonitoringCore` and return the report.
 * Fail closed BEFORE evaluation if the reconstructed history does not have
 * exactly `fixture.candleCount` closed candles (guards the known `seedHistory`
 * forming-candle demotion and any history-cap truncation).
 */
export function replayFixture(fixture: GenuineSignalFixture): PairEvaluationReport {
  const timeframe = fixture.timeframe as Timeframe;
  const capacity = Math.max(fixture.candleCount + 16, 1000);
  const core = new MonitoringCore({ candleManager: new CandleManager(capacity) });

  core.ingestClosedCandles(fixture.symbolId, timeframe, fixture.candles);

  const seeded = core.candleManager.getHistory(fixture.symbolId, timeframe);
  if (seeded.length !== fixture.candleCount) {
    throw new Error(
      `replay precondition failed (${fixture.signalId}): reconstructed ${seeded.length} closed candle(s), ` +
        `fixture recorded ${fixture.candleCount}`
    );
  }

  const report = core.evaluatePair(fixture.symbolId, timeframe);
  if (report.evaluation.closedCandleCount !== fixture.candleCount) {
    throw new Error(
      `replay precondition failed (${fixture.signalId}): evaluation saw ${report.evaluation.closedCandleCount} ` +
        `closed candle(s), fixture recorded ${fixture.candleCount}`
    );
  }
  return report;
}

/**
 * Assert a replayed report reproduces the recorded fixture exactly:
 * accepted detection, identical identity, identical confirming epoch, identical
 * candle count, and a field-for-field identical signal (JSON-normalized so
 * absent-vs-undefined keys cannot hide a difference).
 */
export function assertReplayMatchesFixture(report: PairEvaluationReport, fixture: GenuineSignalFixture): void {
  const label = `${fixture.pairKey} ${fixture.signalId}`;

  assert.equal(
    report.detection.accepted,
    true,
    `${label}: replay was not accepted (reason: ${report.detection.reason})`
  );
  assert.equal(report.confirmingCandleEpoch, fixture.confirmingCandleEpoch, `${label}: confirming epoch differs`);
  assert.equal(
    report.evaluation.closedCandleCount,
    fixture.candleCount,
    `${label}: closed candle count differs from the recorded input`
  );
  assert.ok(report.candidate !== null, `${label}: replay produced no candidate`);
  assert.equal(report.candidate.signalId, fixture.signalId, `${label}: signalId differs`);
  assert.equal(report.evaluation.signal?.signalId, fixture.signalId, `${label}: evaluation signalId differs`);

  const replayed = jsonClone(report.evaluation.signal);
  const recorded = jsonClone(fixture.signal);
  assert.deepEqual(replayed, recorded, `${label}: replayed signal differs from the recorded signal`);
}
