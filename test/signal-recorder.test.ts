/**
 * Phase 2B Stage 3 — genuine-signal fixture recorder suite (SA 1-10).
 *
 * Proves the recorder is inert by default, opt-in and development-only through
 * the environment, and fail-closed on every gate: detection verdicts, manual
 * test events, identity cross-checks, confirming-candle agreement, candle-input
 * validity, sink/observer failures, and file persistence (exclusive write, no
 * overwrite, no temp residue). The success path asserts a schema-valid,
 * allow-listed, deep-copied fixture with an injected clock.
 *
 * Safety: every persistent write in this suite happens in an OS temp directory;
 * `test/fixtures/genuine/` is never created or modified here (asserted).
 * All positive candidates use the labeled constructed-analysis test doubles —
 * SYNTHETIC inputs, real engine/detector/recorder/core underneath. Nothing here
 * is genuine recorded market data and nothing here may be described as such.
 *
 * SA9/SA10 are source scans with explicit needles and non-vacuity counts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  acceptedDetectionFor,
  bearZigZag,
  constructedFixtureDouble,
  constructedLongSignal,
  constructedLongSmcEngine,
  flatSeries,
  memorySink,
  validateFixture,
} from './signal-replay-harness';
import {
  SignalRecorder,
  GENUINE_FIXTURE_KIND,
  GENUINE_FIXTURE_VERSION,
  type RecordingSink,
  type SignalRecordingAttempt,
  type SignalRecordingInput,
} from '../lib/monitoring/signal-recorder';
import {
  DEFAULT_FIXTURE_DIR,
  FileFixtureSink,
  RECORD_FIXTURE_ENV,
  createSignalRecorderFromEnv,
  describeFixtureRecording,
  fixtureFileName,
  isFixtureRecordingEnabled,
} from '../lib/monitoring/signal-recorder-file';
import { MonitoringCore } from '../lib/monitoring/headless-core';
import { CandleManager, type Candle } from '../lib/deriv/candles';
import type { SignalOutput } from '../lib/signals/signal-engine';

const SYMBOL = 'EURUSD';
const TF = '1m' as const;
/** Last closed-candle epoch of the constructed positive pair (SYNTHETIC). */
const EPOCH = 1_700_000_040;

/** A fully valid recording input: accepted detection + 30 ordered closed candles. */
function baseInput(): SignalRecordingInput {
  const signal = constructedLongSignal(SYMBOL, TF, EPOCH, 1.1);
  return {
    detection: acceptedDetectionFor(signal, SYMBOL, TF, EPOCH),
    symbolId: SYMBOL,
    timeframe: TF,
    confirmingCandleEpoch: EPOCH,
    candles: flatSeries(EPOCH, 1.1, 30),
  };
}

/** Assert one recorded attempt is the expected refusal and carries no fixture. */
function assertRefusal(
  recorder: SignalRecorder,
  input: SignalRecordingInput,
  reason: string
): SignalRecordingAttempt {
  const attempt = recorder.record(input);
  assert.equal(
    attempt.recorded,
    false,
    `expected refusal '${reason}' but recorder returned '${String(attempt.reason)}'`
  );
  assert.equal(attempt.reason, reason);
  assert.equal(attempt.fixture, null, `refusal '${reason}' must never carry a fixture`);
  return attempt;
}

/**
 * Next.js augments `ProcessEnv` with a required literal `NODE_ENV`, but real
 * process environments legitimately omit it (and these tests must exercise
 * exactly that) — a plain record cast is the honest representation of that.
 */
function asEnv(record: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return record as NodeJS.ProcessEnv;
}

