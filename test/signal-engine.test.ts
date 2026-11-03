import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SignalEngine,
  DEFAULT_SIGNAL_ENGINE_CONFIG,
  SignalEngineConfig,
  SignalContext,
} from '../lib/signals/signal-engine';
import { Candle } from '../lib/deriv/candles';
import {
  isActionableBreak,
  selectLatestActionableBreak,
  getTriggerKind,
  resolveDirectionalContext,
  isTriggerFresh,
  resolveTrigger,
  computeConfluenceScore,
  collectZones,
  zoneDistance,
  zoneIsLocationEligible,
  isZoneFresh,
  selectEligibleZone,
  resolvePremiumDiscountGate,
  isSweepInFreshnessWindow,
  selectActionableSweep,
  opposingLiquidityLevels,
  zonesOverlap,
  hasConflictingOpposingZone,
  constructStopLoss,
  buildTargetCandidates,
  computeRiskReward,
  isRiskRewardAdequate,
  selectTakeProfit,
  ZoneCandidate,
  SignalDirection,
  CandidateRiskReward,
  RiskRewardObservation,
} from '../lib/signals/signal-engine';
import { BreakType, StructureBreak } from '../lib/analysis/structure-breaks';
import {
  MarketStructureState,
  StructuralBias,
  SwingPoint,
  getSymbolEqualityTolerance,
} from '../lib/analysis/market-structure';
import { SMCAnalysisResult } from '../lib/analysis/smc';
import { FairValueGap, FVGState } from '../lib/analysis/fvg';
import { OrderBlock, OrderBlockState } from '../lib/analysis/order-blocks';
import { LiquidityLevel, LiquidityState } from '../lib/analysis/liquidity';

function brk(
  type: BreakType,
  confirmedAtEpoch: number,
  breakCandleEpoch: number,
  id?: string
): StructureBreak {
  const direction: 'BULLISH' | 'BEARISH' = type.startsWith('BULLISH') ? 'BULLISH' : 'BEARISH';
  return {
    id: id ?? `${type}:${confirmedAtEpoch}:${breakCandleEpoch}`,
    type,
    symbol: 'EURUSD',
    timeframe: '1m',
    breakCandleEpoch,
    brokenSwingEpoch: breakCandleEpoch - 100,
    brokenPrice: 1.1,
    confirmationPrice: 1.1,
    confirmedAtEpoch,
    direction,
    sourceStructure: 'NEUTRAL',
  };
}

// --- Selection (spec §4A1, §4A2) --------------------------------------------------------------

test('SEL 1 — latest actionable picks the greatest confirmedAtEpoch', () => {
  const older = brk('BULLISH_BOS', 1000, 990);
  const newer = brk('BEARISH_CHOCH', 2000, 1990);
  assert.equal(selectLatestActionableBreak([older, newer])?.id, newer.id);
});

test('SEL 2 — tie-break: larger breakCandleEpoch wins when confirmedAtEpoch ties', () => {
  const a = brk('BULLISH_BOS', 2000, 1900, 'a');
  const b = brk('BEARISH_BOS', 2000, 1950, 'b');
  assert.equal(selectLatestActionableBreak([a, b])?.id, 'b');
});

test('SEL 3 — tie-break: lexicographically smallest id wins when epochs tie', () => {
  const a = brk('BULLISH_BOS', 2000, 1950, 'zz');
  const b = brk('BEARISH_BOS', 2000, 1950, 'aa');
  assert.equal(selectLatestActionableBreak([a, b])?.id, 'aa');
});

test('SEL 4 — INITIAL_* events are excluded and do not override an older actionable event', () => {
  const bos = brk('BULLISH_BOS', 1000, 990);
  const initial = brk('INITIAL_BEARISH_BREAK', 5000, 4990);
  assert.equal(selectLatestActionableBreak([bos, initial])?.id, bos.id);
});

test('SEL 5 — no actionable events returns null', () => {
  assert.equal(selectLatestActionableBreak([]), null);
  assert.equal(selectLatestActionableBreak([brk('INITIAL_BULLISH_BREAK', 100, 90)]), null);
});

test('SEL 6 — isActionableBreak distinguishes actionable from INITIAL_*', () => {
  assert.equal(isActionableBreak('BULLISH_BOS'), true);
  assert.equal(isActionableBreak('BEARISH_CHOCH'), true);
  assert.equal(isActionableBreak('INITIAL_BULLISH_BREAK'), false);
  assert.equal(isActionableBreak('INITIAL_BEARISH_BREAK'), false);
});

test('SEL 7 — getTriggerKind classifies CHoCH vs BOS', () => {
  assert.equal(getTriggerKind(brk('BULLISH_CHOCH', 1, 1)), 'CHOCH');
  assert.equal(getTriggerKind(brk('BEARISH_BOS', 1, 1)), 'BOS');
});

// --- Direction / context / setup (spec §4A3) --------------------------------------------------

test('CTX 1 — null trigger is invalid with setup NONE', () => {
  const ctx = resolveDirectionalContext(null, 'BULLISH');
  assert.equal(ctx.valid, false);
  assert.equal(ctx.setup, 'NONE');
  assert.equal(ctx.direction, null);
});

test('CTX 2 — CHoCH yields SWEEP_REVERSAL without requiring bias agreement', () => {
  const choch = brk('BULLISH_CHOCH', 100, 90);
  const ctx = resolveDirectionalContext(choch, 'BEARISH');
  assert.equal(ctx.valid, true);
  assert.equal(ctx.setup, 'SWEEP_REVERSAL');
  assert.equal(ctx.direction, 'BULLISH');
});

test('CTX 3 — BOS with matching structural bias yields TREND_CONTINUATION', () => {
  const bos = brk('BEARISH_BOS', 100, 90);
  const ctx = resolveDirectionalContext(bos, 'BEARISH');
  assert.equal(ctx.valid, true);
  assert.equal(ctx.setup, 'TREND_CONTINUATION');
  assert.equal(ctx.direction, 'BEARISH');
});

test('CTX 4 — BOS with NEUTRAL or contradicting bias is invalid', () => {
  const bos = brk('BULLISH_BOS', 100, 90);
  assert.equal(resolveDirectionalContext(bos, 'NEUTRAL').valid, false);
  assert.equal(resolveDirectionalContext(bos, 'BEARISH').valid, false);
});

// --- Trigger freshness (spec §4A5) ------------------------------------------------------------

const TF_SECONDS_1M = 60;

test('FRESH 1 — within the window is fresh', () => {
  const trigger = brk('BULLISH_BOS', 1000, 990);
  assert.equal(isTriggerFresh(trigger, 1000 + 49 * TF_SECONDS_1M, '1m'), true);
});

test('FRESH 2 — exactly at the window boundary is fresh (inclusive)', () => {
  const trigger = brk('BULLISH_BOS', 1000, 990);
  assert.equal(isTriggerFresh(trigger, 1000 + 50 * TF_SECONDS_1M, '1m'), true);
});

test('FRESH 3 — beyond the window is stale', () => {
  const trigger = brk('BULLISH_BOS', 1000, 990);
  assert.equal(isTriggerFresh(trigger, 1000 + 50 * TF_SECONDS_1M + 1, '1m'), false);
});

test('FRESH 4 — a trigger confirmed after the signal candle is not fresh', () => {
  const trigger = brk('BULLISH_BOS', 2000, 1990);
  assert.equal(isTriggerFresh(trigger, 1000, '1m'), false);
});

test('FRESH 5 — custom TRIGGER_MAX_AGE_BARS is honored', () => {
  const config: SignalEngineConfig = { ...DEFAULT_SIGNAL_ENGINE_CONFIG, TRIGGER_MAX_AGE_BARS: 1 };
  const trigger = brk('BULLISH_BOS', 1000, 990);
  assert.equal(isTriggerFresh(trigger, 1000 + 1 * TF_SECONDS_1M, '1m', config), true);
  assert.equal(isTriggerFresh(trigger, 1000 + 2 * TF_SECONDS_1M, '1m', config), false);
});

// --- Trigger resolution (spec §4D5 latest-trigger-only) ---------------------------------------

test('TRG 1 — no actionable event yields NO_CONTEXT', () => {
  const res = resolveTrigger([], 'BULLISH', 10_000, '1m');
  assert.equal(res.ok, false);
  assert.equal(res.rejection, 'NO_CONTEXT');
  assert.equal(res.setup, 'NONE');
  assert.equal(res.trigger, null);
});

test('TRG 2 — latest trigger only: a stale latest does not fall back to an older fresh event', () => {
  const olderFresh = brk('BULLISH_BOS', 1000, 990);
  const latestStale = brk('BEARISH_CHOCH', 1000 + 100 * TF_SECONDS_1M, 990 + 100 * TF_SECONDS_1M);
  const signalEpoch = 1000 + 100 * TF_SECONDS_1M + 50 * TF_SECONDS_1M + 1;
  const res = resolveTrigger([olderFresh, latestStale], 'BULLISH', signalEpoch, '1m');
  assert.equal(res.ok, false);
  assert.equal(res.rejection, 'STALE_TRIGGER');
  assert.equal(res.trigger?.id, latestStale.id);
});

test('TRG 3 — fresh continuation resolves ok with direction and setup', () => {
  const bos = brk('BULLISH_BOS', 1000, 990);
  const res = resolveTrigger([bos], 'BULLISH', 1000 + 5 * TF_SECONDS_1M, '1m');
  assert.equal(res.ok, true);
  assert.equal(res.rejection, null);
  assert.equal(res.setup, 'TREND_CONTINUATION');
  assert.equal(res.direction, 'BULLISH');
  assert.equal(res.trigger?.id, bos.id);
});

