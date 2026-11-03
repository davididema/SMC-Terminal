/**
 * Opt-in, development-only file persistence for genuine-signal fixtures
 * (Phase 2B, Stage 3). This is the ONLY module in the project that writes
 * fixtures, and it writes nothing unless explicitly enabled:
 *
 * - `SMC_RECORD_SIGNAL_FIXTURE` must be exactly `1` or `true`, AND
 * - `NODE_ENV` must not be `production`.
 *
 * Nothing reads the flag during `next build`, `npm run test:all`, or dashboard
 * runtime — the only callers are the manual `npm run monitor:live` diagnostic
 * and tests that inject their own sink. Fixtures land in
 * `test/fixtures/genuine/` as `signal-<symbol>-<tf>-<epoch>.json` and are
 * never overwritten (temp write + exclusive copy; an existing fixture wins).
 */

import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  SignalRecorder,
  type GenuineSignalFixture,
  type RecordingSink,
  type SignalRecordingAttempt,
} from './signal-recorder';

/** Development-only enablement flag (see module doc for the exact rules). */
export const RECORD_FIXTURE_ENV = 'SMC_RECORD_SIGNAL_FIXTURE';
/** Destination of recorded fixtures (created on first write). */
export const DEFAULT_FIXTURE_DIR = join('test', 'fixtures', 'genuine');

/** `signal-<symbol>-<timeframe>-<confirmingEpoch>.json` (path-safe segments). */
export function fixtureFileName(
  fixture: Pick<GenuineSignalFixture, 'symbolId' | 'timeframe' | 'confirmingCandleEpoch'>
): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_');
  return `signal-${safe(fixture.symbolId)}-${safe(fixture.timeframe)}-${fixture.confirmingCandleEpoch}.json`;
}

/**
 * Writes fixtures to disk without ever overwriting an existing file: content
 * is first written to a unique temp file (`wx`), then copied with
 * `COPYFILE_EXCL`, then the temp file is removed. Any failure throws, which
 * the recorder converts into a `write-failed:*` refusal.
 */
export class FileFixtureSink implements RecordingSink {
  public readonly dir: string;

  constructor(dir: string = DEFAULT_FIXTURE_DIR) {
    this.dir = dir;
  }

  public writeFixture(fixture: GenuineSignalFixture): void {
    mkdirSync(this.dir, { recursive: true });

    const name = fixtureFileName(fixture);
    const target = join(this.dir, name);
    if (existsSync(target)) {
      throw new Error(`fixture already exists: ${name}`);
    }

    const payload = `${JSON.stringify(fixture, null, 2)}\n`;
    const temp = join(this.dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(temp, payload, { encoding: 'utf8', flag: 'wx' });
    try {
      copyFileSync(temp, target, fsConstants.COPYFILE_EXCL);
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        // Best-effort temp cleanup; the exclusive copy is what matters.
      }
    }
  }
}

export interface EnvRecorderOptions {
  /** Override the sink (tests use an in-memory sink; never the genuine dir). */
  sink?: RecordingSink;
  /** Override the fixture `source` label (metadata only). */
  source?: string;
  /** Observer passed through to the recorder. */
  onAttempt?: (attempt: SignalRecordingAttempt) => void;
}

/** True only when the env flag explicitly opts in AND the env is not production. */
export function isFixtureRecordingEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV === 'production') return false;
  const flag = env[RECORD_FIXTURE_ENV];
  return flag === '1' || flag === 'true';
}

/**
 * Build the development-only recorder from the environment, or `null` when
 * recording is not enabled (the default everywhere: tests, builds, dashboard).
 */
export function createSignalRecorderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: EnvRecorderOptions = {}
): SignalRecorder | null {
  if (!isFixtureRecordingEnabled(env)) return null;
  return new SignalRecorder({
    sink: options.sink ?? new FileFixtureSink(DEFAULT_FIXTURE_DIR),
    source: options.source ?? 'monitoring-live-diagnostic',
    onAttempt: options.onAttempt,
  });
}

/** One-line status for diagnostics/tests (never throws). */
export function describeFixtureRecording(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NODE_ENV === 'production') {
    return 'disabled (fixture recording is never enabled in production)';
  }
  if (!isFixtureRecordingEnabled(env)) {
    return `disabled (set ${RECORD_FIXTURE_ENV}=1 to record genuine fixtures)`;
  }
  return `ENABLED (accepted signals will be written to ${DEFAULT_FIXTURE_DIR})`;
}
