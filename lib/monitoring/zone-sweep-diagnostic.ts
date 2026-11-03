/**
 * Runner-only, strictly observational zone / liquidity-sweep diagnostic (Phase 2B).
 *
 * This module only FORMATS data that an evaluation has already produced. It reads
 * no candles, re-analyzes nothing, initiates no market request, and returns only a
 * string plus a classification. It is imported solely by the manually-launched live
 * diagnostic runner (`test/monitoring-live-diagnostic.ts`); ordinary application
 * operation never imports it.
 *
 * Every value is derived with the EXISTING pure SignalEngine helpers
 * (`isZoneFresh`, `isSweepInFreshnessWindow`, `selectLatestActionableBreak`,
 * `resolveDirectionalContext`) using the configuration the engine itself uses.
 * Nothing here feeds back into any decision, and a formatting failure can never
 * alter a signal result: the runner contains any thrown error.
 */

import { TIMEFRAME_SECONDS } from '../deriv/candles';
import type { Timeframe } from '../deriv/candles';
import type { StructuralBias } from '../analysis/market-structure';
import type { PremiumDiscountZone } from '../analysis/smc';
import type { StructureBreak } from '../analysis/structure-breaks';
import type { LiquidityLevel } from '../analysis/liquidity';
import {
  DEFAULT_SIGNAL_ENGINE_CONFIG,
  isZoneFresh,
  isSweepInFreshnessWindow,
  selectLatestActionableBreak,
  resolveDirectionalContext,
} from '../signals/signal-engine';
import type { ZoneCandidate, SignalDirection, SignalRejectionCode } from '../signals/signal-engine';

export type ZoneSweepClassification = 'OBSERVED' | 'DIAGNOSTIC_UNAVAILABLE';

export interface ZoneSweepDiagnostic {
  message: string;
  classification: ZoneSweepClassification;
}

/** One swept opposing level, as observed (never recomputed). */
export interface SweepObservation {
  sweptEpoch: number;
  /** Age in analysis-timeframe bars, or `null` when the signal epoch is unknown. */
  ageBars: number | null;
  /** Passes `isSweepInFreshnessWindow` for the signal epoch. */
  fresh: boolean;
  /** `sweptEpoch <= trigger.confirmedAtEpoch`; `null` when no trigger epoch is known. */
  onOrBeforeTrigger: boolean | null;
  /** True only when this sweep would satisfy the engine's sweep gate for this setup. */
  qualifies: boolean;
}

/**
 * Narrow input built by the runner from an evaluation report. `zones` and
 * `opposingLevels` are the ALREADY-flattened candidates/levels the engine uses
 * (`collectZones` / `opposingLiquidityLevels`); the runner must not re-derive them.
 */
export interface ZoneSweepDiagnosticInput {
  pairKey: string;
  signalEpoch: number | null;
  timeframe: Timeframe;
  zone: PremiumDiscountZone;
  structuralBias: StructuralBias;
  breaks: readonly StructureBreak[];
  direction: SignalDirection | null;
  zones: readonly ZoneCandidate[];
  opposingLevels: readonly LiquidityLevel[];
  rejectionReasons?: readonly SignalRejectionCode[];
}

/** Renders the `[zone]` field list with an explicit unavailability reason. */
export function unavailableZoneSweep(
  pairKey: string,
  signalEpoch: number | null,
  reason: string
): ZoneSweepDiagnostic {
  return {
    classification: 'DIAGNOSTIC_UNAVAILABLE',
    message:
      `${pairKey} epoch=${signalEpoch ?? 'none'} zone=n/a bias=n/a dir=n/a setup=n/a ` +
      `alignedFreshZones=n/a sweepSide=n/a oppLevels=n/a swept=n/a freshSweeps=n/a ` +
      `qualifying=n/a sweeps=[] reasons=n/a class=DIAGNOSTIC_UNAVAILABLE reason=${reason}`,
  };
}