test('TRG 4 — a resolved context that fails freshness reports STALE_TRIGGER after context', () => {
  const choch = brk('BULLISH_CHOCH', 1000, 990);
  const res = resolveTrigger([choch], 'NEUTRAL', 1000 + 60 * TF_SECONDS_1M, '1m');
  assert.equal(res.ok, false);
  assert.equal(res.rejection, 'STALE_TRIGGER');
  assert.equal(res.setup, 'SWEEP_REVERSAL');
  assert.equal(res.direction, 'BULLISH');
});

test('TRG 5 — context gate precedes freshness: bad bias on a stale BOS yields NO_CONTEXT', () => {
  const bos = brk('BULLISH_BOS', 1000, 990);
  const res = resolveTrigger([bos], 'BEARISH', 1000 + 100 * TF_SECONDS_1M, '1m');
  assert.equal(res.ok, false);
  assert.equal(res.rejection, 'NO_CONTEXT');
});

// --- Confluence scoring (spec §4H1) -----------------------------------------------------------

test('SCORE 1 — full CHoCH confluence scores 100', () => {
  const score = computeConfluenceScore({
    contextResolved: true,
    triggerType: 'CHOCH',
    freshSweep: true,
    eligibleZone: true,
    premiumDiscountAligned: true,
  });
  assert.equal(score, 100);
  assert.equal(Number.isInteger(score), true);
});

test('SCORE 2 — full BOS confluence scores 95 (lower trigger weight)', () => {
  const score = computeConfluenceScore({
    contextResolved: true,
    triggerType: 'BOS',
    freshSweep: true,
    eligibleZone: true,
    premiumDiscountAligned: true,
  });
  assert.equal(score, 95);
});

test('SCORE 3 — missing factors subtract exactly their weights', () => {
  const score = computeConfluenceScore({
    contextResolved: true,
    triggerType: 'CHOCH',
    freshSweep: false,
    eligibleZone: false,
    premiumDiscountAligned: false,
  });
  assert.equal(score, 55); // 30 + 25
});

test('SCORE 4 — score is an integer within 0..100 across factor combinations', () => {
  const combos: boolean[] = [true, false];
  for (const contextResolved of combos) {
    for (const freshSweep of combos) {
      for (const eligibleZone of combos) {
        for (const premiumDiscountAligned of combos) {
          for (const triggerType of ['CHOCH', 'BOS'] as const) {
            const score = computeConfluenceScore({
              contextResolved,
              triggerType,
              freshSweep,
              eligibleZone,
              premiumDiscountAligned,
            });
            assert.equal(Number.isInteger(score), true);
            assert.ok(score >= 0 && score <= 100);
          }
        }
      }
    }
  }
});

// --- Stub behavior (setup value only) ---------------------------------------------------------

function emptyAnalysis(): SMCAnalysisResult {
  const marketStructure: MarketStructureState = {
    symbol: 'EURUSD',
    timeframe: '1m',
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
    symbol: 'EURUSD',
    timeframe: '1m',
    marketStructure,
    liquidity: {
      symbol: 'EURUSD',
      timeframe: '1m',
      buySideLiquidity: [],
      sellSideLiquidity: [],
      equalHighs: [],
      equalLows: [],
      status: 'WAITING FOR DATA',
    },
    fvg: {
      symbol: 'EURUSD',
      timeframe: '1m',
      bullishFVGs: [],
      bearishFVGs: [],
      unmitigatedCount: 0,
      status: 'WAITING FOR DATA',
    },
    orderBlocks: {
      symbol: 'EURUSD',
      timeframe: '1m',
      bullishOrderBlocks: [],
      bearishOrderBlocks: [],
      status: 'WAITING FOR DATA',
    },
    zone: 'WAITING FOR DATA',
    analyzedAt: 0,
  };
}

test('STUB 1 — evaluate remains NO_TRADE with setup NONE and null confidence', () => {
  const output = new SignalEngine().evaluate(emptyAnalysis());
  assert.equal(output.decision, 'NO_TRADE');
  assert.equal(output.setup, 'NONE');
  assert.equal(output.confidence, null);
  assert.equal(output.entry, null);
  assert.equal(output.stopLoss, null);
  assert.equal(output.takeProfit, null);
  assert.equal(output.riskReward, null);
});

// --- Stage 3: zone selection ----------------------------------------------------------------

const TF_SEC = 60;
const TOL = 0.0005;
const SIG = 1_000_000;

function makeLiquidityLevel(
  id: string,
  price: number,
  type: 'BUY_SIDE' | 'SELL_SIDE',
  swept: boolean,
  sweptEpoch?: number
): LiquidityLevel {
  return {
    id,
    price,
    type,
    swept,
    epoch: 100,
    ...(sweptEpoch !== undefined ? { sweptEpoch } : {}),
  };
}

function makeSwingPoint(id: string, type: 'HIGH' | 'LOW', price: number): SwingPoint {
  return {
    id,
    symbol: 'EURUSD',
    timeframe: '1m',
    type,
    candleEpoch: 100,
    swingCandleEpoch: 100,
    confirmedAtEpoch: 200,
    price,
    candleIndex: 0,
    structureType: type === 'HIGH' ? 'HH' : 'LL',
  };
}

function zoneCand(
  id: string,
  direction: SignalDirection,
  zoneLower: number,
  zoneUpper: number,
  epoch: number,
  usable = true
): ZoneCandidate {
  return { id, kind: 'FVG', direction, zoneLower, zoneUpper, epoch, usable };
}

function fvgState(bull: FairValueGap[], bear: FairValueGap[]): FVGState {
  return {
    symbol: 'EURUSD',
    timeframe: '1m',
    bullishFVGs: bull,
    bearishFVGs: bear,
    unmitigatedCount: 0,
    status: 'ACTIVE',
  };
}

function obState(bull: OrderBlock[], bear: OrderBlock[]): OrderBlockState {
  return {
    symbol: 'EURUSD',
    timeframe: '1m',
    bullishOrderBlocks: bull,
    bearishOrderBlocks: bear,
    status: 'ACTIVE',
  };
}

function structState(overrides: Partial<MarketStructureState>): MarketStructureState {
  return { ...emptyAnalysis().marketStructure, ...overrides };
}

function liqState(buy: LiquidityLevel[], sell: LiquidityLevel[]): LiquidityState {
  return {
    symbol: 'EURUSD',
    timeframe: '1m',
    buySideLiquidity: buy,
    sellSideLiquidity: sell,
    equalHighs: [],
    equalLows: [],
    status: 'ACTIVE',
  };
}

function analysisWith(overrides: Partial<SMCAnalysisResult>): SMCAnalysisResult {
  return { ...emptyAnalysis(), ...overrides };
}

test('ZONE 1 — collectZones normalizes FVG and OB eligibility (C1)', () => {
  const fvg = fvgState(
    [
      { id: 'f1', type: 'BULLISH', topPrice: 1.098, bottomPrice: 1.095, epoch: 100, mitigated: false },
    ],
    [
      { id: 'f2', type: 'BEARISH', topPrice: 1.108, bottomPrice: 1.105, epoch: 200, mitigated: true, mitigationEpoch: 300 },
    ]
  );
  const ob = obState(
    [
      { id: 'o1', type: 'BULLISH', high: 1.097, low: 1.096, epoch: 150, mitigated: false, invalidated: true, invalidatedEpoch: 400 },
    ],
    [
      { id: 'o2', type: 'BEARISH', high: 1.104, low: 1.103, epoch: 250, mitigated: true, invalidated: false },
    ]
  );

  const zones = collectZones(fvg, ob);
  assert.equal(zones.length, 4);
  const byId = new Map(zones.map((z) => [z.id, z]));
  assert.equal(byId.get('f1')?.usable, true);
  assert.equal(byId.get('f1')?.kind, 'FVG');
  assert.equal(byId.get('f1')?.direction, 'BULLISH');
  assert.deepEqual(
    { lower: byId.get('f1')?.zoneLower, upper: byId.get('f1')?.zoneUpper },
    { lower: 1.095, upper: 1.098 }
  );
  assert.equal(byId.get('f2')?.usable, false);
  assert.equal(byId.get('o1')?.usable, false);
  assert.equal(byId.get('o2')?.usable, true);
});

test('ZONE 2 — zoneDistance: 0 inside (edges inclusive), else gap to nearer boundary (C3)', () => {
  assert.equal(zoneDistance(1.09, 1.11, 1.1), 0);
  assert.equal(zoneDistance(1.1, 1.11, 1.1), 0); // entry == lower edge
  assert.equal(zoneDistance(1.09, 1.1, 1.1), 0); // entry == upper edge
  assert.equal(zoneDistance(1.1, 1.11, 1.095), 1.1 - 1.095); // entry below zone
  assert.equal(zoneDistance(1.09, 1.1, 1.105), 1.105 - 1.1); // entry above zone
});

test('ZONE 3 — location eligibility boundaries inclusive at tolE (C2, decision 9)', () => {
  const E = 1.1;
  assert.equal(zoneIsLocationEligible('BULLISH', E + TOL, 1.11, E, TOL), true);
  assert.equal(zoneIsLocationEligible('BULLISH', E + TOL + 0.000001, 1.11, E, TOL), false);
  assert.equal(zoneIsLocationEligible('BULLISH', 1.095, 1.096, E, TOL), true); // zone below entry ok
  assert.equal(zoneIsLocationEligible('BULLISH', 1.1005, 1.102, 1.1, 0.0005), true); // boundary literal
  assert.equal(zoneIsLocationEligible('BEARISH', 1.09, E - TOL, E, TOL), true);
  assert.equal(zoneIsLocationEligible('BEARISH', 1.09, E - TOL - 0.000001, E, TOL), false);
  assert.equal(zoneIsLocationEligible('BEARISH', 1.104, 1.105, E, TOL), true); // zone above entry ok
});

