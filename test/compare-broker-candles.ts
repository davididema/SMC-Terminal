/**
 * Offline broker candle comparison CLI (Phase 6).
 *
 * Reads two caller-supplied CSV exports (one Deriv reference, one HFM/MT5
 * export), validates them, and prints/writes a comparison report.
 *
 * This script performs NO network access and opens NO WebSocket. It does not
 * modify any application or live market-data code.
 *
 * Usage:
 *   npx tsx test/compare-broker-candles.ts \
 *     --deriv <path.csv> --deriv-tz <utc|server:<offsetSeconds>|unknown> \
 *     [--hfm <path.csv> --hfm-tz <...>] \
 *     [--symbol XAUUSD] [--timeframe 15m] \
 *     [--price-tolerance 0.05] [--structure-tolerance 0.10] \
 *     [--investigate-offset] [--out <report.json>]
 *
 * If --hfm is omitted (or its file is missing) the report verdict is NOT_RUN.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  compareBrokerCandles,
  DEFAULT_MIN_SAMPLES_FOR_DISTRIBUTION,
  normalizeTimeframe,
  parseConventionArg,
  parseCsvText,
  renderHumanSummary,
  type DatasetSummary,
  type TimestampConvention,
} from './comparison-lib';

interface CliArgs {
  deriv?: string;
  hfm?: string;
  derivTz?: TimestampConvention;
  hfmTz?: TimestampConvention;
  symbol?: string;
  timeframe?: string;
  priceTolerance?: number;
  structureTolerance?: number;
  minSamples?: number;
  investigateOffset: boolean;
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { investigateOffset: false, out: 'broker-comparison-report.json' };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${token}`);
      }
      i += 1;
      return value;
    };

    switch (token) {
      case '--deriv':
        args.deriv = next();
        break;
      case '--hfm':
        args.hfm = next();
        break;
      case '--deriv-tz':
        args.derivTz = parseConventionArg(next());
        break;
      case '--hfm-tz':
        args.hfmTz = parseConventionArg(next());
        break;
      case '--symbol':
        args.symbol = next();
        break;
      case '--timeframe':
        args.timeframe = next();
        break;
      case '--price-tolerance':
        args.priceTolerance = Number(next());
        break;
      case '--structure-tolerance':
        args.structureTolerance = Number(next());
        break;
      case '--min-samples':
        args.minSamples = Number(next());
        break;
      case '--investigate-offset':
        args.investigateOffset = true;
        break;
      case '--out':
        args.out = next();
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (args.deriv === undefined) {
    throw new Error('Missing required --deriv <path.csv>.');
  }
  if (args.derivTz === undefined) {
    throw new Error('Missing required --deriv-tz. Timestamps are never assumed to be UTC.');
  }
  if ((args.hfm !== undefined || args.hfmTz !== undefined) && (args.hfm === undefined || args.hfmTz === undefined)) {
    throw new Error('--hfm and --hfm-tz must be provided together.');
  }
  if (args.priceTolerance !== undefined && (!Number.isFinite(args.priceTolerance) || args.priceTolerance < 0)) {
    throw new Error('--price-tolerance must be a non-negative number.');
  }
  if (args.structureTolerance !== undefined && (!Number.isFinite(args.structureTolerance) || args.structureTolerance < 0)) {
    throw new Error('--structure-tolerance must be a non-negative number.');
  }
  return args;
}

function readIfExists(path: string | undefined): string | null {
  if (path === undefined) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Argument error: ${(error as Error).message}`);
    process.exitCode = 2;
    return;
  }

  const derivText = readIfExists(args.deriv);
  if (derivText === null) {
    console.error(`Cannot read deriv CSV at "${args.deriv}".`);
    process.exitCode = 2;
    return;
  }

  const deriv: DatasetSummary = parseCsvText(derivText, {
    sourceLabel: 'deriv',
    path: args.deriv,
    convention: args.derivTz as TimestampConvention,
  });

  const expectedTimeframe = args.timeframe !== undefined ? normalizeTimeframe(args.timeframe) : undefined;
  if (args.timeframe !== undefined && expectedTimeframe === null) {
    console.error(`Unrecognised --timeframe "${args.timeframe}".`);
    process.exitCode = 2;
    return;
  }

  let hfm: DatasetSummary | null = null;
  if (args.hfm !== undefined) {
    const hfmText = readIfExists(args.hfm);
    if (hfmText === null) {
      console.error(`HFM CSV at "${args.hfm}" could not be read; proceeding with a NOT_RUN report.`);
    } else {
      hfm = parseCsvText(hfmText, {
        sourceLabel: 'hfm',
        path: args.hfm,
        convention: args.hfmTz as TimestampConvention,
      });
    }
  }

  const report = compareBrokerCandles(deriv, hfm, {
    priceTolerance: args.priceTolerance,
    structureMatchTolerance: args.structureTolerance,
    minSamplesForDistribution: args.minSamples ?? DEFAULT_MIN_SAMPLES_FOR_DISTRIBUTION,
    expectedSymbol: args.symbol,
    expectedTimeframe: expectedTimeframe ?? undefined,
    investigateOffset: args.investigateOffset,
  });

  console.log(renderHumanSummary(report));
  try {
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nJSON report written to ${args.out}`);
  } catch (error) {
    console.error(`Could not write JSON report to "${args.out}": ${(error as Error).message}`);
    process.exitCode = 2;
  }
}

main();
