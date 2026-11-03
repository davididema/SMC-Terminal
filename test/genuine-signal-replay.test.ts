/**
 * Phase 2B Stage 3 — genuine-signal replay suite (REPLAY 1-3).
 *
 * REPLAY 1 (always runs): synthetic self-check of the replay harness. Proves
 * the comparator is non-vacuous — it PASSES for a matching record/replay pair
 * and THROWS for NO_TRADE replays and tampered fixtures. The positive pair is
 * built through the established constructed-analysis stand-in
 * (`constructedLongSmcEngine` + flat synthetic candles): real core, real
 * signal engine, real detector, real recorder — only the SMC analysis input is
 * the labeled constructed double. NOTHING here is genuine recorded market data.
 *
 * REPLAY 2 (skip-gated): loads `test/fixtures/genuine/` and replays every
 * recorded fixture field-for-field. If no fixture has been captured yet the
 * test SKIPS with an explicit reason; a MALFORMED fixture FAILS the test
 * (loadGenuineFixtures throws — it never silently disappears).
 *
 * REPLAY 3 (always runs): loader fail-closed proof in OS temp directories —
 * missing/empty dirs load as [], every schema deviation throws, a valid
 * fixture round-trips. Temp dirs only: this suite NEVER writes to
 * `test/fixtures/genuine/`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertReplayMatchesFixture,
  bearZigZag,
  constructedFixtureDouble,
  constructedLongSmcEngine,
  flatSeries,
  loadGenuineFixtures,
  memorySink,
  replayFixture,
  validateFixture,
} from './signal-replay-harness';
import { SignalRecorder, type GenuineSignalFixture } from '../lib/monitoring/signal-recorder';
import { MonitoringCore, type PairEvaluationReport } from '../lib/monitoring/headless-core';
import { CandleManager, type Timeframe } from '../lib/deriv/candles';

const SYMBOL = 'EURUSD';
const TF = '1m' as const;
/** Last closed-candle epoch of the constructed positive pair (SYNTHETIC). */
const EPOCH = 1_700_000_040;

/** Record a constructed-analysis fixture end-to-end through a real core. */
function recordConstructedPair(): GenuineSignalFixture {
  const sink = memorySink();
  const recorder = new SignalRecorder({ sink, source: 'replay-self-check' });
  const core = new MonitoringCore({
    candleManager: new CandleManager(64),
    smcEngine: constructedLongSmcEngine(),
    recorder,
  });
  core.ingestClosedCandles(SYMBOL, TF, flatSeries(EPOCH, 1.1, 30));
  const report = core.evaluatePair(SYMBOL, TF);
  assert.equal(report.detection.accepted, true, 'constructed pair must be detector-accepted');
  assert.equal(report.recording?.recorded, true, `recording must succeed (${String(report.recording?.reason)})`);
  assert.equal(sink.written.length, 1, 'exactly one fixture written to the memory sink');
  const fixture = sink.written[0];
  validateFixture(fixture, 'replay-self-check');
  return fixture;
}