test('ZONE 4 — isZoneFresh: inclusive window, future epochs rejected (C4)', () => {
  assert.equal(isZoneFresh(SIG - 49 * TF_SEC, SIG, '1m'), true);
  assert.equal(isZoneFresh(SIG - 50 * TF_SEC, SIG, '1m'), true);
  assert.equal(isZoneFresh(SIG - 50 * TF_SEC - 1, SIG, '1m'), false);
  assert.equal(isZoneFresh(SIG + 60, SIG, '1m'), false);
});

test('ZONE 5 — selectEligibleZone: minimal distance, then newest epoch, then id (C5)', () => {
  const E = 1.1;
  const far = zoneCand('far', 'BULLISH', 1.095, 1.096, SIG - 8 * TF_SEC);
  const near2 = zoneCand('near2', 'BULLISH', 1.098, 1.099, SIG - 5 * TF_SEC);
  const near1 = zoneCand('near1', 'BULLISH', 1.099, 1.0995, SIG - 2 * TF_SEC);
  const res = selectEligibleZone([far, near2, near1], 'BULLISH', E, TOL, SIG, '1m');
  assert.equal(res.zone?.id, 'near1');
  assert.equal(res.noFreshUsableZone, false);
  assert.equal(res.allLocationMisaligned, false);

  const a = zoneCand('zz', 'BULLISH', 1.099, 1.0995, SIG - 2 * TF_SEC);
  const b = zoneCand('aa', 'BULLISH', 1.099, 1.0995, SIG - 2 * TF_SEC);
  assert.equal(selectEligibleZone([a, b], 'BULLISH', E, TOL, SIG, '1m').zone?.id, 'aa');
});

test('ZONE 6 — selectEligibleZone discriminates NO_ELIGIBLE_ZONE from ZONE_MISALIGNED', () => {
  const E = 1.1;
  const stale = zoneCand('stale', 'BULLISH', 1.095, 1.096, SIG - 100 * TF_SEC);
  const unusable = zoneCand('mit', 'BULLISH', 1.097, 1.098, SIG - 2 * TF_SEC, false);
  const wrongDir = zoneCand('bear', 'BEARISH', 1.095, 1.096, SIG - 2 * TF_SEC);
  const res = selectEligibleZone([stale, unusable, wrongDir], 'BULLISH', E, TOL, SIG, '1m');
  assert.equal(res.zone, null);
  assert.equal(res.noFreshUsableZone, true);
  assert.equal(res.allLocationMisaligned, false);

  const beyond = zoneCand('bee', 'BULLISH', E + TOL + 0.000001, E + TOL + 0.002, SIG - 2 * TF_SEC);
  const res2 = selectEligibleZone([beyond], 'BULLISH', E, TOL, SIG, '1m');
  assert.equal(res2.zone, null);
  assert.equal(res2.noFreshUsableZone, false);
  assert.equal(res2.allLocationMisaligned, true);
});

// --- Stage 3: premium/discount ---------------------------------------------------------------

test('PD 1 — premium/discount alignment per direction (E, decision 4)', () => {
  assert.deepEqual(resolvePremiumDiscountGate('BULLISH', 'DISCOUNT'), {
    aligned: true,
    rejection: null,
  });
  assert.deepEqual(resolvePremiumDiscountGate('BEARISH', 'PREMIUM'), {
    aligned: true,
    rejection: null,
  });
});

test('PD 2 — opposite region maps to ZONE_MISALIGNED', () => {
  assert.equal(resolvePremiumDiscountGate('BULLISH', 'PREMIUM').rejection, 'ZONE_MISALIGNED');
  assert.equal(resolvePremiumDiscountGate('BEARISH', 'DISCOUNT').rejection, 'ZONE_MISALIGNED');
});

test('PD 3 — EQUILIBRIUM and WAITING FOR DATA never qualify ⇒ ZONE_UNAVAILABLE', () => {
  assert.deepEqual(resolvePremiumDiscountGate('BULLISH', 'EQUILIBRIUM'), {
    aligned: false,
    rejection: 'ZONE_UNAVAILABLE',
  });
  assert.deepEqual(resolvePremiumDiscountGate('BEARISH', 'EQUILIBRIUM'), {
    aligned: false,
    rejection: 'ZONE_UNAVAILABLE',
  });
  assert.deepEqual(resolvePremiumDiscountGate('BULLISH', 'WAITING FOR DATA'), {
    aligned: false,
    rejection: 'ZONE_UNAVAILABLE',
  });
});

// --- Stage 3: liquidity sweeps ---------------------------------------------------------------

test('SWEEP 1 — isSweepInFreshnessWindow temporal constraints (B3)', () => {
  assert.equal(isSweepInFreshnessWindow(makeLiquidityLevel('a', 1.09, 'SELL_SIDE', false), SIG, '1m'), false);
  assert.equal(isSweepInFreshnessWindow(makeLiquidityLevel('a', 1.09, 'SELL_SIDE', true), SIG, '1m'), false); // no sweptEpoch
  assert.equal(isSweepInFreshnessWindow(makeLiquidityLevel('f', 1.09, 'SELL_SIDE', true, SIG + 60), SIG, '1m'), false);
  assert.equal(isSweepInFreshnessWindow(makeLiquidityLevel('z', 1.09, 'SELL_SIDE', true, SIG), SIG, '1m'), true);
  assert.equal(isSweepInFreshnessWindow(makeLiquidityLevel('b', 1.09, 'SELL_SIDE', true, SIG - 10 * TF_SEC), SIG, '1m'), true);
  assert.equal(isSweepInFreshnessWindow(makeLiquidityLevel('o', 1.09, 'SELL_SIDE', true, SIG - 10 * TF_SEC - 1), SIG, '1m'), false);
});

test('SWEEP 2 — selectActionableSweep: greatest sweptEpoch, tie-break id asc (B4)', () => {
  const levels = [
    makeLiquidityLevel('old', 1.09, 'SELL_SIDE', true, SIG - 8 * TF_SEC),
    makeLiquidityLevel('new', 1.09, 'SELL_SIDE', true, SIG - 2 * TF_SEC),
    makeLiquidityLevel('ancient', 1.09, 'SELL_SIDE', true, SIG - 9 * TF_SEC),
  ];
  const res = selectActionableSweep(levels, SIG, '1m');
  assert.equal(res.sweep?.id, 'new');
  assert.equal(res.hasFreshSweep, true);

  const ties = [
    makeLiquidityLevel('zz', 1.09, 'SELL_SIDE', true, SIG - 3 * TF_SEC),
    makeLiquidityLevel('aa', 1.09, 'SELL_SIDE', true, SIG - 3 * TF_SEC),
  ];
  assert.equal(selectActionableSweep(ties, SIG, '1m').sweep?.id, 'aa');
});

test('SWEEP 3 — reversal sweep must occur on or before trigger confirmation (B3)', () => {
  const confirmedAt = SIG - 2 * TF_SEC;
  const afterTrigger = makeLiquidityLevel('late', 1.09, 'SELL_SIDE', true, SIG - TF_SEC);
  assert.equal(
    selectActionableSweep([afterTrigger], SIG, '1m', DEFAULT_SIGNAL_ENGINE_CONFIG, confirmedAt).sweep,
    null
  );

  const beforeTrigger = makeLiquidityLevel('ok', 1.09, 'SELL_SIDE', true, SIG - 5 * TF_SEC);
  const res = selectActionableSweep([afterTrigger, beforeTrigger], SIG, '1m', DEFAULT_SIGNAL_ENGINE_CONFIG, confirmedAt);
  assert.equal(res.sweep?.id, 'ok');
  assert.equal(res.hasFreshSweep, true);
});

test('SWEEP 4 — opposing liquidity side per direction (D2/D3)', () => {
  const buy = makeLiquidityLevel('buy', 1.1, 'BUY_SIDE', false);
  const sell = makeLiquidityLevel('sell', 1.09, 'SELL_SIDE', false);
  const analysis = analysisWith({ liquidity: liqState([buy], [sell]) });
  assert.deepEqual(opposingLiquidityLevels(analysis, 'BULLISH'), [sell]);
  assert.deepEqual(opposingLiquidityLevels(analysis, 'BEARISH'), [buy]);
});

// --- Stage 3: opposing-zone conflict ----------------------------------------------------------

test('CONFLICT 1 — zonesOverlap semantics (C6, correction 2)', () => {
  assert.equal(zonesOverlap(1.095, 1.1, 1.098, 1.102, TOL), true); // overlapping
  assert.equal(zonesOverlap(1.095, 1.1, 1.1 + TOL, 1.104, TOL), true); // gap == tolE
  assert.equal(zonesOverlap(1.095, 1.1, 1.1 + TOL + 0.0000001, 1.104, TOL), false); // gap > tolE
});

test('CONFLICT 2 — overlapping opposite zone ⇒ conflict', () => {
  const selected = zoneCand('sel', 'BULLISH', 1.095, 1.1, SIG - 3 * TF_SEC);
  assert.equal(hasConflictingOpposingZone(selected, [zoneCand('opp', 'BEARISH', 1.098, 1.102, SIG - 2 * TF_SEC)], TOL, SIG, '1m'), true);
});