test('SA1: inert by default — env flag off, factory returns null, no report carries a recording field', () => {
  // Environment side: disabled everywhere by default (tests, build, dashboard).
  assert.equal(RECORD_FIXTURE_ENV, 'SMC_RECORD_SIGNAL_FIXTURE');
  assert.equal(isFixtureRecordingEnabled(asEnv({})), false);
  assert.equal(createSignalRecorderFromEnv(asEnv({})), null);
  const disabled = describeFixtureRecording(asEnv({}));
  assert.ok(
    disabled.startsWith(`disabled (set ${RECORD_FIXTURE_ENV}=1`),
    `unexpected default status: ${disabled}`
  );

  // Core side: without an injected recorder NO report ever carries the field —
  // neither for an honestly rejected evaluation nor for an accepted one.
  const rejectedCore = new MonitoringCore({ candleManager: new CandleManager(64) });
  rejectedCore.ingestClosedCandles(SYMBOL, TF, bearZigZag());
  const rejected = rejectedCore.evaluatePair(SYMBOL, TF);
  assert.equal(rejected.detection.accepted, false, 'bearZigZag must be honestly rejected');
  assert.equal('recording' in rejected, false, 'no recording field without an injected recorder');

  const acceptedCore = new MonitoringCore({
    candleManager: new CandleManager(64),
    smcEngine: constructedLongSmcEngine(),
  });
  acceptedCore.ingestClosedCandles(SYMBOL, TF, flatSeries(EPOCH, 1.1, 30));
  const accepted = acceptedCore.evaluatePair(SYMBOL, TF);
  assert.equal(accepted.detection.accepted, true, 'positive control must be accepted');
  assert.equal(
    'recording' in accepted,
    false,
    'even accepted evaluations carry no recording field by default'
  );
});

test("SA2: env flag matrix — exact '1'/'true' only, production always disabled, describe statuses", () => {
  const cases: Array<[Record<string, string | undefined>, boolean]> = [
    [{}, false],
    [{ [RECORD_FIXTURE_ENV]: '1' }, true],
    [{ [RECORD_FIXTURE_ENV]: 'true' }, true],
    [{ [RECORD_FIXTURE_ENV]: 'TRUE' }, false],
    [{ [RECORD_FIXTURE_ENV]: 'Yes' }, false],
    [{ [RECORD_FIXTURE_ENV]: 'yes' }, false],
    [{ [RECORD_FIXTURE_ENV]: 'on' }, false],
    [{ [RECORD_FIXTURE_ENV]: '0' }, false],
    [{ [RECORD_FIXTURE_ENV]: '' }, false],
    [{ [RECORD_FIXTURE_ENV]: '1 ' }, false],
    [{ [RECORD_FIXTURE_ENV]: ' 1' }, false],
    [{ [RECORD_FIXTURE_ENV]: '1', NODE_ENV: 'development' }, true],
    [{ [RECORD_FIXTURE_ENV]: 'true', NODE_ENV: 'test' }, true],
    [{ [RECORD_FIXTURE_ENV]: '1', NODE_ENV: 'production' }, false],
    [{ [RECORD_FIXTURE_ENV]: 'true', NODE_ENV: 'production' }, false],
    [{ NODE_ENV: 'production' }, false],
  ];
  for (const [env, expected] of cases) {
    const label = JSON.stringify(env);
    assert.equal(isFixtureRecordingEnabled(asEnv(env)), expected, `enablement mismatch for ${label}`);
    const built = createSignalRecorderFromEnv(asEnv(env), { sink: memorySink() });
    assert.equal(built !== null, expected, `factory mismatch for ${label}`);
  }

  // Enabled factory default builds a real recorder, with NO I/O at construction.
  const genuineBefore = existsSync(DEFAULT_FIXTURE_DIR);
  const enabledRecorder = createSignalRecorderFromEnv(asEnv({ [RECORD_FIXTURE_ENV]: '1' }));
  assert.ok(enabledRecorder instanceof SignalRecorder, 'flag must build a recorder');
  assert.equal(
    existsSync(DEFAULT_FIXTURE_DIR),
    genuineBefore,
    'constructing the default recorder must perform no I/O'
  );
  assert.equal(
    createSignalRecorderFromEnv(
      { [RECORD_FIXTURE_ENV]: '1', NODE_ENV: 'production' },
      { sink: memorySink() }
    ),
    null,
    'production must never build a recorder even with the flag set'
  );

  // Status strings.
  const prodStatus = describeFixtureRecording({
    [RECORD_FIXTURE_ENV]: '1',
    NODE_ENV: 'production',
  });
  assert.ok(prodStatus.includes('never enabled in production'), prodStatus);
  const enabledStatus = describeFixtureRecording(asEnv({ [RECORD_FIXTURE_ENV]: '1' }));
  assert.ok(enabledStatus.startsWith('ENABLED'), enabledStatus);
  assert.ok(enabledStatus.includes(DEFAULT_FIXTURE_DIR), enabledStatus);
});

