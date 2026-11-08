import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateRisk,
  type RiskCalculationInput,
  type RiskCalculationSuccess,
  type RiskDirection,
} from '../lib/risk/engine';
import {
  getRiskInstrumentSpec,
  listRiskInstrumentSpecs,
} from '../lib/risk/instruments';
import {
  applySignalToRiskForm,
  createRiskFormState,
  hasValidSignalId,
  isActionableRiskSignal,
  isActionableRiskSignalForSymbol,
  isSignalForContext,
  isSignalForTimeframe,
  parseSignalId,
  resetRiskFormForSymbol,
  riskFormToCalculationInput,
  riskSignalKey,
} from '../lib/risk/form-state';
import type { SignalOutput } from '../lib/signals/signal-engine';

function close(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

function ok(input: RiskCalculationInput): RiskCalculationSuccess {
  const result = calculateRisk(input);
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  return result as RiskCalculationSuccess;
}

const longSignal: SignalOutput = {
  decision: 'LONG',
  confidence: 80,
  setup: 'TREND_CONTINUATION',
  entry: 1.1,
  stopLoss: 1.098,
  takeProfit: 1.104,
  riskReward: 2,
  reason: 'test',
  timestamp: 1750000000,
  signalId: 'EURUSD:1m:trig:zone',
};

test('RISK SPECS - project metadata covers every supported instrument without inventing contracts', () => {
  const specs = listRiskInstrumentSpecs();
  assert.equal(specs.length, 9);
  assert.deepEqual(
    specs.map((spec) => spec.id),
    ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD', 'V75', 'V10', 'BOOM1000', 'CRASH1000']
  );
  for (const spec of specs) {
    assert.ok(spec.tickSize > 0);
    assert.ok(spec.pipValue > 0);
    assert.equal(spec.contractSize, null);
    assert.equal(spec.contractSpecSource, 'not-configured');
  }

  const eurusd = getRiskInstrumentSpec('EURUSD');
  assert.equal(eurusd?.quoteCurrency, 'USD');
  assert.equal(eurusd?.pipValue, 0.0001);
  assert.equal(eurusd?.tickSize, 0.00001);
  assert.equal(eurusd?.unitLabel, 'base units');

  const usdjpy = getRiskInstrumentSpec('USDJPY');
  assert.equal(usdjpy?.quoteCurrency, 'JPY');
  assert.equal(usdjpy?.pipValue, 0.01);

  const xauusd = getRiskInstrumentSpec('XAUUSD');
  assert.equal(xauusd?.quoteCurrency, 'USD');
  assert.equal(xauusd?.pipValue, 0.1);
  assert.equal(xauusd?.unitLabel, 'troy oz');

  assert.equal(getRiskInstrumentSpec('UNKNOWN'), null);
});

test('RISK ENGINE - EURUSD LONG sizes in base units and computes exact risk/reward', () => {
  const result = ok({
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.098,
    takeProfit: 1.104,
  });

  close(result.riskAmount, 100);
  close(result.stopDistance, 0.002);
  close(result.targetDistance, 0.004);
  close(result.stopPips, 20);
  close(result.targetPips, 40);
  close(result.stopTicks, 200);
  close(result.targetTicks, 400);
  close(result.positionSizeUnits, 50000);
  assert.equal(result.positionSizeLots, null);
  assert.equal(result.sizingBasis, 'units');
  close(result.potentialLoss, 100);
  close(result.potentialProfit, 200);
  close(result.riskReward, 2);
  close(result.monetaryRiskReward, 2);
  close(result.balanceAfterStop, 9900);
  close(result.balanceAfterTarget, 10200);
  assert.equal(result.quoteToAccountRate, 1);
});

test('RISK ENGINE - XAUUSD SHORT sizes in troy ounces', () => {
  const result = ok({
    symbolId: 'XAUUSD',
    direction: 'SHORT',
    balance: 5000,
    riskPercent: 2,
    entry: 2000,
    stopLoss: 2005,
    takeProfit: 1990,
  });

  close(result.riskAmount, 100);
  close(result.stopDistance, 5);
  close(result.targetDistance, 10);
  close(result.stopPips, 50);
  close(result.targetPips, 100);
  close(result.positionSizeUnits, 20);
  assert.equal(result.unitLabel, 'troy oz');
  close(result.potentialLoss, 100);
  close(result.potentialProfit, 200);
  close(result.balanceAfterStop, 4900);
  close(result.balanceAfterTarget, 5200);
});

test('RISK ENGINE - synthetic V75 uses linear index units and never assumes a lot size', () => {
  const result = ok({
    symbolId: 'V75',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 100000,
    stopLoss: 99000,
    takeProfit: 102000,
  });

  close(result.riskAmount, 100);
  close(result.stopDistance, 1000);
  close(result.targetDistance, 2000);
  close(result.positionSizeUnits, 0.1);
  assert.equal(result.positionSizeLots, null);
  assert.equal(result.sizingBasis, 'units');
  close(result.potentialLoss, 100);
  close(result.potentialProfit, 200);
  close(result.riskReward, 2);
});

test('RISK ENGINE - USDJPY sizes from the SL exit rate and converts profit at TP', () => {
  const result = ok({
    symbolId: 'USDJPY',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 150,
    stopLoss: 149.5,
    takeProfit: 151,
  });

  close(result.quoteToAccountRate, 1 / 150);
  close(result.stopQuoteToAccountRate, 1 / 149.5);
  close(result.targetQuoteToAccountRate, 1 / 151);
  assert.equal(result.conversionSource, 'derived');
  assert.equal(result.conversionApproximation, true);
  close(result.stopPips, 50);
  close(result.targetPips, 100);
  close(result.positionSizeUnits, 29900);
  close(result.potentialLoss, 100);
  close(result.potentialProfit, 29900 / 151);
  close(result.balanceAfterStop, 9900);
  close(result.balanceAfterTarget, 10000 + 29900 / 151);
  assert.ok(
    Math.abs(result.monetaryRiskReward - result.riskReward) > 1e-6,
    'monetary R:R must be calculated separately from price R:R'
  );
  close(result.riskReward, 2);
  close(result.monetaryRiskReward, (29900 / 151) / 100);
  assert.ok(
    result.warnings.some((warning) => warning.includes('stop-loss exit price'))
  );
});

test('RISK ENGINE - USDJPY LONG respects the $100 risk budget at the stop', () => {
  const result = ok({
    symbolId: 'USDJPY',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 150,
    stopLoss: 149.5,
    takeProfit: 151,
  });

  close(result.riskAmount, 100);
  close(result.positionSizeUnits, 29900);
  close(result.potentialLoss, 100);
  assert.ok(result.potentialLoss <= result.riskAmount + 1e-9);
  close(result.riskReward, 2);
  close(result.monetaryRiskReward, (29900 / 151) / 100);
  close(result.positionSizeUnits * result.stopDistance * result.stopQuoteToAccountRate, 100);
});

test('RISK ENGINE - USDJPY SHORT respects the $100 risk budget at the stop', () => {
  const result = ok({
    symbolId: 'USDJPY',
    direction: 'SHORT',
    balance: 10000,
    riskPercent: 1,
    entry: 150,
    stopLoss: 150.5,
    takeProfit: 149,
  });

  close(result.riskAmount, 100);
  close(result.positionSizeUnits, 30100);
  close(result.potentialLoss, 100);
  assert.ok(result.potentialLoss <= result.riskAmount + 1e-9);
  close(result.potentialProfit, 30100 / 149);
  close(result.riskReward, 2);
  close(result.monetaryRiskReward, (30100 / 149) / 100);
  close(result.positionSizeUnits * result.stopDistance * result.stopQuoteToAccountRate, 100);
});

test('RISK ENGINE - USDJPY extreme stop cannot inflate the loss beyond the risk budget', () => {
  const result = ok({
    symbolId: 'USDJPY',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 150,
    stopLoss: 1,
    takeProfit: 151,
  });

  close(result.riskAmount, 100);
  close(result.potentialLoss, 100);
  assert.ok(result.potentialLoss <= result.riskAmount + 1e-9);
  assert.ok(
    result.potentialLoss < 1000,
    `expected the loss to stay near the $100 budget, got ${result.potentialLoss}`
  );
  close(result.positionSizeUnits, 100 / 149);
  close(result.stopQuoteToAccountRate, 1);
  close(result.positionSizeUnits * result.stopDistance * result.stopQuoteToAccountRate, 100);
});

test('RISK ENGINE - USDJPY lot rounding only lowers, never exceeds, the risk budget', () => {
  const result = ok({
    symbolId: 'USDJPY',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 150,
    stopLoss: 149.5,
    takeProfit: 151,
    contractOverride: {
      contractSize: 100000,
      minLot: 0.01,
      maxLot: 100,
      lotStep: 0.01,
    },
  });

  assert.equal(result.sizingBasis, 'lots');
  close(result.positionSizeLots ?? 0, 0.29);
  close(result.positionSizeUnits, 29000);
  close(result.potentialLoss, (0.5 * 29000) / 149.5);
  assert.ok(result.potentialLoss <= result.riskAmount);
  close(result.monetaryRiskReward, result.potentialProfit / result.potentialLoss);
  close(
    result.positionSizeUnits * result.stopDistance * result.stopQuoteToAccountRate,
    result.potentialLoss
  );
});

test('RISK ENGINE - explicit conversion supports a non-USD account', () => {
  const result = ok({
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.098,
    takeProfit: 1.104,
    accountCurrency: 'EUR',
    quoteToAccountRate: 0.9,
  });

  close(result.riskAmount, 100);
  close(result.positionSizeUnits, 100 / (0.002 * 0.9));
  close(result.potentialLoss, 100);
  close(result.potentialProfit, 200);
  assert.equal(result.accountCurrency, 'EUR');
  assert.equal(result.quoteCurrency, 'USD');
  assert.equal(result.conversionSource, 'manual');
  assert.equal(result.conversionIsManual, true);
  assert.ok(
    result.warnings.some((warning) => warning.includes('user-provided'))
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes('freshness cannot be verified'))
  );
});