test('CONFLICT 3 — near entry but non-overlapping opposing zone is NOT a conflict', () => {
  const selected = zoneCand('sel', 'BULLISH', 1.095, 1.1, SIG - 3 * TF_SEC);
  const near = zoneCand('near', 'BEARISH', 1.1 + TOL + 0.0000001, 1.104, SIG - 2 * TF_SEC);
  assert.equal(hasConflictingOpposingZone(selected, [near], TOL, SIG, '1m'), false);
});

test('CONFLICT 4 — stale, unusable, or same-direction opposing zones never conflict', () => {
  const selected = zoneCand('sel', 'BULLISH', 1.095, 1.1, SIG - 3 * TF_SEC);
  const stale = zoneCand('stale', 'BEARISH', 1.098, 1.102, SIG - 100 * TF_SEC);
  const unusable = zoneCand('injured', 'BEARISH', 1.098, 1.102, SIG - 2 * TF_SEC, false);
  const sameDir = zoneCand('same', 'BULLISH', 1.098, 1.102, SIG - 2 * TF_SEC);
  assert.equal(hasConflictingOpposingZone(selected, [stale], TOL, SIG, '1m'), false);
  assert.equal(hasConflictingOpposingZone(selected, [unusable], TOL, SIG, '1m'), false);
  assert.equal(hasConflictingOpposingZone(selected, [sameDir], TOL, SIG, '1m'), false);
});

// --- Stage 3: stop-loss -----------------------------------------------------------------------

test('SL 1 — LONG stop: min of candidates minus buffer (F1)', () => {
  const res = constructStopLoss({
    direction: 'BULLISH',
    entry: 1.1,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    structuralInvalidation: 1.099,
    selectedZone: zoneCand('z', 'BULLISH', 1.0985, 1.1, 500),
    selectedSweepPrice: 1.0995,
  });
  assert.equal(res.rejection, null);
  assert.equal(res.stopLoss, 1.0985 - TOL);
});

test('SL 2 — no candidate ⇒ SL_UNRESOLVED (F2)', () => {
  const res = constructStopLoss({
    direction: 'BULLISH',
    entry: 1.1,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    selectedZone: null,
    selectedSweepPrice: null,
  });
  assert.equal(res.stopLoss, null);
  assert.equal(res.rejection, 'SL_UNRESOLVED');
});

test('SL 3 — distance exactly MIN_STOP_TOLERANCE_MULT * tolE is too tight (inclusive, F2)', () => {
  const E = 1.1;
  const rawStop = E - TOL; // stopLoss = rawStop - TOL = E - 2*TOL
  const res = constructStopLoss({
    direction: 'BULLISH',
    entry: E,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    structuralInvalidation: rawStop,
    selectedZone: null,
    selectedSweepPrice: null,
  });
  assert.equal(res.rejection, 'SL_TOO_TIGHT');
  assert.equal(res.stopLoss, (E - TOL) - TOL);
});

test('SL 4 — SHORT stop: max of candidates plus buffer (F1)', () => {
  const res = constructStopLoss({
    direction: 'BEARISH',
    entry: 1.1,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    structuralInvalidation: 1.101,
    selectedZone: zoneCand('z', 'BEARISH', 1.098, 1.102, 500),
    selectedSweepPrice: 1.1015,
  });
  assert.equal(res.rejection, null);
  assert.equal(res.stopLoss, 1.102 + TOL);
});

test('SL 5 — SHORT ignores a swept price on the wrong side (below entry)', () => {
  const res = constructStopLoss({
    direction: 'BEARISH',
    entry: 1.1,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    structuralInvalidation: 1.101,
    selectedZone: zoneCand('z', 'BEARISH', 1.098, 1.102, 500),
    selectedSweepPrice: 1.0995,
  });
  assert.equal(res.stopLoss, 1.102 + TOL);
});

// --- Stage 3: take-profit and risk/reward -----------------------------------------------------

test('RR 1 — computeRiskReward with valid LONG/SHORT geometry (F3)', () => {
  const long = computeRiskReward('BULLISH', 1.1, 1.095, 1.11);
  const short = computeRiskReward('BEARISH', 1.1, 1.105, 1.09);
  assert.ok(long !== null && Math.abs(long - 2) < 1e-9);
  assert.ok(short !== null && Math.abs(short - 2) < 1e-9);
});

test('RR 2 — non-positive risk or reward yields null', () => {
  assert.equal(computeRiskReward('BULLISH', 1.1, 1.1, 1.11), null); // zero risk
  assert.equal(computeRiskReward('BULLISH', 1.1, 1.095, 1.095), null); // zero reward
});

test('RR 3 — isRiskRewardAdequate inclusive at 2.0 (F4)', () => {
  assert.equal(isRiskRewardAdequate(2.0), true);
  assert.equal(isRiskRewardAdequate(2.0001), true);
  assert.equal(isRiskRewardAdequate(1.9999), false);
});

test('TP 1 — empty valid target set ⇒ NO_TARGET (G3)', () => {
  const res = selectTakeProfit({
    direction: 'BULLISH',
    entry: 1.1,
    stopLoss: 1.095,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [],
  });
  assert.deepEqual(res, { takeProfit: null, riskReward: null, rejection: 'NO_TARGET' });
});

test('TP 2 — targets exist but none reach 2.0 ⇒ RR_BELOW_MIN (distinct from NO_TARGET)', () => {
  const res = selectTakeProfit({
    direction: 'BULLISH',
    entry: 1.1,
    stopLoss: 1.099,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [
      { id: 'c1', price: 1.101 },
      { id: 'c2', price: 1.1006 },
    ],
  });
  assert.equal(res.rejection, 'RR_BELOW_MIN');
  assert.equal(res.takeProfit, null);
  assert.equal(res.riskReward, null);
});

test('TP 3 — walks ascending and picks the first target reaching 2.0 (F3)', () => {
  const res = selectTakeProfit({
    direction: 'BULLISH',
    entry: 1.1,
    stopLoss: 1.0975,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [
      { id: 'c1', price: 1.103 },
      { id: 'c2', price: 1.106 },
      { id: 'c3', price: 1.108 },
    ],
  });
  assert.equal(res.takeProfit, 1.106);
  assert.equal(res.rejection, null);
  assert.ok(res.riskReward !== null && res.riskReward >= 2.0);
});

test('TP 4 — exactly 2.0 R:R qualifies (inclusive boundary)', () => {
  const entry = 100;
  const risk = 1 / 128; // 0.0078125 — exact power of two, keeps the boundary numerically exact
  const stopLoss = entry - risk;
  const target = entry + 2 * risk;
  const res = selectTakeProfit({
    direction: 'BULLISH',
    entry,
    stopLoss,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [{ id: 'b', price: target }],
  });
  assert.equal(res.takeProfit, target);
  assert.equal(res.rejection, null);
  assert.equal(res.riskReward, 2.0);
});

test('TP 5 — buildTargetCandidates LONG: unswept buy-side + structural highs, exclude swept/bearish (F3)', () => {
  const E = 1.1;
  const liq = liqState(
    [
      makeLiquidityLevel('buyUnswept', 1.106, 'BUY_SIDE', false),
      makeLiquidityLevel('buySwept', 1.112, 'BUY_SIDE', true, 500),
    ],
    []
  );
  const struct = structState({
    latestSwingHigh: makeSwingPoint('sh', 'HIGH', 1.104),
    protectedHigh: makeSwingPoint('ph', 'HIGH', 1.104),
    breaks: [
      { ...brk('BEARISH_BOS', 600, 590), brokenPrice: 1.103 },
      { ...brk('BULLISH_BOS', 700, 690), brokenPrice: 1.107 },
    ],
  });
  const analysis = analysisWith({ liquidity: liq, marketStructure: struct });
  const targets = buildTargetCandidates(analysis, 'BULLISH', E, TOL);
  const prices = targets.map((t) => t.price).sort((a, b) => a - b);
  assert.deepEqual(prices, [1.104, 1.104, 1.106, 1.107]);
});

test('TP 6 — buildTargetCandidates SHORT: unswept sell-side + structural lows (F3)', () => {
  const E = 1.1;
  const liq = liqState(
    [],
    [
      makeLiquidityLevel('sellUnswept', 1.094, 'SELL_SIDE', false),
      makeLiquidityLevel('sellSwept', 1.09, 'SELL_SIDE', true, 500),
    ]
  );
  const struct = structState({
    latestSwingLow: makeSwingPoint('sl', 'LOW', 1.096),
    protectedLow: makeSwingPoint('pl', 'LOW', 1.096),
    breaks: [
      { ...brk('BULLISH_BOS', 600, 590), brokenPrice: 1.097 },
      { ...brk('BEARISH_BOS', 700, 690), brokenPrice: 1.092 },
    ],
  });
  const analysis = analysisWith({ liquidity: liq, marketStructure: struct });
  const targets = buildTargetCandidates(analysis, 'BEARISH', E, TOL);
  const prices = targets.map((t) => t.price).sort((a, b) => a - b);
  assert.deepEqual(prices, [1.092, 1.094, 1.096, 1.096]);
});

test('DET 1 — zone selection is deterministic across identical calls', () => {
  const E = 1.1;
  const candidates = [
    zoneCand('a', 'BULLISH', 1.098, 1.099, 300),
    zoneCand('b', 'BULLISH', 1.099, 1.0995, 800),
  ];
  const r1 = selectEligibleZone(candidates, 'BULLISH', E, TOL, SIG, '1m');
  const r2 = selectEligibleZone(candidates, 'BULLISH', E, TOL, SIG, '1m');
  assert.deepEqual(r1, r2);
});

// --- Stage 4: orchestrator (spec §4G ordering, §5 duplicates, §6 determinism) -----------------

