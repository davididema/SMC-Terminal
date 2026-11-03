import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeZoneSweep,
  unavailableZoneSweep,
  type ZoneSweepDiagnosticInput,
} from '../lib/monitoring/zone-sweep-diagnostic';
import type { ZoneCandidate } from '../lib/signals/signal-engine';
import type { LiquidityLevel } from '../lib/analysis/liquidity';
import type { StructureBreak, BreakType } from '../lib/analysis/structure-breaks';

// All inputs are SYNTHETIC constructed values (no genuine market data).
const TF = 60;
const SIG = 1_000_000;

function baseInput(overrides: Partial<ZoneSweepDiagnosticInput> = {}): ZoneSweepDiagnosticInput {
  return {
    pairKey: 'V75:1m',
    signalEpoch: SIG,
    timeframe: '1m',
    zone: 'PREMIUM',
    structuralBias: 'BEARISH',
    breaks: [],
    direction: 'BEARISH',
    zones: [],
    opposingLevels: [],
    ...overrides,
  };
}

function brk(
  type: BreakType,
  confirmedAtEpoch: number,
  breakCandleEpoch: number,
  id: string
): StructureBreak {
  return {
    id,
    type,
    symbol: 'V75',
    timeframe: '1m',
    breakCandleEpoch,
    brokenSwingEpoch: breakCandleEpoch - 100,
    brokenPrice: 1,
    confirmationPrice: 1,
    confirmedAtEpoch,
    direction: type.startsWith('BULLISH') ? 'BULLISH' : 'BEARISH',
    sourceStructure: 'NEUTRAL',
  };
}

function zone(
  id: string,
  direction: 'BULLISH' | 'BEARISH',
  zoneLower: number,
  zoneUpper: number,
  epoch: number,
  usable: boolean
): ZoneCandidate {
  return { id, kind: 'FVG', direction, zoneLower, zoneUpper, epoch, usable };
}

function level(
  id: string,
  type: 'BUY_SIDE' | 'SELL_SIDE',
  price: number,
  swept: boolean,
  sweptEpoch?: number
): LiquidityLevel {
  return { id, price, type, swept, epoch: 0, ...(sweptEpoch !== undefined ? { sweptEpoch } : {}) };
}

test('ZSD 1 — an OBSERVED line reports the actual zone and zero qualifying sweeps (synthetic)', () => {
  const d = describeZoneSweep(baseInput({ zone: 'EQUILIBRIUM' }));
  assert.equal(d.classification, 'OBSERVED');
  assert.match(d.message, /zone=EQUILIBRIUM/);
  assert.match(d.message, /dir=BEARISH/);
  assert.match(d.message, /qualifying=0/);
  assert.match(d.message, /class=OBSERVED/);
});

test('ZSD 2 — alignedFreshZones counts only fresh, usable, same-direction zones (synthetic)', () => {
  const d = describeZoneSweep(
    baseInput({
      zones: [
        zone('z1', 'BEARISH', 1.09, 1.1, SIG - 100, true),
        zone('z2', 'BEARISH', 1.08, 1.09, SIG - 3001, true),
        zone('z3', 'BULLISH', 1.09, 1.1, SIG - 100, true),
        zone('z4', 'BEARISH', 1.07, 1.08, SIG - 100, false),
      ],
    })
  );
  assert.match(d.message, /alignedFreshZones=1/);
});

test('ZSD 3 — a reversal sweep must be fresh AND on/before the CHoCH to qualify (synthetic)', () => {
  const trigger = brk('BEARISH_CHOCH', SIG - 2 * TF, SIG - 3 * TF, 'choch');
  const d = describeZoneSweep(
    baseInput({
      breaks: [trigger],
      opposingLevels: [
        level('a', 'BUY_SIDE', 1.2, true, SIG - 3 * TF),
        level('b', 'BUY_SIDE', 1.21, true, SIG - 20 * TF),
        level('c', 'BUY_SIDE', 1.22, true, SIG - 1 * TF),
        level('d', 'BUY_SIDE', 1.23, false),
      ],
    })
  );
  assert.match(d.message, /setup=SWEEP_REVERSAL/);
  assert.match(d.message, /sweepSide=BUY_SIDE/);
  assert.match(d.message, /oppLevels=4/);
  assert.match(d.message, /swept=3/);
  assert.match(d.message, /freshSweeps=2/);
  assert.match(d.message, /qualifying=1/);
});

test('ZSD 4 — an unresolved direction reports dependent fields as n/a (synthetic)', () => {
  const d = describeZoneSweep(baseInput({ direction: null }));
  assert.match(d.message, /dir=n\/a/);
  assert.match(d.message, /alignedFreshZones=n\/a/);
  assert.match(d.message, /sweepSide=n\/a/);
});

test('ZSD 5 — unavailableZoneSweep is explicitly classified and carries its reason (synthetic)', () => {
  const d = unavailableZoneSweep('V75:1m', null, 'no-closed-candles');
  assert.equal(d.classification, 'DIAGNOSTIC_UNAVAILABLE');
  assert.match(d.message, /epoch=none/);
  assert.match(d.message, /reason=no-closed-candles/);
});

test('ZSD 6 — malformed array input degrades to DIAGNOSTIC_UNAVAILABLE without throwing (synthetic)', () => {
  const bad = { ...baseInput(), zones: undefined } as unknown as ZoneSweepDiagnosticInput;
  const d = describeZoneSweep(bad);
  assert.equal(d.classification, 'DIAGNOSTIC_UNAVAILABLE');
  assert.match(d.message, /reason=missing-input/);
});

test('ZSD 7 — a fractional sweep age is formatted without pretending precision (synthetic)', () => {
  const trigger = brk('BEARISH_CHOCH', SIG - 2 * TF, SIG - 3 * TF, 'choch');
  const d = describeZoneSweep(
    baseInput({
      breaks: [trigger],
      opposingLevels: [level('a', 'BUY_SIDE', 1.2, true, SIG - 90)],
    })
  );
  assert.match(d.message, /age=1\.50/);
});

test('ZSD 8 — rejection reasons are carried verbatim for correlation (synthetic)', () => {
  const withReasons = describeZoneSweep(
    baseInput({ rejectionReasons: ['ZONE_UNAVAILABLE', 'NO_FRESH_SWEEP'] })
  );
  assert.match(withReasons.message, /reasons=\[ZONE_UNAVAILABLE,NO_FRESH_SWEEP\]/);
  const without = describeZoneSweep(baseInput());
  assert.match(without.message, /reasons=\[none\]/);
});

test('ZSD 9 — a known sweep with an unknown signal epoch stays OBSERVED but reports n/a (synthetic)', () => {
  const d = describeZoneSweep(
    baseInput({ signalEpoch: null, opposingLevels: [level('a', 'BUY_SIDE', 1.2, true, SIG - 90)] })
  );
  assert.equal(d.classification, 'OBSERVED');
  assert.match(d.message, /freshSweeps=n\/a/);
  assert.match(d.message, /qualifying=0/);
});