test('RISK ENGINE - same-currency manual conversion is ignored and forced to 1', () => {
  const result = ok({
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.098,
    takeProfit: 1.104,
    accountCurrency: 'USD',
    quoteToAccountRate: 1.5,
  });

  close(result.quoteToAccountRate, 1);
  close(result.stopQuoteToAccountRate, 1);
  close(result.targetQuoteToAccountRate, 1);
  assert.equal(result.conversionSource, 'identity');
  assert.equal(result.conversionIsManual, false);
  assert.ok(result.warnings.some((warning) => warning.includes('identity rate of 1')));
});

test('RISK ENGINE - an inverted USDJPY conversion rate is rejected', () => {
  const result = calculateRisk({
    symbolId: 'USDJPY',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 150,
    stopLoss: 149.5,
    takeProfit: 151,
    accountCurrency: 'USD',
    quoteToAccountRate: 150,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'INVALID_INPUT');
    assert.match(result.message, /inverted/i);
  }
});

test('RISK ENGINE - missing conversion is rejected instead of assumed', () => {
  const result = calculateRisk({
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.098,
    takeProfit: 1.104,
    accountCurrency: 'EUR',
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'CONVERSION_REQUIRED');
});

test('RISK ENGINE - verified lot overrides round down and recompute actual risk', () => {
  const result = ok({
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.0997,
    takeProfit: 1.1006,
    contractOverride: {
      contractSize: 100000,
      minLot: 0.01,
      maxLot: 5,
      lotStep: 0.01,
    },
  });

  close(result.positionSizeLots ?? 0, 3.33);
  close(result.positionSizeUnits, 333000);
  close(result.potentialLoss, 99.9);
  close(result.potentialProfit, 199.8);
  assert.equal(result.sizingBasis, 'lots');
});

test('RISK ENGINE - lot constraints cap size and report the actual risk', () => {
  const result = ok({
    symbolId: 'EURUSD',
    direction: 'SHORT',
    balance: 10000,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.1001,
    takeProfit: 1.098,
    contractOverride: {
      contractSize: 100000,
      minLot: 0.01,
      maxLot: 5,
      lotStep: 0.01,
    },
  });

  close(result.positionSizeLots ?? 0, 5);
  close(result.potentialLoss, 50);
  close(result.potentialProfit, 1000);
  assert.ok(result.warnings.some((warning) => warning.includes('maximum lot')));
});

test('RISK ENGINE - a position below the configured minimum lot is rejected', () => {
  const result = calculateRisk({
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 100,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.0,
    takeProfit: 1.2,
    contractOverride: {
      contractSize: 100000,
      minLot: 0.01,
      maxLot: 100,
      lotStep: 0.01,
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'POSITION_BELOW_MINIMUM');
});

test('RISK ENGINE - incomplete contract specifications fall back to unit sizing', () => {
  const result = ok({
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.098,
    takeProfit: 1.104,
    contractOverride: { contractSize: 100000 },
  });

  assert.equal(result.sizingBasis, 'units');
  assert.equal(result.positionSizeLots, null);
  assert.equal(result.contractSpecComplete, false);
  close(result.positionSizeUnits, 50000);
  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.includes('all four broker specifications') &&
        warning.includes('lot step') &&
        warning.includes('not applied')
    )
  );
});

test('RISK ENGINE - lot limits without a contract size are rejected, never silently ignored', () => {
  const result = calculateRisk({
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.098,
    takeProfit: 1.104,
    contractOverride: {
      minLot: 0.01,
      maxLot: 5,
      lotStep: 0.01,
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'INVALID_CONTRACT_SPEC');
    assert.match(result.message, /without a contract size/i);
  }
});

test('RISK ENGINE - max lot is applied before the step round-down and risk is recalculated', () => {
  const result = ok({
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.0997,
    takeProfit: 1.1006,
    contractOverride: {
      contractSize: 100000,
      minLot: 0.01,
      maxLot: 3.3,
      lotStep: 0.01,
    },
  });

  close(result.positionSizeLots ?? 0, 3.3);
  close(result.positionSizeUnits, 330000);
  close(result.potentialLoss, 99);
  close(result.potentialProfit, 198);
  assert.ok(result.warnings.some((warning) => warning.includes('maximum lot')));
});

test('RISK ENGINE - misaligned maximum lot and lot step are rejected', () => {
  const result = calculateRisk({
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.098,
    takeProfit: 1.104,
    contractOverride: {
      contractSize: 100000,
      minLot: 0.01,
      maxLot: 5.005,
      lotStep: 0.01,
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'INVALID_CONTRACT_SPEC');
    assert.match(result.message, /multiple of the lot step/i);
  }
});

test('RISK ENGINE - inconsistent minimum, maximum and step combinations are rejected', () => {
  const base: RiskCalculationInput = {
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.098,
    takeProfit: 1.104,
  };

  const cases: Array<[NonNullable<RiskCalculationInput['contractOverride']>, RegExp]> = [
    [
      { contractSize: 100000, minLot: 0.001, maxLot: 0.005, lotStep: 0.01 },
      /Lot step cannot exceed the maximum lot/i,
    ],
    [
      { contractSize: 100000, minLot: 0.015, maxLot: 5, lotStep: 0.01 },
      /Minimum lot must align/i,
    ],
    [
      { contractSize: 100000, minLot: 0.1, maxLot: 5.05, lotStep: 0.1 },
      /multiple of the lot step/i,
    ],
  ];

  for (const [contractOverride, pattern] of cases) {
    const result = calculateRisk({ ...base, contractOverride });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'INVALID_CONTRACT_SPEC');
      assert.match(result.message, pattern);
    }
  }
});

test('RISK ENGINE - a stop distance below the instrument tick size is rejected', () => {
  const result = calculateRisk({
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.099999,
    takeProfit: 1.1001,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'STOP_BELOW_TICK_SIZE');
    assert.match(result.message, /minimum price increment/i);
  }
});

test('RISK ENGINE - excessive position size produces a safety warning', () => {
  const result = ok({
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 100,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.09999,
    takeProfit: 1.10001,
  });

  assert.equal(result.isExtremePosition, true);
  assert.ok(
    result.warnings.some((warning) => warning.includes('safety threshold'))
  );
});

test('RISK ENGINE - synthetic instruments expose points and an estimated exposure assumption', () => {
  const result = ok({
    symbolId: 'V75',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 100000,
    stopLoss: 99000,
    takeProfit: 102000,
  });

  assert.equal(result.isSynthetic, true);
  assert.equal(result.monetaryEstimate, true);
  assert.equal(result.distanceUnitLabel, 'points');
  close(result.stopDistanceUnits, 1000);
  close(result.targetDistanceUnits, 2000);
  assert.equal(result.pointValueMultiplier, 1);
  assert.match(result.exposureAssumption ?? '', /linear exposure/i);
});

test('RISK ENGINE - invalid inputs are rejected with specific codes', () => {
  const base: RiskCalculationInput = {
    symbolId: 'EURUSD',
    direction: 'LONG',
    balance: 10000,
    riskPercent: 1,
    entry: 1.1,
    stopLoss: 1.098,
    takeProfit: 1.104,
  };

  const cases: Array<[Partial<RiskCalculationInput>, string]> = [
    [{ symbolId: 'NOPE' }, 'UNSUPPORTED_INSTRUMENT'],
    [{ balance: 0 }, 'INVALID_INPUT'],
    [{ balance: Number.NaN }, 'INVALID_INPUT'],
    [{ riskPercent: 0 }, 'INVALID_INPUT'],
    [{ riskPercent: 101 }, 'INVALID_INPUT'],
    [{ entry: 0 }, 'INVALID_INPUT'],
    [{ stopLoss: 1.101 }, 'INVALID_LEVELS'],
    [{ takeProfit: 1.099 }, 'INVALID_LEVELS'],
    [{ stopLoss: 1.1 }, 'INVALID_LEVELS'],
    [{ quoteToAccountRate: 0 }, 'INVALID_INPUT'],
    [
      { contractOverride: { contractSize: 100000, minLot: 1, maxLot: 0.1 } },
      'INVALID_CONTRACT_SPEC',
    ],
    [{ contractOverride: { contractSize: 0 } }, 'INVALID_CONTRACT_SPEC'],
    [{ direction: 'SIDEWAYS' as unknown as RiskDirection }, 'INVALID_DIRECTION'],
  ];

  for (const [override, code] of cases) {
    const result = calculateRisk({ ...base, ...override });
    assert.equal(result.ok, false, `${code} should fail`);
    if (!result.ok) assert.equal(result.code, code);
  }
});

test('RISK FORM - a genuine signal populates entry, SL, TP and direction', () => {
  const state = createRiskFormState(longSignal, 'EURUSD', '1m');
  assert.equal(state.direction, 'LONG');
  assert.equal(state.entry, '1.1');
  assert.equal(state.stopLoss, '1.098');
  assert.equal(state.takeProfit, '1.104');
  assert.equal(state.source, 'signal');
  assert.equal(state.balance, '10000');
  assert.equal(state.riskPercent, '1');
});

test('RISK FORM - manual edits survive until a new signal is applied', () => {
  const state = createRiskFormState(longSignal, 'EURUSD', '1m');
  const edited = { ...state, entry: '1.2', source: 'manual' as const };
  assert.equal(edited.entry, '1.2');

  const nextSignal: SignalOutput = {
    ...longSignal,
    entry: 1.15,
    stopLoss: 1.145,
    takeProfit: 1.16,
    signalId: 'EURUSD:1m:trig2:zone',
    timestamp: 1750000300,
  };
  const applied = applySignalToRiskForm(edited, nextSignal);
  assert.equal(applied.entry, '1.15');
  assert.equal(applied.stopLoss, '1.145');
  assert.equal(applied.takeProfit, '1.16');
  assert.equal(applied.source, 'signal');
  assert.equal(applied.balance, '10000');
});

test('RISK FORM - NO_TRADE and incomplete signals are not actionable', () => {
  assert.equal(isActionableRiskSignal(null), false);
  assert.equal(
    isActionableRiskSignal({
      ...longSignal,
      decision: 'NO_TRADE',
      entry: null,
      stopLoss: null,
      takeProfit: null,
    }),
    false
  );
  assert.equal(isActionableRiskSignal({ ...longSignal, takeProfit: null }), false);
  assert.equal(riskSignalKey(null, 'EURUSD', '1m'), null);
  assert.notEqual(riskSignalKey(longSignal, 'EURUSD', '1m'), null);
});

test('RISK FORM - a symbol change keeps account settings but clears pair levels', () => {
  const state = createRiskFormState(longSignal, 'EURUSD', '1m');
  const switched = resetRiskFormForSymbol(
    {
      ...state,
      balance: '25000',
      riskPercent: '0.5',
      accountCurrency: 'EUR',
      contractSize: '100000',
      lotStep: '0.01',
    },
    null,
    'XAUUSD'
  );

  assert.equal(switched.balance, '25000');
  assert.equal(switched.riskPercent, '0.5');
  assert.equal(switched.accountCurrency, 'EUR');
  assert.equal(switched.entry, '');
  assert.equal(switched.stopLoss, '');
  assert.equal(switched.takeProfit, '');
  assert.equal(switched.contractSize, '');
  assert.equal(switched.lotStep, '');
  assert.equal(switched.source, 'manual');
});

test('RISK FORM - parsing handles commas, optional fields and validation', () => {
  const state = createRiskFormState(longSignal, 'EURUSD', '1m');
  const parsed = riskFormToCalculationInput(
    {
      ...state,
      balance: '10,000',
      conversionRate: '0.9',
      contractSize: '100000',
      lotStep: '0.01',
      minLot: '0.01',
      maxLot: '5',
    },
    'EURUSD'
  );
  assert.equal(parsed.error, undefined);
  assert.ok(parsed.input);
  assert.equal(parsed.input.balance, 10000);
  assert.equal(parsed.input.contractOverride?.contractSize, 100000);

  assert.match(
    riskFormToCalculationInput({ ...state, entry: '' }, 'EURUSD').error ?? '',
    /Entry/
  );
  assert.match(
    riskFormToCalculationInput({ ...state, balance: 'abc' }, 'EURUSD').error ?? '',
    /balance/i
  );
  assert.match(
    riskFormToCalculationInput({ ...state, accountCurrency: 'US' }, 'EURUSD').error ?? '',
    /three-letter/
  );
  assert.match(
    riskFormToCalculationInput({ ...state, lotStep: '-1' }, 'EURUSD').error ?? '',
    /Lot step/
  );
});

test('RISK FORM - a valid signalId is required before automatic population', () => {
  const withoutId = { ...longSignal, signalId: undefined };
  assert.equal(hasValidSignalId(withoutId), false);
  assert.equal(parseSignalId(undefined), null);
  assert.equal(isActionableRiskSignal(withoutId), false);

  const state = createRiskFormState(withoutId, 'EURUSD', '1m');
  assert.equal(state.source, 'manual');
  assert.equal(state.entry, '');
  assert.equal(riskSignalKey(withoutId, 'EURUSD', '1m'), null);
});

test('RISK FORM - a malformed signalId is not actionable', () => {
  assert.equal(parseSignalId('not-a-signal'), null);
  assert.equal(parseSignalId('EURUSD:1m'), null);
  assert.equal(isActionableRiskSignal({ ...longSignal, signalId: 'EURUSD' }), false);
});

test('RISK FORM - parseSignalId requires exactly four components', () => {
  assert.deepEqual(parseSignalId('EURUSD:1m:trig:zone'), {
    symbol: 'EURUSD',
    timeframe: '1m',
    triggerId: 'trig',
    zoneId: 'zone',
  });

  const nestedId =
    'EURUSD:1m:EURUSD:1m:BULLISH_CHOCH:1750000000:1749999900:' +
    'EURUSD:1m:FVG:BULLISH:1750000000';
  assert.deepEqual(parseSignalId(nestedId), {
    symbol: 'EURUSD',
    timeframe: '1m',
    triggerId: 'EURUSD:1m:BULLISH_CHOCH:1750000000:1749999900',
    zoneId: 'EURUSD:1m:FVG:BULLISH:1750000000',
  });
  assert.equal(
    isSignalForContext(
      { ...longSignal, signalId: nestedId },
      'EURUSD',
      '1m'
    ),
    true
  );

  const rejected = [
    'EURUSD:1m:trig',
    'EURUSD:1m',
    'EURUSD',
    '',
    'EURUSD:1m:trig:zone:extra',
    ':1m:trig:zone',
    'EURUSD::trig:zone',
    'EURUSD:1m::zone',
    'EURUSD:1m:trig:',
  ];
  for (const signalId of rejected) {
    assert.equal(parseSignalId(signalId), null, `${signalId} should be rejected`);
    assert.equal(
      isActionableRiskSignal({ ...longSignal, signalId }),
      false,
      `${signalId} should not be actionable`
    );
  }
});

test('RISK FORM - genuine nested producer identities are accepted', () => {
  const identities = [
    {
      symbol: 'EURUSD',
      timeframe: '1m',
      signalId:
        'EURUSD:1m:EURUSD:1m:BULLISH_BOS:1750000000:1749999900:' +
        'EURUSD:1m:FVG:BULLISH:1750000000',
      triggerId: 'EURUSD:1m:BULLISH_BOS:1750000000:1749999900',
      zoneId: 'EURUSD:1m:FVG:BULLISH:1750000000',
    },
    {
      symbol: 'GBPUSD',
      timeframe: '5m',
      signalId:
        'GBPUSD:5m:GBPUSD:5m:BEARISH_CHOCH:1750000100:1750000000:' +
        'GBPUSD:5m:OB:BEARISH:1750000050',
      triggerId: 'GBPUSD:5m:BEARISH_CHOCH:1750000100:1750000000',
      zoneId: 'GBPUSD:5m:OB:BEARISH:1750000050',
    },
    {
      symbol: 'USDJPY',
      timeframe: '15m',
      signalId:
        'USDJPY:15m:USDJPY:15m:BULLISH_CHOCH:1750000200:1750000100:' +
        'USDJPY:15m:LIQ:BUY_SIDE:1750000150',
      triggerId: 'USDJPY:15m:BULLISH_CHOCH:1750000200:1750000100',
      zoneId: 'USDJPY:15m:LIQ:BUY_SIDE:1750000150',
    },
    {
      symbol: 'EURUSD',
      timeframe: '1m',
      signalId:
        'EURUSD:1m:EURUSD:1m:BEARISH_BOS:1750000300:1750000200:' +
        'EURUSD:1m:LIQ:SELL_SIDE:1750000250',
      triggerId: 'EURUSD:1m:BEARISH_BOS:1750000300:1750000200',
      zoneId: 'EURUSD:1m:LIQ:SELL_SIDE:1750000250',
    },
    {
      symbol: 'EURUSD',
      timeframe: '1m',
      signalId:
        'EURUSD:1m:EURUSD:1m:BULLISH_BOS:1750000400:1750000300:' +
        'EURUSD:1m:LIQ:EQH:1750000350',
      triggerId: 'EURUSD:1m:BULLISH_BOS:1750000400:1750000300',
      zoneId: 'EURUSD:1m:LIQ:EQH:1750000350',
    },
    {
      symbol: 'EURUSD',
      timeframe: '1m',
      signalId:
        'EURUSD:1m:EURUSD:1m:BEARISH_BOS:1750000500:1750000400:' +
        'EURUSD:1m:LIQ:EQL:1750000450',
      triggerId: 'EURUSD:1m:BEARISH_BOS:1750000500:1750000400',
      zoneId: 'EURUSD:1m:LIQ:EQL:1750000450',
    },
  ];

  for (const identity of identities) {
    assert.deepEqual(parseSignalId(identity.signalId), {
      symbol: identity.symbol,
      timeframe: identity.timeframe,
      triggerId: identity.triggerId,
      zoneId: identity.zoneId,
    });
    assert.equal(
      isActionableRiskSignal({ ...longSignal, signalId: identity.signalId }),
      true
    );
    assert.equal(
      isSignalForContext(
        { ...longSignal, signalId: identity.signalId },
        identity.symbol,
        identity.timeframe
      ),
      true
    );
  }
});

test('RISK FORM - malformed nested producer identities are rejected', () => {
  const rejected = [
    'EURUSD:1m:EURUSD:1m::EURUSD:1m:FVG:BULLISH:1750000000',
    'EURUSD:1m:EURUSD:1m:BULLISH_BOS::1749999900:EURUSD:1m:FVG:BULLISH:1750000000',
    'EURUSD:1m:EURUSD:1m:BULLISH_BOS:1750000000::EURUSD:1m:FVG:BULLISH:1750000000',
    'EURUSD:1m:EURUSD:1m:BULLISH_BOS:1750000000:1749999900:EURUSD:1m:FVG::1750000000',
    'EURUSD:1m:EURUSD:1m:BULLISH_BOS:1750000000:1749999900:EURUSD:1m:FVG:BULLISH:',
    'EURUSD:1m:EURUSD:1m:BULLISH_BOS:1750000000:EURUSD:1m:FVG:BULLISH:1750000000',
    'EURUSD:1m:GBPUSD:1m:BULLISH_BOS:1750000000:1749999900:EURUSD:1m:FVG:BULLISH:1750000000',
    'EURUSD:1m:EURUSD:1m:BULLISH_BOS:1750000000:1749999900:GBPUSD:1m:FVG:BULLISH:1750000000',
    'EURUSD:1m:EURUSD:1m:BULLISH_BOS:1750000000:1749999900:EURUSD:1m:FVG:BULLISH:1750000000:extra',
    'EURUSD:1m:EURUSD:1m:BULLISH_BOS:1750000000:1749999900:extra:EURUSD:1m:FVG:BULLISH:1750000000',
    'EURUSD:1m:EURUSD:1m:INITIAL_BULLISH_BREAK:1750000000:1749999900:EURUSD:1m:FVG:BULLISH:1750000000',
    'EURUSD:1m:EURUSD:1m:BULLISH_BOS:not-an-epoch:1749999900:EURUSD:1m:FVG:BULLISH:1750000000',
    'EURUSD:1m:EURUSD:1m:BULLISH_BOS:1750000000:1749999900:EURUSD:1m:UNKNOWN:BULLISH:1750000000',
  ];

  for (const signalId of rejected) {
    assert.equal(parseSignalId(signalId), null, `${signalId} should be rejected`);
    assert.equal(
      isActionableRiskSignal({ ...longSignal, signalId }),
      false,
      `${signalId} should not be actionable`
    );
  }
});

test('RISK FORM - an omitted timeframe fails closed for context matching', () => {
  assert.equal(isSignalForTimeframe(longSignal, '1m'), true);
  assert.equal(isSignalForContext(longSignal, 'EURUSD', '1m'), true);
  assert.equal(isSignalForTimeframe(longSignal, '5m'), false);
  assert.equal(isSignalForContext(longSignal, 'EURUSD', '5m'), false);

  assert.equal(isSignalForTimeframe(longSignal, undefined), false);
  assert.equal(isSignalForTimeframe(longSignal, null), false);
  assert.equal(isSignalForTimeframe(longSignal, ''), false);
  assert.equal(isSignalForContext(longSignal, 'EURUSD'), false);
  assert.equal(isSignalForContext(longSignal, 'EURUSD', undefined), false);
  assert.equal(isSignalForContext(longSignal, 'EURUSD', null), false);
  assert.equal(isSignalForContext(longSignal, 'EURUSD', ''), false);
  assert.equal(isActionableRiskSignalForSymbol(longSignal, 'EURUSD'), false);
  assert.equal(riskSignalKey(longSignal, 'EURUSD'), null);

  const state = createRiskFormState(longSignal, 'EURUSD');
  assert.equal(state.source, 'manual');
  assert.equal(state.entry, '');

  assert.equal(applySignalToRiskForm(state, longSignal, 'signal', 'EURUSD').entry, '');
});

test('RISK FORM - signal identity validates both symbol and timeframe', () => {
  assert.equal(isSignalForContext(longSignal, 'EURUSD', '1m'), true);
  assert.equal(isSignalForTimeframe(longSignal, '1m'), true);
  assert.equal(isSignalForTimeframe(longSignal, '5m'), false);
  assert.equal(isSignalForContext(longSignal, 'XAUUSD', '1m'), false);
  assert.equal(isSignalForContext(longSignal, 'EURUSD', '5m'), false);
  assert.equal(
    isActionableRiskSignalForSymbol(longSignal, 'EURUSD', '5m'),
    false
  );
  assert.equal(riskSignalKey(longSignal, 'EURUSD', '5m'), null);

  const state = createRiskFormState(longSignal, 'EURUSD', '5m');
  assert.equal(state.source, 'manual');
  assert.equal(state.entry, '');
});