const TOL_E = getSymbolEqualityTolerance('EURUSD', 1.1);

function makeCandle(epoch: number, close: number, isClosed = true): Candle {
  return { epoch, open: close, high: close, low: close, close, volume: 1, isClosed };
}

function ctxAt(epoch: number, close: number, isClosed = true): SignalContext {
  return { lastClosedCandle: makeCandle(epoch, close, isClosed) };
}

function longTrendAnalysis(
  signalEpoch: number,
  overrides: Partial<SMCAnalysisResult> = {}
): SMCAnalysisResult {
  const trigger: StructureBreak = {
    ...brk('BULLISH_BOS', signalEpoch - TF_SEC, signalEpoch - 2 * TF_SEC, 'trig-long'),
    brokenPrice: 1.1,
  };
  const struct = structState({
    structuralBias: 'BULLISH',
    swings: [makeSwingPoint('sw1', 'LOW', 1.095)],
    protectedLow: makeSwingPoint('pl', 'LOW', 1.0985),
    breaks: [trigger],
  });
  const fvg = fvgState(
    [
      {
        id: 'zone-long',
        type: 'BULLISH',
        topPrice: 1.0995,
        bottomPrice: 1.099,
        epoch: signalEpoch - 5 * TF_SEC,
        mitigated: false,
      },
    ],
    []
  );
  const liq = liqState([makeLiquidityLevel('tgt-long', 1.105, 'BUY_SIDE', false)], []);
  return analysisWith({
    marketStructure: struct,
    fvg,
    liquidity: liq,
    zone: 'DISCOUNT',
    ...overrides,
  });
}

function shortTrendAnalysis(
  signalEpoch: number,
  overrides: Partial<SMCAnalysisResult> = {}
): SMCAnalysisResult {
  const trigger: StructureBreak = {
    ...brk('BEARISH_BOS', signalEpoch - TF_SEC, signalEpoch - 2 * TF_SEC, 'trig-short'),
    brokenPrice: 1.1,
  };
  const struct = structState({
    structuralBias: 'BEARISH',
    swings: [makeSwingPoint('sw1', 'HIGH', 1.105)],
    protectedHigh: makeSwingPoint('ph', 'HIGH', 1.1015),
    breaks: [trigger],
  });
  const fvg = fvgState(
    [],
    [
      {
        id: 'zone-short',
        type: 'BEARISH',
        topPrice: 1.101,
        bottomPrice: 1.1005,
        epoch: signalEpoch - 5 * TF_SEC,
        mitigated: false,
      },
    ]
  );
  const liq = liqState([], [makeLiquidityLevel('tgt-short', 1.095, 'SELL_SIDE', false)]);
  return analysisWith({
    marketStructure: struct,
    fvg,
    liquidity: liq,
    zone: 'PREMIUM',
    ...overrides,
  });
}

test('ORCH 1 — valid LONG TREND_CONTINUATION emits a full signal', () => {
  const out = new SignalEngine().evaluate(longTrendAnalysis(SIG), ctxAt(SIG, 1.1));
  assert.equal(out.decision, 'LONG');
  assert.equal(out.setup, 'TREND_CONTINUATION');
  assert.equal(out.entry, 1.1);
  assert.equal(out.stopLoss, 1.0985 - TOL_E);
  assert.equal(out.takeProfit, 1.105);
  const expectedRR = (1.105 - 1.1) / (1.1 - (1.0985 - TOL_E));
  assert.ok(out.riskReward !== null && Math.abs(out.riskReward - expectedRR) < 1e-9);
  assert.equal(out.confidence, 75); // 30 context + 20 BOS + 15 zone + 10 PD
  assert.equal(out.timestamp, SIG);
  assert.equal(out.signalEpoch, SIG);
  assert.equal(out.triggerId, 'trig-long');
  assert.equal(out.rejectionReasons, undefined);
});

test('ORCH 2 — valid SHORT TREND_CONTINUATION emits a full signal', () => {
  const out = new SignalEngine().evaluate(shortTrendAnalysis(SIG), ctxAt(SIG, 1.1));
  assert.equal(out.decision, 'SHORT');
  assert.equal(out.setup, 'TREND_CONTINUATION');
  assert.equal(out.entry, 1.1);
  assert.equal(out.stopLoss, 1.1015 + TOL_E);
  assert.equal(out.takeProfit, 1.095);
  assert.equal(out.confidence, 75);
  assert.equal(out.timestamp, SIG);
  assert.equal(out.triggerId, 'trig-short');
});

test('ORCH 2b — a valid bullish CHoCH sweep reversal emits an accepted LONG with a selected R:R observation', () => {
  // Synthetic reversal: a bullish CHoCH, a fresh swept SELL_SIDE level confirmed before the CHoCH,
  // a fresh location-eligible bullish discount zone, and one unswept BUY_SIDE target.
  const analysis = analysisWith({
    marketStructure: structState({
      structuralBias: 'BULLISH',
      swings: [makeSwingPoint('sw1', 'LOW', 1.095)],
      protectedLow: makeSwingPoint('pl', 'LOW', 1.0985),
      breaks: [
        {
          ...brk('BULLISH_CHOCH', SIG - TF_SEC, SIG - 2 * TF_SEC, 'choch-reversal'),
          brokenPrice: 1.1,
        },
      ],
      latestSwingHigh: null,
      protectedHigh: null,
    }),
    fvg: fvgState(
      [
        {
          id: 'zone-sweep',
          type: 'BULLISH',
          topPrice: 1.0995,
          bottomPrice: 1.099,
          epoch: SIG - 5 * TF_SEC,
          mitigated: false,
        },
      ],
      []
    ),
    liquidity: liqState(
      [makeLiquidityLevel('tgt-sweep', 1.11, 'BUY_SIDE', false)],
      [makeLiquidityLevel('sweep-sell', 1.097, 'SELL_SIDE', true, SIG - 5 * TF_SEC)]
    ),
    zone: 'DISCOUNT',
  });

  const observed: RiskRewardObservation[] = [];
  const engine = new SignalEngine({ riskRewardObserver: (o) => observed.push(o) });
  const out = engine.evaluate(analysis, ctxAt(SIG, 1.1));

  // The reversal cleared context/trigger freshness, sweep, zone, stop-loss and R:R gates.
  assert.equal(out.decision, 'LONG');
  assert.equal(out.setup, 'SWEEP_REVERSAL');
  assert.equal(out.rejectionReasons, undefined);
  assert.equal(out.triggerId, 'choch-reversal');
  assert.equal(out.signalId, 'EURUSD:1m:choch-reversal:zone-sweep');
  assert.equal(out.entry, 1.1);
  // min(protectedLow 1.0985, zoneLower 1.099, swept 1.097) - one tolerance buffer, proving the
  // qualifying sweep passed validation and contributed to the stop.
  assert.equal(out.stopLoss, 1.097 - TOL_E);
  assert.equal(out.takeProfit, 1.11);
  assert.ok(
    out.riskReward !== null &&
      out.riskReward >= DEFAULT_SIGNAL_ENGINE_CONFIG.MIN_RISK_REWARD
  );

  // Verified against computeConfluenceScore in production: context 30 + CHoCH 25 + fresh sweep 20
  // + eligible zone 15 + discount 10 = 100. The audit's value of 80 omitted the mandatory fresh-sweep
  // contribution; a SWEEP_REVERSAL accepted without that sweep cannot exist (Tier 2 rejects it).
  assert.equal(out.confidence, 100);

  // The observer saw this evaluation's exact selected candidate, not a recomputation.
  const selected = observed.filter((o) => o.selected);
  assert.equal(selected.length, 1);
  const obs = selected[0];
  assert.equal(obs.direction, 'BULLISH');
  assert.equal(obs.entry, out.entry);
  assert.equal(obs.stopLoss, out.stopLoss);
  assert.equal(obs.target, out.takeProfit);
  assert.equal(obs.riskReward, out.riskReward);
  assert.equal(obs.minimum, DEFAULT_SIGNAL_ENGINE_CONFIG.MIN_RISK_REWARD);
  assert.equal(obs.meetsMinimum, true);
  assert.equal(obs.rejection, null);
  assert.equal(obs.symbol, 'EURUSD');
  assert.equal(obs.timeframe, '1m');
});