test('SA3: detection gates — invalid, rejected, missing-event and core-level not-accepted', () => {
  const sink = memorySink();
  const recorder = new SignalRecorder({ sink, source: 'sa3' });

  assertRefusal(
    recorder,
    { ...baseInput(), detection: null } as unknown as SignalRecordingInput,
    'invalid-detection'
  );
  assertRefusal(
    recorder,
    {
      ...baseInput(),
      detection: { accepted: 'yes', reason: 'accepted', event: null },
    } as unknown as SignalRecordingInput,
    'invalid-detection'
  );
  assertRefusal(
    recorder,
    { ...baseInput(), detection: { accepted: false, reason: 'duplicate', event: null } },
    'detection-rejected:duplicate'
  );
  assertRefusal(
    recorder,
    { ...baseInput(), detection: { accepted: false, reason: 'epoch-mismatch', event: null } },
    'detection-rejected:epoch-mismatch'
  );
  assertRefusal(
    recorder,
    { ...baseInput(), detection: { accepted: true, reason: 'accepted', event: null } },
    'missing-event'
  );
  assert.equal(sink.written.length, 0, 'no refused input may reach the sink');

  // Core level: recorder injected, evaluation NOT accepted -> the core reports
  // not-accepted WITHOUT ever invoking the recorder.
  const attempts: SignalRecordingAttempt[] = [];
  const core = new MonitoringCore({
    candleManager: new CandleManager(64),
    recorder: new SignalRecorder({ sink, onAttempt: (attempt) => attempts.push(attempt) }),
  });
  core.ingestClosedCandles(SYMBOL, TF, bearZigZag());
  const report = core.evaluatePair(SYMBOL, TF);
  assert.equal(report.detection.accepted, false);
  assert.deepEqual(report.recording, { recorded: false, reason: 'not-accepted', fixture: null });
  assert.equal(attempts.length, 0, 'core must not invoke the recorder for a rejected evaluation');
  assert.equal(sink.written.length, 0, 'rejected evaluation must write nothing');
});

test('SA4: test events, NO_TRADE and null signals are never recorded', () => {
  const sink = memorySink();
  const recorder = new SignalRecorder({ sink, source: 'sa4' });

  // Manual notification test (isTest) — never a genuine signal, even when the
  // carried signal itself would qualify.
  const testEvent = baseInput();
  assert.ok(testEvent.detection.event !== null);
  testEvent.detection.event.isTest = true;
  assertRefusal(recorder, testEvent, 'test-event');

  // NO_TRADE carried inside an accepted-shaped event.
  const noTrade = baseInput();
  assert.ok(noTrade.detection.event !== null);
  (noTrade.detection.event.signal as unknown as { decision: string }).decision = 'NO_TRADE';
  assertRefusal(recorder, noTrade, 'not-generated');

  // Null signal.
  const nullSignal = baseInput();
  assert.ok(nullSignal.detection.event !== null);
  nullSignal.detection.event.signal = null as unknown as SignalOutput;
  assertRefusal(recorder, nullSignal, 'not-generated');

  assert.equal(sink.written.length, 0, 'none of these may reach the sink');
});

test('SA5: identity gates — missing identity, mismatched identity, wrong pair, wrong prefix', () => {
  const sink = memorySink();
  const recorder = new SignalRecorder({ sink, source: 'sa5' });

  const missing = baseInput();
  assert.ok(missing.detection.event !== null);
  missing.detection.event.signal.signalId = '';
  assertRefusal(recorder, missing, 'missing-identity');

  const mismatch = baseInput();
  assert.ok(mismatch.detection.event !== null);
  mismatch.detection.event.signalId = 'EURUSD:1m:other:zone';
  assertRefusal(recorder, mismatch, 'identity-mismatch');

  const wrongEventPair = baseInput();
  assert.ok(wrongEventPair.detection.event !== null);
  wrongEventPair.detection.event.pairKey = 'GBPUSD:1m';
  assertRefusal(recorder, wrongEventPair, 'pair-mismatch');

  const wrongEvaluatedPair = baseInput();
  wrongEvaluatedPair.symbolId = 'GBPUSD';
  assertRefusal(recorder, wrongEvaluatedPair, 'pair-mismatch');

  const wrongEventSymbol = baseInput();
  assert.ok(wrongEventSymbol.detection.event !== null);
  wrongEventSymbol.detection.event.symbolId = 'GBPUSD';
  assertRefusal(recorder, wrongEventSymbol, 'identity-pair-mismatch');

  const wrongEventTf = baseInput();
  assert.ok(wrongEventTf.detection.event !== null);
  wrongEventTf.detection.event.timeframe = '5m';
  assertRefusal(recorder, wrongEventTf, 'identity-pair-mismatch');

  const wrongPrefix = baseInput();
  assert.ok(wrongPrefix.detection.event !== null);
  wrongPrefix.detection.event.signal.signalId = 'GBPUSD:1m:trig-long:zone-long';
  wrongPrefix.detection.event.signalId = 'GBPUSD:1m:trig-long:zone-long';
  assertRefusal(recorder, wrongPrefix, 'identity-pair-mismatch');

  assert.equal(sink.written.length, 0, 'identity deviations must never reach the sink');
});