function formatBars(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * Builds one `[zone]` record from the inputs an evaluation already produced. Any
 * field that cannot be established is reported as `n/a`; malformed input is
 * reported as `DIAGNOSTIC_UNAVAILABLE` rather than guessed. Pure and side-effect free.
 */
export function describeZoneSweep(input: ZoneSweepDiagnosticInput): ZoneSweepDiagnostic {
  const signalEpoch = input.signalEpoch;

  if (
    !Array.isArray(input.breaks) ||
    !Array.isArray(input.zones) ||
    !Array.isArray(input.opposingLevels)
  ) {
    return unavailableZoneSweep(input.pairKey, signalEpoch, 'missing-input');
  }

  const config = DEFAULT_SIGNAL_ENGINE_CONFIG;
  const trigger = selectLatestActionableBreak(input.breaks);
  const context = resolveDirectionalContext(trigger, input.structuralBias);
  const setup = context.setup;
  const requireOnOrBeforeTrigger = setup === 'SWEEP_REVERSAL' && trigger !== null;
  const triggerEpoch = trigger !== null ? trigger.confirmedAtEpoch : null;

  const secondsPerBar = TIMEFRAME_SECONDS[input.timeframe];
  const validSeconds = Number.isFinite(secondsPerBar) && secondsPerBar > 0;

  const alignedFreshZones: number | null =
    input.direction !== null && signalEpoch !== null
      ? input.zones.filter(
          (z) =>
            z.direction === input.direction &&
            z.usable &&
            isZoneFresh(z.epoch, signalEpoch, input.timeframe, config)
        ).length
      : null;

  const sweepSide: 'BUY_SIDE' | 'SELL_SIDE' | null =
    input.direction === null ? null : input.direction === 'BULLISH' ? 'SELL_SIDE' : 'BUY_SIDE';

  const sweptLevels = input.opposingLevels.filter((l) => l.swept);
  const freshSweepCount: number | null =
    signalEpoch !== null
      ? input.opposingLevels.filter((l) =>
          isSweepInFreshnessWindow(l, signalEpoch, input.timeframe, config)
        ).length
      : null;

  const sweeps: SweepObservation[] = [];
  for (const level of sweptLevels) {
    if (level.sweptEpoch === undefined) continue;
    const fresh =
      signalEpoch !== null &&
      isSweepInFreshnessWindow(level, signalEpoch, input.timeframe, config);
    const ageBars =
      signalEpoch !== null && validSeconds
        ? (signalEpoch - level.sweptEpoch) / secondsPerBar
        : null;
    const onOrBeforeTrigger = triggerEpoch !== null ? level.sweptEpoch <= triggerEpoch : null;
    const qualifies = fresh && (!requireOnOrBeforeTrigger || onOrBeforeTrigger === true);
    sweeps.push({ sweptEpoch: level.sweptEpoch, ageBars, fresh, onOrBeforeTrigger, qualifies });
  }
  sweeps.sort((a, b) => b.sweptEpoch - a.sweptEpoch);

  const qualifying = sweeps.filter((s) => s.qualifies).length;

  const shown = sweeps
    .slice(0, 5)
    .map(
      (s) =>
        `${s.sweptEpoch}(age=${s.ageBars === null ? 'n/a' : formatBars(s.ageBars)},` +
        `fresh=${s.fresh},beforeTrigger=${s.onOrBeforeTrigger === null ? 'n/a' : s.onOrBeforeTrigger})`
    );
  if (sweeps.length > shown.length) shown.push(`+${sweeps.length - shown.length} more`);
  const sweepList = shown.length === 0 ? 'none' : shown.join(' ');

  const reasons =
    input.rejectionReasons !== undefined && input.rejectionReasons.length > 0
      ? input.rejectionReasons.join(',')
      : 'none';

  const parts = [
    `${input.pairKey} epoch=${signalEpoch ?? 'none'}`,
    `zone=${input.zone}`,
    `bias=${input.structuralBias}`,
    `dir=${input.direction ?? 'n/a'}`,
    `setup=${setup}`,
    `alignedFreshZones=${alignedFreshZones ?? 'n/a'}`,
    `sweepSide=${sweepSide ?? 'n/a'}`,
    `oppLevels=${input.opposingLevels.length}`,
    `swept=${sweptLevels.length}`,
    `freshSweeps=${freshSweepCount ?? 'n/a'}`,
    `qualifying=${qualifying}`,
    `sweeps=[${sweepList}]`,
    `reasons=[${reasons}]`,
    'class=OBSERVED',
  ];

  return { classification: 'OBSERVED', message: parts.join(' ') };
}