test('ORCH 2c — a valid bearish CHoCH sweep reversal emits an accepted SHORT with a selected R:R observation', () => {
  // Synthetic reversal mirroring ORCH 2b: a bearish CHoCH, a fresh swept BUY_SIDE level confirmed
  // before the CHoCH, a fresh location-eligible bearish premium zone, and one unswept SELL_SIDE target.
  const analysis = analysisWith({
    marketStructure: structState({
      structuralBias: 'BEARISH',
      swings: [makeSwingPoint('sw1', 'HIGH', 1.105)],
      protectedHigh: makeSwingPoint('ph', 'HIGH', 1.1015),
      breaks: [
        {
          ...brk('BEARISH_CHOCH', SIG - TF_SEC, SIG - 2 * TF_SEC, 'choch-reversal-bear'),
          brokenPrice: 1.1,
        },
      ],
      latestSwingLow: null,
      protectedLow: null,
    }),
    fvg: fvgState(
      [],
      [
        {
          id: 'zone-sweep',
          type: 'BEARISH',
          topPrice: 1.101,
          bottomPrice: 1.1005,
          epoch: SIG - 5 * TF_SEC,
          mitigated: false,
        },
      ]
    ),
    liquidity: liqState(
      [makeLiquidityLevel('sweep-buy', 1.103, 'BUY_SIDE', true, SIG - 5 * TF_SEC)],
      [makeLiquidityLevel('tgt-sweep', 1.09, 'SELL_SIDE', false)]
    ),
    zone: 'PREMIUM',
  });

  const observed: RiskRewardObservation[] = [];
  const engine = new SignalEngine({ riskRewardObserver: (o) => observed.push(o) });
  const out = engine.evaluate(analysis, ctxAt(SIG, 1.1));

  // The reversal cleared context/trigger freshness, sweep, zone, stop-loss and R:R gates.
  assert.equal(out.decision, 'SHORT');
  assert.equal(out.setup, 'SWEEP_REVERSAL');
  assert.equal(out.rejectionReasons, undefined);
  assert.equal(out.triggerId, 'choch-reversal-bear');
  assert.equal(out.signalId, 'EURUSD:1m:choch-reversal-bear:zone-sweep');
  assert.equal(out.entry, 1.1);
  // max(protectedHigh 1.1015, zoneUpper 1.101, swept 1.103) + one tolerance buffer, proving the
  // qualifying sweep passed validation and contributed to the stop.
  assert.equal(out.stopLoss, 1.103 + TOL_E);
  assert.equal(out.takeProfit, 1.09);
  assert.ok(
    out.riskReward !== null &&
      out.riskReward >= DEFAULT_SIGNAL_ENGINE_CONFIG.MIN_RISK_REWARD
  );

  // Verified against computeConfluenceScore in production: context 30 + CHoCH 25 + fresh sweep 20
  // + eligible zone 15 + premium 10 = 100.
  assert.equal(out.confidence, 100);

  // The observer saw this evaluation's exact selected candidate, not a recomputation.
  const selected = observed.filter((o) => o.selected);
  assert.equal(selected.length, 1);
  const obs = selected[0];
  assert.equal(obs.direction, 'BEARISH');
  assert.equal(obs.entry, out.entry);
  assert.equal(obs.stopLoss, out.stopLoss);
  assert.equal(obs.target, out.takeProfit);
  assert.equal(obs.riskReward, out.riskReward);
  assert.equal(obs.minimum, DEFAULT_SIGNAL_ENGINE_CONFIG.MIN_RISK_REWARD);
  assert.equal(obs.meetsMinimum, true);
  assert.equal(obs.rejection, null);
  assert.equal(obs.symbol, 'EURUSD');
  assert.equal(obs.timeframe, '1m');
});

test('ORCH 3 — missing context yields FORMING_CANDLE', () => {
  const out = new SignalEngine().evaluate(longTrendAnalysis(SIG));
  assert.equal(out.decision, 'NO_TRADE');
  assert.deepEqual(out.rejectionReasons, ['FORMING_CANDLE']);
});

test('ORCH 4 — a still-forming candle yields FORMING_CANDLE', () => {
  const out = new SignalEngine().evaluate(longTrendAnalysis(SIG), ctxAt(SIG, 1.1, false));
  assert.equal(out.decision, 'NO_TRADE');
  assert.deepEqual(out.rejectionReasons, ['FORMING_CANDLE']);
});

test('ORCH 5 — no confirmed swings yields INSUFFICIENT_DATA before context', () => {
  const analysis = analysisWith({
    marketStructure: structState({ structuralBias: 'BULLISH', swings: [] }),
    zone: 'DISCOUNT',
  });
  const out = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  assert.deepEqual(out.rejectionReasons, ['INSUFFICIENT_DATA']);
  assert.equal(out.setup, 'NONE');
  assert.equal(out.confidence, null);
});

test('ORCH 6 — no actionable event yields NO_CONTEXT', () => {
  const analysis = longTrendAnalysis(SIG, {
    marketStructure: structState({
      structuralBias: 'BULLISH',
      swings: [makeSwingPoint('sw1', 'LOW', 1.095)],
      breaks: [],
    }),
  });
  const out = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  assert.equal(out.decision, 'NO_TRADE');
  assert.deepEqual(out.rejectionReasons, ['NO_CONTEXT']);
});

test('ORCH 7 — latest-trigger-only: a failing latest never falls back to an older fresh event', () => {
  const olderFresh = {
    ...brk('BULLISH_BOS', SIG - TF_SEC, SIG - 2 * TF_SEC, 'old-fresh'),
    brokenPrice: 1.1,
  };
  const latestFuture = {
    ...brk('BULLISH_CHOCH', SIG + TF_SEC, SIG, 'future-latest'),
    brokenPrice: 1.1,
  };
  const analysis = longTrendAnalysis(SIG, {
    marketStructure: structState({
      structuralBias: 'BULLISH',
      swings: [makeSwingPoint('sw1', 'LOW', 1.095)],
      protectedLow: makeSwingPoint('pl', 'LOW', 1.0985),
      breaks: [olderFresh, latestFuture],
    }),
  });
  const out = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  assert.deepEqual(out.rejectionReasons, ['STALE_TRIGGER']);
  assert.equal(out.triggerId, 'future-latest');
});

test('ORCH 8 — EQUILIBRIUM maps to ZONE_UNAVAILABLE with a distinguishing reason', () => {
  const out = new SignalEngine().evaluate(longTrendAnalysis(SIG, { zone: 'EQUILIBRIUM' }), ctxAt(SIG, 1.1));
  assert.deepEqual(out.rejectionReasons, ['ZONE_UNAVAILABLE']);
  assert.match(out.reason, /EQUILIBRIUM/);
});

test('ORCH 9 — no fresh usable same-direction zone yields NO_ELIGIBLE_ZONE', () => {
  const out = new SignalEngine().evaluate(longTrendAnalysis(SIG, { fvg: fvgState([], []) }), ctxAt(SIG, 1.1));
  assert.deepEqual(out.rejectionReasons, ['NO_ELIGIBLE_ZONE']);
});

test('ORCH 10 — a mislocated same-direction zone and an opposite region both yield ZONE_MISALIGNED', () => {
  const mislocated = longTrendAnalysis(SIG, {
    fvg: fvgState(
      [
        {
          id: 'zone-high',
          type: 'BULLISH',
          topPrice: 1.102,
          bottomPrice: 1.1015,
          epoch: SIG - 5 * TF_SEC,
          mitigated: false,
        },
      ],
      []
    ),
  });
  const out1 = new SignalEngine().evaluate(mislocated, ctxAt(SIG, 1.1));
  assert.deepEqual(out1.rejectionReasons, ['ZONE_MISALIGNED']);
  const out2 = new SignalEngine().evaluate(longTrendAnalysis(SIG, { zone: 'PREMIUM' }), ctxAt(SIG, 1.1));
  assert.deepEqual(out2.rejectionReasons, ['ZONE_MISALIGNED']);
});

test('ORCH 11 — an overlapping fresh opposing zone yields CONFLICTING_ZONES', () => {
  const analysis = longTrendAnalysis(SIG, {
    fvg: fvgState(
      [
        {
          id: 'zone-long',
          type: 'BULLISH',
          topPrice: 1.0995,
          bottomPrice: 1.099,
          epoch: SIG - 5 * TF_SEC,
          mitigated: false,
        },
      ],
      [
        {
          id: 'opp',
          type: 'BEARISH',
          topPrice: 1.0998,
          bottomPrice: 1.0992,
          epoch: SIG - 4 * TF_SEC,
          mitigated: false,
        },
      ]
    ),
  });
  const out = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  assert.deepEqual(out.rejectionReasons, ['CONFLICTING_ZONES']);
});

test('ORCH 12 — SWEEP_REVERSAL without a qualifying opposing sweep yields NO_FRESH_SWEEP', () => {
  const analysis = longTrendAnalysis(SIG, {
    marketStructure: structState({
      structuralBias: 'NEUTRAL',
      swings: [makeSwingPoint('sw1', 'LOW', 1.095)],
      protectedLow: makeSwingPoint('pl', 'LOW', 1.0985),
      breaks: [{ ...brk('BULLISH_CHOCH', SIG - TF_SEC, SIG - 2 * TF_SEC, 'choch-long'), brokenPrice: 1.1 }],
    }),
    liquidity: liqState([makeLiquidityLevel('tgt-long', 1.105, 'BUY_SIDE', false)], []),
  });
  const out = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  assert.deepEqual(out.rejectionReasons, ['NO_FRESH_SWEEP']);
});

test('ORCH 13 — Tier 2 collects all applicable codes in fixed order', () => {
  const analysis = longTrendAnalysis(SIG, {
    marketStructure: structState({
      structuralBias: 'NEUTRAL',
      swings: [makeSwingPoint('sw1', 'LOW', 1.095)],
      protectedLow: makeSwingPoint('pl', 'LOW', 1.0985),
      breaks: [{ ...brk('BULLISH_CHOCH', SIG - TF_SEC, SIG - 2 * TF_SEC, 'choch-long'), brokenPrice: 1.1 }],
    }),
    fvg: fvgState([], []),
    zone: 'WAITING FOR DATA',
  });
  const out = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  assert.deepEqual(out.rejectionReasons, ['ZONE_UNAVAILABLE', 'NO_ELIGIBLE_ZONE', 'NO_FRESH_SWEEP']);
});