test('SA6: confirming-candle and signal-epoch gates', () => {
  const sink = memorySink();
  const recorder = new SignalRecorder({ sink, source: 'sa6' });

  assertRefusal(recorder, { ...baseInput(), confirmingCandleEpoch: null }, 'confirming-mismatch');
  assertRefusal(
    recorder,
    { ...baseInput(), confirmingCandleEpoch: Number.NaN },
    'confirming-mismatch'
  );
  assertRefusal(
    recorder,
    { ...baseInput(), confirmingCandleEpoch: Number.POSITIVE_INFINITY },
    'confirming-mismatch'
  );
  assertRefusal(
    recorder,
    { ...baseInput(), confirmingCandleEpoch: EPOCH - 60 },
    'signal-epoch-mismatch'
  );
  assert.equal(sink.written.length, 0, 'epoch deviations must never reach the sink');
});

test('SA7: candle input gates — empty, oversized, open, invalid, unordered, mismatched', () => {
  const sink = memorySink();
  const recorder = new SignalRecorder({ sink, source: 'sa7' });

  assertRefusal(recorder, { ...baseInput(), candles: [] }, 'empty-input');
  assertRefusal(
    recorder,
    { ...baseInput(), candles: flatSeries(EPOCH - 60, 1.1, 30) },
    'confirming-candle-mismatch'
  );

  const open = baseInput();
  (open.candles as Candle[])[0].isClosed = false;
  assertRefusal(recorder, open, 'incomplete-candle');

  const fractional = baseInput();
  (fractional.candles as Candle[])[0].epoch = 1.5;
  assertRefusal(recorder, fractional, 'invalid-candle');

  const zeroEpoch = baseInput();
  (zeroEpoch.candles as Candle[])[0].epoch = 0;
  assertRefusal(recorder, zeroEpoch, 'invalid-candle');

  const brokenOhlc = baseInput();
  (brokenOhlc.candles as Candle[])[4].high = brokenOhlc.candles[4].close - 0.01;
  assertRefusal(recorder, brokenOhlc, 'invalid-candle');

  const duplicateEpoch = baseInput();
  (duplicateEpoch.candles as Candle[])[1].epoch = duplicateEpoch.candles[0].epoch;
  assertRefusal(recorder, duplicateEpoch, 'unordered-input');

  const descending = baseInput();
  (descending.candles as Candle[])[2].epoch = descending.candles[1].epoch - 60;
  assertRefusal(recorder, descending, 'unordered-input');

  const capped = new SignalRecorder({ sink, source: 'sa7-cap', maxCandles: 5 });
  assertRefusal(capped, baseInput(), 'input-too-large');

  assert.equal(sink.written.length, 0, 'no malformed input may reach the sink');
});