/** Fresh-core replay of a fixture through the SAME constructed stand-in engine. */
function replayWithStandIn(fixture: GenuineSignalFixture): PairEvaluationReport {
  const core = new MonitoringCore({
    candleManager: new CandleManager(Math.max(fixture.candleCount + 16, 1000)),
    smcEngine: constructedLongSmcEngine(),
  });
  core.ingestClosedCandles(fixture.symbolId, fixture.timeframe as Timeframe, fixture.candles);
  const seeded = core.candleManager.getHistory(fixture.symbolId, fixture.timeframe as Timeframe);
  assert.equal(seeded.length, fixture.candleCount, 'replay precondition: reconstructed candle count');
  const report = core.evaluatePair(fixture.symbolId, fixture.timeframe as Timeframe);
  assert.equal(report.evaluation.closedCandleCount, fixture.candleCount, 'replay precondition: evaluation candle count');
  return report;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('REPLAY 1a: positive control — recorded constructed fixture replays field-for-field', () => {
  const fixture = recordConstructedPair();
  const report = replayWithStandIn(fixture);
  assertReplayMatchesFixture(report, fixture);
});

test('REPLAY 1b: constructed fixture double passes the schema validator', () => {
  const fixture = constructedFixtureDouble();
  const validated = validateFixture(fixture, 'constructed-double');
  assert.equal(validated.signalId, fixture.signalId);
});

test('REPLAY 1c: real engine on the double\u2019s flat candles does NOT reproduce — comparator throws', () => {
  const fixture = constructedFixtureDouble();
  const report = replayFixture(fixture);
  assert.equal(report.detection.accepted, false, 'real engine on flat synthetic candles must not accept');
  assert.throws(
    () => assertReplayMatchesFixture(report, fixture),
    /replay was not accepted/,
    'comparator must reject a NO_TRADE replay'
  );
});

test('REPLAY 1d: real engine on bearZigZag honestly rejects — comparator throws', () => {
  const core = new MonitoringCore({ candleManager: new CandleManager(64) });
  core.ingestClosedCandles(SYMBOL, TF, bearZigZag());
  const report = core.evaluatePair(SYMBOL, TF);
  assert.equal(report.detection.accepted, false, 'bearZigZag is honestly rejected by the existing pipeline');
  assert.throws(
    () => assertReplayMatchesFixture(report, constructedFixtureDouble()),
    /replay was not accepted/,
    'comparator must reject a NO_TRADE replay'
  );
});

test('REPLAY 1e: comparator throws on tampered fixtures (signalId, entry, epoch, candleCount)', () => {
  const fixture = recordConstructedPair();
  const report = replayWithStandIn(fixture);
  assertReplayMatchesFixture(report, fixture);

  const bySignalId = clone(fixture);
  bySignalId.signalId = 'EURUSD:1m:trig-long:tampered';
  assert.throws(
    () => assertReplayMatchesFixture(report, bySignalId),
    /signalId differs/,
    'tampered signalId must fail'
  );

  const byEntry = clone(fixture);
  (byEntry.signal as { entry: number | null }).entry = 999;
  assert.throws(
    () => assertReplayMatchesFixture(report, byEntry),
    /differs from the recorded signal/,
    'tampered entry must fail deep comparison'
  );

  const byEpoch = clone(fixture);
  byEpoch.confirmingCandleEpoch = EPOCH + 60;
  assert.throws(
    () => assertReplayMatchesFixture(report, byEpoch),
    /confirming epoch differs/,
    'tampered confirming epoch must fail'
  );

  const byCount = clone(fixture);
  byCount.candleCount = 5;
  assert.throws(
    () => assertReplayMatchesFixture(report, byCount),
    /closed candle count differs/,
    'tampered candle count must fail'
  );
});

test('REPLAY 2: genuine recorded fixtures replay field-for-field (skip-gated until a fixture exists)', (t) => {
  // A malformed fixture makes loadGenuineFixtures THROW → this test FAILS.
  // Only the honest "nothing captured yet" state skips.
  const fixtures = loadGenuineFixtures();
  if (fixtures.length === 0) {
    t.skip(
      'no genuine fixture captured yet — record one with a manual ' +
        'SMC_RECORD_SIGNAL_FIXTURE=1 npm run monitor:live session, then re-run this suite'
    );
    return;
  }
  for (const fixture of fixtures) {
    const report = replayFixture(fixture);
    assertReplayMatchesFixture(report, fixture);
  }
});

test('REPLAY 3: loader is fail-closed — missing/empty dirs load, every deviation throws', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'smc-replay-'));
  try {
    // Missing directory and empty directory both load as [].
    assert.deepEqual(loadGenuineFixtures(join(dir, 'does-not-exist')), [], 'missing dir must load as []');
    assert.deepEqual(loadGenuineFixtures(dir), [], 'empty dir must load as []');

    // Unreadable JSON throws (fail closed).
    writeFileSync(join(dir, 'broken.json'), 'not json {{', 'utf8');
    assert.throws(() => loadGenuineFixtures(dir), /invalid genuine fixture \(broken\.json\): unreadable JSON/);
    rmSync(join(dir, 'broken.json'));

    // A valid fixture round-trips through the loader.
    writeFileSync(join(dir, 'valid.json'), JSON.stringify(constructedFixtureDouble(), null, 2), 'utf8');
    const loaded = loadGenuineFixtures(dir);
    assert.equal(loaded.length, 1, 'valid fixture must load');
    assert.equal(loaded[0].signalId, constructedFixtureDouble().signalId);
    rmSync(join(dir, 'valid.json'));

    // A non-object fixture throws.
    writeFileSync(join(dir, 'array.json'), '[]', 'utf8');
    assert.throws(() => loadGenuineFixtures(dir), /fixture must be a JSON object/);
    rmSync(join(dir, 'array.json'));

    interface Deviation {
      label: string;
      mutate: (f: Record<string, unknown>) => void;
      pattern: RegExp;
    }
    const deviations: Deviation[] = [
      {
        label: 'unexpected top-level field',
        mutate: (f) => {
          f.extra = 1;
        },
        pattern: /unexpected field\(s\): extra/,
      },
      {
        label: 'missing top-level field',
        mutate: (f) => {
          delete f.source;
        },
        pattern: /missing field\(s\): source/,
      },
      {
        label: 'wrong fixtureKind',
        mutate: (f) => {
          f.fixtureKind = 'forged';
        },
        pattern: /fixtureKind must be/,
      },
      {
        label: 'non-integer confirming epoch',
        mutate: (f) => {
          f.confirmingCandleEpoch = 1.5;
        },
        pattern: /confirmingCandleEpoch must be an integer/,
      },
      {
        label: 'invalid timeframe',
        mutate: (f) => {
          f.timeframe = '5x';
        },
        pattern: /timeframe must be one of/,
      },
      {
        label: 'pairKey mismatch',
        mutate: (f) => {
          f.pairKey = 'GBPUSD:1m';
        },
        pattern: /pairKey must be/,
      },
      {
        label: 'signalId from another pair',
        mutate: (f) => {
          f.signalId = 'GBPUSD:1m:trig-long:zone-long';
        },
        pattern: /does not belong to pair/,
      },
      {
        label: 'candleCount mismatch',
        mutate: (f) => {
          f.candleCount = 999;
        },
        pattern: /does not match candles length/,
      },
      {
        label: 'open candle recorded',
        mutate: (f) => {
          (f.candles as Array<Record<string, unknown>>)[0].isClosed = false;
        },
        pattern: /is not a closed candle/,
      },
      {
        label: 'unordered candles',
        mutate: (f) => {
          const candles = f.candles as Array<Record<string, unknown>>;
          candles[1].epoch = candles[0].epoch;
        },
        pattern: /not strictly greater than the previous epoch/,
      },
      {
        label: 'confirming epoch not the last candle',
        mutate: (f) => {
          f.confirmingCandleEpoch = (f.confirmingCandleEpoch as number) + 60;
        },
        pattern: /must equal the last candle epoch/,
      },
      {
        label: 'non-genuine decision',
        mutate: (f) => {
          (f.signal as Record<string, unknown>).decision = 'NO_TRADE';
        },
        pattern: /decision must be LONG or SHORT/,
      },
      {
        label: 'unknown signal field',
        mutate: (f) => {
          (f.signal as Record<string, unknown>).evil = 1;
        },
        pattern: /signal has unexpected field/,
      },
      {
        label: 'missing required signal field',
        mutate: (f) => {
          delete (f.signal as Record<string, unknown>).entry;
        },
        pattern: /signal is missing field 'entry'/,
      },
      {
        label: 'signal signalId divergence',
        mutate: (f) => {
          (f.signal as Record<string, unknown>).signalId = 'EURUSD:1m:other:zone';
        },
        pattern: /does not match fixture.signalId/,
      },
    ];

    for (const deviation of deviations) {
      const forged = clone(constructedFixtureDouble()) as unknown as Record<string, unknown>;
      deviation.mutate(forged);
      writeFileSync(join(dir, 'forged.json'), JSON.stringify(forged), 'utf8');
      assert.throws(
        () => loadGenuineFixtures(dir),
        deviation.pattern,
        `deviation must be rejected: ${deviation.label}`
      );
      rmSync(join(dir, 'forged.json'));
    }

    // Cleanup safety: the suite left no residue and never touched the genuine dir.
    assert.deepEqual(readdirSync(dir), [], 'temp dir must be clean after the run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