test('ORCH 13b — BULLISH CHoCH with a fresh eligible zone in PREMIUM and only stale SELL_SIDE sweeps yields ZONE_MISALIGNED then NO_FRESH_SWEEP', () => {
  const analysis = analysisWith({
    marketStructure: structState({
      structuralBias: 'BULLISH',
      swings: [makeSwingPoint('sw1', 'LOW', 1.095)],
      breaks: [
        { ...brk('BULLISH_CHOCH', SIG - TF_SEC, SIG - 2 * TF_SEC, 'choch-long'), brokenPrice: 1.1 },
      ],
    }),
    // A genuinely fresh, usable, direction-matching and location-eligible bullish zone:
    // epoch SIG-5 is within MAX_ZONE_AGE_BARS (50), and zoneLower 1.099 <= entry 1.1 + tolE.
    fvg: fvgState(
      [
        {
          id: 'zone-long',
          type: 'BULLISH',
          topPrice: 1.0995,
          bottomPrice: 1.099,
          epoch: SIG - 5 * TF_SEC,
          mitigated: false,
        },
      ],
      []
    ),
    // Only stale swept SELL_SIDE levels: ages 12 and 15 bars exceed SWEEP_MAX_AGE_BARS (10).
    liquidity: liqState(
      [],
      [
        makeLiquidityLevel('sweep-old-1', 1.105, 'SELL_SIDE', true, SIG - 12 * TF_SEC),
        makeLiquidityLevel('sweep-old-2', 1.106, 'SELL_SIDE', true, SIG - 15 * TF_SEC),
      ]
    ),
    zone: 'PREMIUM',
  });

  const out = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));

  assert.equal(out.decision, 'NO_TRADE');
  assert.deepEqual(out.rejectionReasons, ['ZONE_MISALIGNED', 'NO_FRESH_SWEEP']);
});

test('ORCH 14 — a stop within the minimum tolerance yields SL_TOO_TIGHT', () => {
  const analysis = longTrendAnalysis(SIG, {
    marketStructure: structState({
      structuralBias: 'BULLISH',
      swings: [makeSwingPoint('sw1', 'LOW', 1.095)],
      protectedLow: null,
      breaks: [{ ...brk('BULLISH_BOS', SIG - TF_SEC, SIG - 2 * TF_SEC, 'trig-long'), brokenPrice: 1.1 }],
    }),
    fvg: fvgState(
      [
        {
          id: 'zone-long',
          type: 'BULLISH',
          topPrice: 1.1,
          bottomPrice: 1.1 - TOL_E / 2,
          epoch: SIG - 5 * TF_SEC,
          mitigated: false,
        },
      ],
      []
    ),
  });
  const out = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  assert.deepEqual(out.rejectionReasons, ['SL_TOO_TIGHT']);
});

test('ORCH 15 — an empty target set yields NO_TARGET', () => {
  const out = new SignalEngine().evaluate(
    longTrendAnalysis(SIG, { liquidity: liqState([], []) }),
    ctxAt(SIG, 1.1)
  );
  assert.deepEqual(out.rejectionReasons, ['NO_TARGET']);
});

test('ORCH 16 — targets below MIN_RISK_REWARD yield RR_BELOW_MIN (distinct from NO_TARGET)', () => {
  const near = 1.1 + TOL_E + 0.0001; // beyond E + tolE, but reward far below 2R
  const analysis = longTrendAnalysis(SIG, {
    liquidity: liqState([makeLiquidityLevel('near', near, 'BUY_SIDE', false)], []),
  });
  const out = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  assert.deepEqual(out.rejectionReasons, ['RR_BELOW_MIN']);
  assert.equal(out.takeProfit, null);
});

test('ORCH 17 — an emitted LONG is suppressed as DUPLICATE on re-evaluation', () => {
  const engine = new SignalEngine();
  const analysis = longTrendAnalysis(SIG);
  assert.equal(engine.evaluate(analysis, ctxAt(SIG, 1.1)).decision, 'LONG');
  const second = engine.evaluate(analysis, ctxAt(SIG, 1.1));
  assert.deepEqual(second.rejectionReasons, ['DUPLICATE']);
  assert.equal(second.confidence, null);
});

test('ORCH 18 — a new trigger id yields a new identity and emits again', () => {
  const engine = new SignalEngine();
  assert.equal(engine.evaluate(longTrendAnalysis(SIG), ctxAt(SIG, 1.1)).decision, 'LONG');
  const newTrigger = longTrendAnalysis(SIG, {
    marketStructure: structState({
      structuralBias: 'BULLISH',
      swings: [makeSwingPoint('sw1', 'LOW', 1.095)],
      protectedLow: makeSwingPoint('pl', 'LOW', 1.0985),
      breaks: [{ ...brk('BULLISH_BOS', SIG - TF_SEC, SIG - 2 * TF_SEC, 'trig-long-2'), brokenPrice: 1.1 }],
    }),
  });
  assert.equal(engine.evaluate(newTrigger, ctxAt(SIG, 1.1)).decision, 'LONG');
});

test('ORCH 19 — a gate-rejected candidate does not consume an identity', () => {
  const engine = new SignalEngine();
  const noTarget = longTrendAnalysis(SIG, { liquidity: liqState([], []) });
  assert.deepEqual(engine.evaluate(noTarget, ctxAt(SIG, 1.1)).rejectionReasons, ['NO_TARGET']);
  // Same trigger+zone now fully qualifies: must emit LONG, not DUPLICATE.
  assert.equal(engine.evaluate(longTrendAnalysis(SIG), ctxAt(SIG, 1.1)).decision, 'LONG');
});

test('ORCH 20 — clear resets suppression at all three levels', () => {
  const engine = new SignalEngine();
  const analysis = longTrendAnalysis(SIG);
  engine.evaluate(analysis, ctxAt(SIG, 1.1));
  assert.deepEqual(engine.evaluate(analysis, ctxAt(SIG, 1.1)).rejectionReasons, ['DUPLICATE']);

  engine.clear('EURUSD', '1m');
  assert.equal(engine.evaluate(analysis, ctxAt(SIG, 1.1)).decision, 'LONG');

  engine.clear();
  assert.equal(engine.evaluate(analysis, ctxAt(SIG, 1.1)).decision, 'LONG');

  engine.clear('EURUSD');
  assert.equal(engine.evaluate(analysis, ctxAt(SIG, 1.1)).decision, 'LONG');
});

test('ORCH 21 — duplicate state is isolated per symbol:timeframe', () => {
  const engine = new SignalEngine();
  const base = longTrendAnalysis(SIG);
  assert.equal(engine.evaluate(base, ctxAt(SIG, 1.1)).decision, 'LONG');
  const otherTf: SMCAnalysisResult = { ...base, timeframe: '5m' };
  assert.equal(engine.evaluate(otherTf, ctxAt(SIG, 1.1)).decision, 'LONG');
  assert.deepEqual(engine.evaluate(base, ctxAt(SIG, 1.1)).rejectionReasons, ['DUPLICATE']);
});

test('ORCH 22 — identical calls on fresh engines yield deep-equal output and deterministic timestamp', () => {
  const analysis = longTrendAnalysis(SIG);
  const o1 = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  const o2 = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  assert.deepEqual(o1, o2);
  assert.equal(o1.timestamp, SIG);
  assert.equal(o1.signalEpoch, SIG);
});

test('ORCH 23 — NO_TRADE output is deterministic with null confidence and setup NONE', () => {
  const analysis = longTrendAnalysis(SIG, { liquidity: liqState([], []) });
  const o1 = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  const o2 = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  assert.equal(o1.decision, 'NO_TRADE');
  assert.equal(o1.confidence, null);
  assert.equal(o1.setup, 'NONE');
  assert.deepEqual(o1, o2);
});

// --- Phase 1: additive signalId (notification identity) --------------------------------------

test('NID 1 — an emitted LONG carries the exact symbol:timeframe:triggerId:zoneId identity', () => {
  const out = new SignalEngine().evaluate(longTrendAnalysis(SIG), ctxAt(SIG, 1.1));
  assert.equal(out.decision, 'LONG');
  assert.equal(out.signalId, 'EURUSD:1m:trig-long:zone-long');
});

test('NID 2 — an emitted SHORT carries the exact identity', () => {
  const out = new SignalEngine().evaluate(shortTrendAnalysis(SIG), ctxAt(SIG, 1.1));
  assert.equal(out.decision, 'SHORT');
  assert.equal(out.signalId, 'EURUSD:1m:trig-short:zone-short');
});

test('NID 3 — signalId is deterministic across fresh engines for identical input', () => {
  const analysis = longTrendAnalysis(SIG);
  const o1 = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  const o2 = new SignalEngine().evaluate(analysis, ctxAt(SIG, 1.1));
  assert.equal(o1.signalId, o2.signalId);
});

test('NID 4 — signalId separates by timeframe for the same trigger and zone', () => {
  const base = longTrendAnalysis(SIG);
  const oneMinute = new SignalEngine().evaluate(base, ctxAt(SIG, 1.1));
  const fiveMinute = new SignalEngine().evaluate({ ...base, timeframe: '5m' }, ctxAt(SIG, 1.1));
  assert.equal(oneMinute.signalId, 'EURUSD:1m:trig-long:zone-long');
  assert.equal(fiveMinute.signalId, 'EURUSD:5m:trig-long:zone-long');
  assert.notEqual(oneMinute.signalId, fiveMinute.signalId);
});

test('NID 5 — a NO_TRADE (DUPLICATE) output has no signalId', () => {
  const engine = new SignalEngine();
  const analysis = longTrendAnalysis(SIG);
  assert.equal(engine.evaluate(analysis, ctxAt(SIG, 1.1)).decision, 'LONG');
  const duplicate = engine.evaluate(analysis, ctxAt(SIG, 1.1));
  assert.deepEqual(duplicate.rejectionReasons, ['DUPLICATE']);
  assert.equal(duplicate.signalId, undefined);
});

// --- Observational R:R diagnostics (read-only; never affects selection) -----------------------
// All inputs are SYNTHETIC test values; no genuine market data is represented.