test('SA7b: sink and observer failures fail closed and never break the pipeline', () => {
  // No sink: the fixture is built but handed nowhere.
  assertRefusal(new SignalRecorder({ source: 'sa7b' }), baseInput(), 'no-sink');

  // Throwing sink -> single-line sanitized write-failed, no fixture returned.
  const multiLine: RecordingSink = {
    writeFixture() {
      throw new Error('disk\n  full   while   writing');
    },
  };
  const failed = assertRefusal(
    new SignalRecorder({ sink: multiLine }),
    baseInput(),
    'write-failed:disk full while writing'
  );
  assert.ok(!(failed.reason as string).includes('\n'), 'reason must be single-line');

  // Overlong messages are truncated.
  const long: RecordingSink = {
    writeFixture() {
      throw new Error('x'.repeat(500));
    },
  };
  assertRefusal(
    new SignalRecorder({ sink: long }),
    baseInput(),
    `write-failed:${'x'.repeat(200)}`
  );

  // Non-Error throws are stringified.
  const nonError: RecordingSink = {
    writeFixture() {
      throw 'plain failure';
    },
  };
  assertRefusal(new SignalRecorder({ sink: nonError }), baseInput(), 'write-failed:plain failure');

  // record() itself never throws.
  const boom = new SignalRecorder({ sink: memorySink() }).record(
    null as unknown as SignalRecordingInput
  );
  assert.equal(boom.recorded, false);
  assert.equal(boom.reason, 'recorder-error:TypeError');
  assert.equal(boom.fixture, null);

  // A throwing observer must never break a successful recording.
  const observerSink = memorySink();
  const observed = new SignalRecorder({
    sink: observerSink,
    onAttempt: () => {
      throw new Error('observer boom');
    },
  });
  const observedAttempt = observed.record(baseInput());
  assert.equal(observedAttempt.recorded, true, 'a throwing observer must not break recording');
  assert.equal(observerSink.written.length, 1);

  // The observer sees every attempt — same object references that were returned.
  const seen: SignalRecordingAttempt[] = [];
  const watched = new SignalRecorder({
    sink: memorySink(),
    onAttempt: (attempt) => seen.push(attempt),
  });
  const okAttempt = watched.record(baseInput());
  const refusedAttempt = watched.record({ ...baseInput(), candles: [] });
  assert.equal(seen.length, 2, 'observer must see success and refusal');
  assert.equal(seen[0], okAttempt);
  assert.equal(seen[1], refusedAttempt);
});

test('SA8: success path — schema-valid allow-listed fixture, injected clock, deep-copy immutability', () => {
  const sink = memorySink();
  const recorder = new SignalRecorder({
    sink,
    source: 'sa8-source',
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  });
  const input = baseInput();
  const event = input.detection.event;
  assert.ok(event !== null);

  // Extraneous fields that MUST be dropped by the allow-list copy.
  (event.signal as unknown as Record<string, unknown>).evil = 1;
  (input.candles[0] as unknown as Record<string, unknown>).evil = 2;
  const originalClose = input.candles[0].close;

  const attempt = recorder.record(input);
  assert.equal(
    attempt.recorded,
    true,
    `record must succeed (refused: ${String(attempt.reason)})`
  );
  assert.equal(attempt.reason, null);
  const fixture = attempt.fixture;
  assert.ok(fixture !== null);
  assert.equal(sink.written.length, 1, 'exactly one fixture written');
  assert.equal(sink.written[0], fixture, 'the sink received exactly the returned fixture');

  // Schema round-trip through the strict validator.
  validateFixture(fixture, 'sa8-success');

  // Metadata: labels and clock are explicit; identity/epoch are the pipeline's own.
  assert.equal(fixture.fixtureKind, GENUINE_FIXTURE_KIND);
  assert.equal(fixture.fixtureVersion, GENUINE_FIXTURE_VERSION);
  assert.equal(fixture.source, 'sa8-source');
  assert.equal(fixture.recordedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(fixture.symbolId, SYMBOL);
  assert.equal(fixture.timeframe, TF);
  assert.equal(fixture.pairKey, `${SYMBOL}:${TF}`);
  assert.equal(fixture.confirmingCandleEpoch, EPOCH);
  assert.equal(fixture.candleCount, 30);
  assert.equal(fixture.candles.length, 30, 'candles are never truncated');
  assert.equal(fixture.signalId, fixture.signal.signalId);
  assert.ok(fixture.signalId.startsWith(`${SYMBOL}:${TF}:`));

  // Allow-list: no extraneous field survived on candles or signal
  // (validateFixture would throw on any unknown key — it just passed).
  assert.equal('evil' in fixture.candles[0], false, 'candle allow-list must drop extras');
  assert.equal('evil' in fixture.signal, false, 'signal allow-list must drop extras');

  // Deep copy: mutating the inputs afterwards must not touch the fixture.
  input.candles[0].close = 999;
  event.signal.entry = 999;
  event.signal.signalId = 'EURUSD:1m:tampered:tampered';
  assert.ok(fixture.candles[0] !== input.candles[0], 'candles must be deep-copied');
  assert.equal(fixture.candles[0].close, originalClose, 'fixture candle must not alias input');
  assert.notEqual(fixture.signal.entry, 999, 'fixture signal must not alias input');
  assert.ok(
    fixture.signal.signalId !== 'EURUSD:1m:tampered:tampered',
    'fixture signalId must not alias input'
  );
  validateFixture(fixture, 'sa8-after-input-mutation');
});

test('SA8b: FileFixtureSink — exclusive write, no overwrite, no temp residue (OS temp dir only)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smc-file-sink-'));
  const genuineBefore = existsSync(DEFAULT_FIXTURE_DIR);
  try {
    const fixture = constructedFixtureDouble();
    const sink = new FileFixtureSink(dir);

    sink.writeFixture(fixture);
    const name = fixtureFileName(fixture);
    assert.equal(name, `signal-${SYMBOL}-${TF}-${EPOCH}.json`);
    assert.deepEqual(readdirSync(dir), [name], 'exactly one fixture file and no temp residue');
    const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    validateFixture(parsed, name);

    // An existing fixture always wins.
    assert.throws(() => sink.writeFixture(fixture), /fixture already exists/);
    assert.equal(readdirSync(dir).length, 1, 'refused overwrite must add nothing');

    // Through the recorder the same refusal surfaces as write-failed.
    const attempt = new SignalRecorder({ sink }).record(baseInput());
    assert.equal(attempt.recorded, false);
    assert.equal(attempt.reason, `write-failed:fixture already exists: ${name}`);
    assert.equal(readdirSync(dir).length, 1, 'failed write must leave the directory unchanged');

    // Filename sanitization: path separators never reach the name.
    assert.equal(
      fixtureFileName({ symbolId: 'A/B', timeframe: '1m', confirmingCandleEpoch: 42 }),
      'signal-A_B-1m-42.json'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(
    existsSync(DEFAULT_FIXTURE_DIR),
    genuineBefore,
    'tests must never create or modify the genuine fixture directory'
  );
});