test('RR OBS 1 — the observer receives the exact RR produced by computeRiskReward (synthetic)', () => {
  const entry = 1.1;
  const stopLoss = 1.095;
  const observed: CandidateRiskReward[] = [];
  const res = selectTakeProfit({
    direction: 'BULLISH',
    entry,
    stopLoss,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [
      { id: 'near', price: 1.103 },
      { id: 'far', price: 1.111 },
    ],
    onCandidate: (o) => observed.push(o),
  });
  // near R:R = 0.003/0.005 = 0.6; far R:R = 0.011/0.005 = 2.2 (selected).
  assert.equal(observed.length, 2);
  assert.equal(observed[0].target, 1.103);
  assert.equal(observed[0].riskReward, computeRiskReward('BULLISH', entry, stopLoss, 1.103));
  assert.equal(observed[1].target, 1.111);
  assert.equal(observed[1].riskReward, computeRiskReward('BULLISH', entry, stopLoss, 1.111));
  assert.equal(res.takeProfit, 1.111);
  assert.equal(res.riskReward, observed[1].riskReward);
});

test('RR OBS 2 — bullish and bearish directions are reported correctly (synthetic)', () => {
  const longObserved: CandidateRiskReward[] = [];
  selectTakeProfit({
    direction: 'BULLISH',
    entry: 1.1,
    stopLoss: 1.095,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [{ id: 't', price: 1.12 }],
    onCandidate: (o) => longObserved.push(o),
  });
  assert.equal(longObserved.length, 1);
  assert.equal(longObserved[0].direction, 'BULLISH');
  assert.equal(longObserved[0].riskReward, computeRiskReward('BULLISH', 1.1, 1.095, 1.12));

  const shortObserved: CandidateRiskReward[] = [];
  selectTakeProfit({
    direction: 'BEARISH',
    entry: 1.1,
    stopLoss: 1.105,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [{ id: 't', price: 1.08 }],
    onCandidate: (o) => shortObserved.push(o),
  });
  assert.equal(shortObserved.length, 1);
  assert.equal(shortObserved[0].direction, 'BEARISH');
  assert.equal(shortObserved[0].riskReward, computeRiskReward('BEARISH', 1.1, 1.105, 1.08));
});

test('RR OBS 3 — the observed minimum equals the configured MIN_RISK_REWARD (2.0)', () => {
  assert.equal(DEFAULT_SIGNAL_ENGINE_CONFIG.MIN_RISK_REWARD, 2.0);
  const observed: CandidateRiskReward[] = [];
  selectTakeProfit({
    direction: 'BULLISH',
    entry: 1.1,
    stopLoss: 1.095,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [{ id: 't', price: 1.12 }],
    onCandidate: (o) => observed.push(o),
  });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].minimum, 2.0);
  assert.equal(observed[0].minimum, DEFAULT_SIGNAL_ENGINE_CONFIG.MIN_RISK_REWARD);
});

test('RR OBS 4 — a candidate exactly at 2.0 is observed as meeting the minimum (synthetic)', () => {
  const entry = 100;
  const risk = 1 / 128; // exact power of two keeps the boundary numerically exact
  const stopLoss = entry - risk;
  const target = entry + 2 * risk;
  const observed: CandidateRiskReward[] = [];
  const res = selectTakeProfit({
    direction: 'BULLISH',
    entry,
    stopLoss,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [{ id: 'b', price: target }],
    onCandidate: (o) => observed.push(o),
  });
  assert.equal(observed[0].riskReward, 2.0);
  assert.equal(observed[0].meetsMinimum, true);
  assert.equal(observed[0].selected, true);
  assert.equal(observed[0].rejection, null);
  assert.equal(res.takeProfit, target);
});

test('RR OBS 5 — candidates below 2.0 are observed as rejected with RR_BELOW_MIN (synthetic)', () => {
  const observed: CandidateRiskReward[] = [];
  const res = selectTakeProfit({
    direction: 'BULLISH',
    entry: 1.1,
    stopLoss: 1.095,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [
      { id: 'a', price: 1.103 },
      { id: 'b', price: 1.104 },
    ],
    onCandidate: (o) => observed.push(o),
  });
  assert.equal(res.rejection, 'RR_BELOW_MIN');
  assert.equal(res.takeProfit, null);
  assert.equal(observed.length, 2);
  for (const o of observed) {
    assert.equal(o.meetsMinimum, false);
    assert.equal(o.selected, false);
    assert.equal(o.rejection, 'RR_BELOW_MIN');
  }
});

test('RR OBS 6 — non-positive risk yields a null RR and preserves RR_BELOW_MIN (synthetic)', () => {
  const observed: CandidateRiskReward[] = [];
  const res = selectTakeProfit({
    direction: 'BULLISH',
    entry: 1.1,
    stopLoss: 1.11, // stop above entry ⇒ negative risk
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [{ id: 'a', price: 1.11 }],
    onCandidate: (o) => observed.push(o),
  });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].riskReward, null);
  assert.equal(observed[0].meetsMinimum, false);
  assert.equal(res.rejection, 'RR_BELOW_MIN');
  assert.equal(res.riskReward, null);
});

test('RR OBS 7 — stopLoss equal to entry yields NO_TARGET and no candidate observations', () => {
  const observed: CandidateRiskReward[] = [];
  const res = selectTakeProfit({
    direction: 'BULLISH',
    entry: 1.1,
    stopLoss: 1.1,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [{ id: 'a', price: 1.11 }],
    onCandidate: (o) => observed.push(o),
  });
  assert.deepEqual(res, { takeProfit: null, riskReward: null, rejection: 'NO_TARGET' });
  assert.equal(observed.length, 0);
});

test('RR OBS 8 — multiple candidates are observed in their existing evaluation order (synthetic)', () => {
  const observed: CandidateRiskReward[] = [];
  selectTakeProfit({
    direction: 'BULLISH',
    entry: 1.1,
    stopLoss: 1.095,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [
      { id: 'c', price: 1.103 },
      { id: 'a', price: 1.101 },
      { id: 'b', price: 1.102 },
    ],
    onCandidate: (o) => observed.push(o),
  });
  assert.deepEqual(
    observed.map((o) => o.target),
    [1.101, 1.102, 1.103]
  );
});

test('RR OBS 9 — a throwing observer cannot change the decision or crash evaluation', () => {
  const base = {
    direction: 'BULLISH' as const,
    entry: 1.1,
    stopLoss: 1.095,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [
      { id: 'a', price: 1.103 },
      { id: 'b', price: 1.111 },
    ],
  };
  const baseline = selectTakeProfit(base);
  const withThrower = selectTakeProfit({
    ...base,
    onCandidate: () => {
      throw new Error('observer boom');
    },
  });
  assert.deepEqual(withThrower, baseline);
  assert.equal(withThrower.takeProfit, 1.111);
});

test('RR OBS 10 — with no observer the result matches the original behavior (synthetic)', () => {
  const res = selectTakeProfit({
    direction: 'BULLISH',
    entry: 1.1,
    stopLoss: 1.095,
    tolE: TOL,
    config: DEFAULT_SIGNAL_ENGINE_CONFIG,
    candidates: [{ id: 'a', price: 1.111 }],
  });
  assert.equal(res.takeProfit, 1.111);
  assert.equal(res.rejection, null);
  assert.ok(res.riskReward !== null && Math.abs(res.riskReward - 2.2) < 1e-9);
});

test('RR OBS 11 — an engine observer is enriched with symbol/timeframe and never changes the signal', () => {
  const observed: RiskRewardObservation[] = [];
  const withObserver = new SignalEngine({
    riskRewardObserver: (o) => observed.push(o),
  }).evaluate(longTrendAnalysis(SIG), ctxAt(SIG, 1.1));
  const baseline = new SignalEngine().evaluate(longTrendAnalysis(SIG), ctxAt(SIG, 1.1));
  assert.deepEqual(withObserver, baseline);
  assert.ok(observed.length > 0);
  for (const o of observed) {
    assert.equal(o.symbol, 'EURUSD');
    assert.equal(o.timeframe, '1m');
    assert.equal(o.minimum, 2.0);
  }
});

test('RR OBS 12 — a throwing engine observer cannot change the emitted signal', () => {
  const withThrower = new SignalEngine({
    riskRewardObserver: () => {
      throw new Error('observer boom');
    },
  }).evaluate(longTrendAnalysis(SIG), ctxAt(SIG, 1.1));
  const baseline = new SignalEngine().evaluate(longTrendAnalysis(SIG), ctxAt(SIG, 1.1));
  assert.deepEqual(withThrower, baseline);
  assert.equal(withThrower.decision, 'LONG');
});

test('RR OBS 13 — invalid BOS context yields NO_CONTEXT with zero observer candidates (synthetic)', () => {
  const base = longTrendAnalysis(SIG);
  const analysis: SMCAnalysisResult = {
    ...base,
    marketStructure: { ...base.marketStructure, structuralBias: 'BEARISH' },
  };
  const observed: RiskRewardObservation[] = [];
  const engine = new SignalEngine({ riskRewardObserver: (o) => observed.push(o) });

  const out = engine.evaluate(analysis, ctxAt(SIG, 1.1));
  assert.equal(out.decision, 'NO_TRADE');
  assert.deepEqual(out.rejectionReasons, ['NO_CONTEXT']);
  assert.equal(observed.length, 0);

  // Sanity: the same observer-equipped engine still reaches the R:R gate on the
  // unmodified bullish analysis, so the zero-observation result above is caused
  // solely by the contradicting structural bias, not by a broken observer path.
  const control = engine.evaluate(base, ctxAt(SIG, 1.1));
  assert.equal(control.decision, 'LONG');
  assert.ok(observed.length > 0);
});