test('SA9: live diagnostic is the sole env-driven entry point (needle scan of one file)', () => {
  const source = readFileSync(join('test', 'monitoring-live-diagnostic.ts'), 'utf8');
  const needles = [
    'createSignalRecorderFromEnv(process.env',
    'describeFixtureRecording(process.env)',
    'Fixture recording: ',
    'fixture recordings',
    'recorder: recorder ?? undefined',
    RECORD_FIXTURE_ENV,
    "from '../lib/monitoring/signal-recorder-file'",
  ];
  for (const needle of needles) {
    assert.ok(source.includes(needle), `diagnostic must contain needle: ${needle}`);
  }
});

test('SA10: dashboard sources contain zero recorder references (recursive scan, non-vacuous)', () => {
  const filesByRoot = new Map<string, string[]>();
  const walk = (dir: string, into: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, into);
      } else if (/\.tsx?$/.test(entry.name)) {
        into.push(full);
      }
    }
  };
  for (const root of ['app', 'components', 'hooks', 'lib']) {
    assert.ok(existsSync(root), `scan root must exist: ${root}`);
    const files: string[] = [];
    walk(root, files);
    assert.ok(files.length > 0, `scan root must be non-vacuous: ${root}`);
    filesByRoot.set(root, files);
  }

  const offenders: string[] = [];
  for (const files of filesByRoot.values()) {
    for (const file of files) {
      const rel = file.split(sep).join('/');
      if (rel.startsWith('lib/monitoring/')) continue; // the recorder's own module home
      const content = readFileSync(file, 'utf8');
      if (content.includes('signal-recorder') || content.includes(RECORD_FIXTURE_ENV)) {
        offenders.push(rel);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'no dashboard source may reference the recorder or its env flag'
  );

  // Within lib, ONLY the file-sink module may mention the env flag.
  const flagFiles = (filesByRoot.get('lib') ?? [])
    .map((file) => file.split(sep).join('/'))
    .filter((rel) => readFileSync(rel, 'utf8').includes(RECORD_FIXTURE_ENV));
  assert.deepEqual(
    flagFiles,
    ['lib/monitoring/signal-recorder-file.ts'],
    'the env flag must live only in the file sink module'
  );
});
