import { getRiskInstrumentSpec, type RiskInstrumentSpec } from './instruments';

export type RiskDirection = 'LONG' | 'SHORT';
export type RiskSizingBasis = 'units' | 'lots';
export type RiskConversionSource = 'identity' | 'derived' | 'manual';

export type RiskErrorCode =
  | 'UNSUPPORTED_INSTRUMENT'
  | 'INVALID_DIRECTION'
  | 'INVALID_INPUT'
  | 'INVALID_LEVELS'
  | 'STOP_BELOW_TICK_SIZE'
  | 'CONVERSION_REQUIRED'
  | 'INVALID_CONTRACT_SPEC'
  | 'POSITION_BELOW_MINIMUM';

export interface RiskContractOverride {
  contractSize?: number | null;
  minLot?: number | null;
  maxLot?: number | null;
  lotStep?: number | null;
}

export interface RiskCalculationInput {
  symbolId: string;
  direction: RiskDirection;
  balance: number;
  riskPercent: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  accountCurrency?: string;
  quoteToAccountRate?: number;
  contractOverride?: RiskContractOverride;
}

export interface RiskCalculationSuccess {
  ok: true;
  symbolId: string;
  displayName: string;
  direction: RiskDirection;
  accountCurrency: string;
  quoteCurrency: string;
  /** Quote-to-account rate observed at the entry price. */
  quoteToAccountRate: number;
  /** Quote-to-account rate used to value the loss at the stop-loss exit. */
  stopQuoteToAccountRate: number;
  /** Quote-to-account rate used to value the profit at the take-profit exit. */
  targetQuoteToAccountRate: number;
  conversionSource: RiskConversionSource;
  conversionIsManual: boolean;
  conversionApproximation: boolean;
  balance: number;
  riskPercent: number;
  riskAmount: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  stopDistance: number;
  targetDistance: number;
  stopPips: number;
  targetPips: number;
  stopTicks: number;
  targetTicks: number;
  stopDistanceUnits: number;
  targetDistanceUnits: number;
  distanceUnitLabel: string;
  riskReward: number;
  monetaryRiskReward: number;
  positionSizeUnits: number;
  positionSizeLots: number | null;
  sizingBasis: RiskSizingBasis;
  unitLabel: string;
  unitDescription: string;
  contractSize: number | null;
  minLot: number | null;
  maxLot: number | null;
  lotStep: number | null;
  contractSpecComplete: boolean;
  isSynthetic: boolean;
  monetaryEstimate: boolean;
  pointValueMultiplier: number | null;
  exposureAssumption: string | null;
  isExtremePosition: boolean;
  potentialLoss: number;
  potentialProfit: number;
  balanceAfterStop: number;
  balanceAfterTarget: number;
  warnings: string[];
}

export interface RiskCalculationFailure {
  ok: false;
  code: RiskErrorCode;
  message: string;
}

export type RiskCalculationResult = RiskCalculationSuccess | RiskCalculationFailure;

const SYNTHETIC_SYMBOL_IDS = new Set(['V75', 'V10', 'BOOM1000', 'CRASH1000']);

/** Absolute safety threshold for a single position, expressed in instrument units. */
const MAX_SAFE_POSITION_UNITS = 1_000_000_000;
/** Safety threshold for estimated notional exposure relative to account balance. */
const MAX_SAFE_LEVERAGE_MULTIPLE = 1000;
/** Lot sizes below this value risk being hidden by platform display precision. */
const TINY_LOT_THRESHOLD = 1e-9;

function fail(code: RiskErrorCode, message: string): RiskCalculationFailure {
  return { ok: false, code, message };
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isStepMultiple(value: number, step: number): boolean {
  if (!isPositiveFinite(step)) return false;
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) <= 1e-6;
}

function roundToStep(value: number, step: number): number {
  const precision = Math.min(12, Math.max(0, Math.ceil(-Math.log10(step)) + 2));
  return Number((Math.floor(value / step + 1e-9) * step).toFixed(precision));
}

interface ResolvedContractSpec {
  spec: RiskInstrumentSpec;
  complete: boolean;
}

function resolveContractSpec(
  spec: RiskInstrumentSpec,
  override: RiskContractOverride | undefined
): ResolvedContractSpec | RiskCalculationFailure {
  if (!override) return { spec, complete: false };

  const contractSize =
    override.contractSize === undefined ? spec.contractSize : override.contractSize;
  const minLot = override.minLot === undefined ? spec.minLot : override.minLot;
  const maxLot = override.maxLot === undefined ? spec.maxLot : override.maxLot;
  const lotStep = override.lotStep === undefined ? spec.lotStep : override.lotStep;

  if (contractSize !== null && (!isFiniteNumber(contractSize) || contractSize <= 0)) {
    return fail('INVALID_CONTRACT_SPEC', 'Contract size must be a positive number.');
  }
  if (minLot !== null && (!isFiniteNumber(minLot) || minLot <= 0)) {
    return fail('INVALID_CONTRACT_SPEC', 'Minimum lot must be a positive number.');
  }
  if (maxLot !== null && (!isFiniteNumber(maxLot) || maxLot <= 0)) {
    return fail('INVALID_CONTRACT_SPEC', 'Maximum lot must be a positive number.');
  }
  if (lotStep !== null && (!isFiniteNumber(lotStep) || lotStep <= 0)) {
    return fail('INVALID_CONTRACT_SPEC', 'Lot step must be a positive number.');
  }
  if (minLot !== null && maxLot !== null && minLot > maxLot) {
    return fail('INVALID_CONTRACT_SPEC', 'Minimum lot cannot exceed maximum lot.');
  }

  const hasLimits = minLot !== null || maxLot !== null || lotStep !== null;
  if (contractSize === null && hasLimits) {
    return fail(
      'INVALID_CONTRACT_SPEC',
      'Lot limits (minimum lot, maximum lot, or lot step) were supplied without a contract size; the limits cannot be applied.'
    );
  }

  if (contractSize !== null && minLot !== null && maxLot !== null && lotStep !== null) {
    if (lotStep > maxLot + 1e-12) {
      return fail(
        'INVALID_CONTRACT_SPEC',
        'Lot step cannot exceed the maximum lot; the specification cannot produce a valid lot size.'
      );
    }
    if (!isStepMultiple(minLot, lotStep)) {
      return fail(
        'INVALID_CONTRACT_SPEC',
        'Minimum lot must align with the lot step; the specification cannot produce a valid lot size.'
      );
    }
    if (!isStepMultiple(maxLot, lotStep)) {
      return fail(
        'INVALID_CONTRACT_SPEC',
        'Maximum lot must be an exact multiple of the lot step; the specification cannot produce a valid lot size.'
      );
    }
  }

  return {
    spec: {
      ...spec,
      contractSize,
      minLot,
      maxLot,
      lotStep,
    },
    complete:
      contractSize !== null && minLot !== null && maxLot !== null && lotStep !== null,
  };
}

interface ResolvedConversion {
  entryRate: number;
  source: RiskConversionSource;
  isManual: boolean;
  warnings: string[];
}

function resolveConversion(
  spec: RiskInstrumentSpec,
  input: RiskCalculationInput,
  accountCurrency: string
): ResolvedConversion | RiskCalculationFailure {
  const supplied = input.quoteToAccountRate;
  const warnings: string[] = [];

  if (spec.quoteCurrency === accountCurrency) {
    if (supplied !== undefined) {
      if (!isPositiveFinite(supplied)) {
        return fail('INVALID_INPUT', 'Conversion rate must be a positive number.');
      }
      if (Math.abs(supplied - 1) > 1e-9) {
        warnings.push(
          `Quote and account currency are both ${accountCurrency}; the supplied conversion rate of ${supplied} was ignored and an identity rate of 1 was applied.`
        );
      }
    }
    return { entryRate: 1, source: 'identity', isManual: false, warnings };
  }

  if (supplied !== undefined) {
    if (!isPositiveFinite(supplied)) {
      return fail('INVALID_INPUT', 'Conversion rate must be a positive number.');
    }

    if (spec.id === 'USDJPY' && spec.quoteCurrency === 'JPY' && accountCurrency === 'USD') {
      const expected = 1 / input.entry;
      if (supplied / expected > 10) {
        return fail(
          'INVALID_INPUT',
          `The supplied ${spec.quoteCurrency} to ${accountCurrency} conversion rate (${supplied}) appears inverted; the expected rate is near ${expected}.`
        );
      }
    }

    warnings.push(
      'The conversion rate was supplied manually as a user-provided rate and cannot be verified against a live source.'
    );
    warnings.push(
      'No source or timestamp is available for this manually supplied rate, so its freshness cannot be verified.'
    );
    return { entryRate: supplied, source: 'manual', isManual: true, warnings };
  }

  if (spec.id === 'USDJPY' && spec.quoteCurrency === 'JPY' && accountCurrency === 'USD') {
    return { entryRate: 1 / input.entry, source: 'derived', isManual: false, warnings };
  }

  return fail(
    'CONVERSION_REQUIRED',
    `A ${spec.quoteCurrency} to ${accountCurrency} conversion rate is required for this instrument.`
  );
}

export function calculateRisk(input: RiskCalculationInput): RiskCalculationResult {
  const spec = getRiskInstrumentSpec(input.symbolId);
  if (!spec) {
    return fail(
      'UNSUPPORTED_INSTRUMENT',
      `No verified risk specification is available for "${input.symbolId}".`
    );
  }

  if (input.direction !== 'LONG' && input.direction !== 'SHORT') {
    return fail('INVALID_DIRECTION', 'Direction must be LONG or SHORT.');
  }

  if (!isFiniteNumber(input.balance) || input.balance <= 0) {
    return fail('INVALID_INPUT', 'Account balance must be a positive number.');
  }
  if (!isFiniteNumber(input.riskPercent) || input.riskPercent <= 0) {
    return fail('INVALID_INPUT', 'Risk per trade must be a positive percentage.');
  }
  if (input.riskPercent > 100) {
    return fail('INVALID_INPUT', 'Risk per trade cannot exceed 100%.');
  }
  if (!isFiniteNumber(input.entry) || input.entry <= 0) {
    return fail('INVALID_INPUT', 'Entry must be a positive price.');
  }
  if (!isFiniteNumber(input.stopLoss) || input.stopLoss <= 0) {
    return fail('INVALID_INPUT', 'Stop loss must be a positive price.');
  }
  if (!isFiniteNumber(input.takeProfit) || input.takeProfit <= 0) {
    return fail('INVALID_INPUT', 'Take profit must be a positive price.');
  }

  if (input.direction === 'LONG') {
    if (!(input.stopLoss < input.entry)) {
      return fail('INVALID_LEVELS', 'For a LONG trade, stop loss must be below entry.');
    }
    if (!(input.takeProfit > input.entry)) {
      return fail('INVALID_LEVELS', 'For a LONG trade, take profit must be above entry.');
    }
  } else {
    if (!(input.stopLoss > input.entry)) {
      return fail('INVALID_LEVELS', 'For a SHORT trade, stop loss must be above entry.');
    }
    if (!(input.takeProfit < input.entry)) {
      return fail('INVALID_LEVELS', 'For a SHORT trade, take profit must be below entry.');
    }
  }

  const stopDistance = Math.abs(input.entry - input.stopLoss);
  const targetDistance = Math.abs(input.takeProfit - input.entry);
  if (!(stopDistance > 0) || !(targetDistance > 0)) {
    return fail('INVALID_LEVELS', 'Stop loss and take profit must differ from entry.');
  }

  const resolved = resolveContractSpec(spec, input.contractOverride);
  if ('ok' in resolved) return resolved;
  const resolvedSpec = resolved.spec;

  if (stopDistance + resolvedSpec.tickSize * 1e-9 < resolvedSpec.tickSize) {
    return fail(
      'STOP_BELOW_TICK_SIZE',
      `The stop-loss distance (${stopDistance}) is below the minimum price increment (${resolvedSpec.tickSize}) for ${resolvedSpec.id}.`
    );
  }

  const accountCurrency = (input.accountCurrency ?? 'USD').toUpperCase();
  const conversion = resolveConversion(resolvedSpec, input, accountCurrency);
  if ('ok' in conversion) return conversion;

  const warnings: string[] = [...conversion.warnings];
  const entryRate = conversion.entryRate;

  let stopRate = entryRate;
  let targetRate = entryRate;
  let conversionApproximation = false;

  if (resolvedSpec.quoteCurrency !== accountCurrency) {
    if (conversion.source === 'derived') {
      stopRate = 1 / input.stopLoss;
      targetRate = 1 / input.takeProfit;
      conversionApproximation = true;
      warnings.push(
        'USD/JPY losses are converted at the stop-loss exit price and profits at the take-profit exit price; actual broker settlement rates may differ.'
      );
    } else if (conversion.source === 'manual') {
      stopRate = entryRate;
      targetRate = entryRate;
      conversionApproximation = true;
      warnings.push(
        'The manually supplied conversion rate is applied as a constant to both entry and exit; actual settlement rates may differ.'
      );
    }
  }

  const riskAmount = input.balance * (input.riskPercent / 100);
  if (!(riskAmount > 0)) {
    return fail('INVALID_INPUT', 'The calculated risk amount must be positive.');
  }

  const rawPositionSizeUnits = riskAmount / (stopDistance * stopRate);
  if (!isFiniteNumber(rawPositionSizeUnits) || rawPositionSizeUnits <= 0) {
    return fail('INVALID_INPUT', 'The calculated position size is not valid.');
  }

  let positionSizeUnits = rawPositionSizeUnits;
  let positionSizeLots: number | null = null;
  let sizingBasis: RiskSizingBasis = 'units';

  if (resolved.complete) {
    const contractSize = resolvedSpec.contractSize as number;
    const lotStep = resolvedSpec.lotStep as number;
    const minLot = resolvedSpec.minLot as number;
    const maxLot = resolvedSpec.maxLot as number;

    const rawLots = rawPositionSizeUnits / contractSize;
    if (!isFiniteNumber(rawLots) || rawLots <= 0) {
      return fail('INVALID_INPUT', 'The calculated lot size is not valid.');
    }

    let lots = rawLots;
    if (lots > maxLot) {
      lots = maxLot;
      warnings.push(
        'The unconstrained position size exceeded the configured maximum lot; the position was capped and the monetary risk was recalculated from the capped size.'
      );
    }
    lots = roundToStep(Math.min(lots, maxLot), lotStep);
    if (lots > maxLot + 1e-9) {
      lots = roundToStep(maxLot, lotStep);
    }

    if (lots < minLot - 1e-9) {
      return fail(
        'POSITION_BELOW_MINIMUM',
        `The calculated position (${lots}) is below the configured minimum lot of ${minLot}.`
      );
    }
    if (!(lots > 0)) {
      return fail('POSITION_BELOW_MINIMUM', 'The calculated position rounds to zero lots.');
    }
    if (lots > maxLot + 1e-9) {
      return fail(
        'INVALID_CONTRACT_SPEC',
        'The rounded lot size exceeds the configured maximum lot; the specification is inconsistent.'
      );
    }
    if (!isStepMultiple(lots, lotStep)) {
      return fail(
        'INVALID_CONTRACT_SPEC',
        'The rounded lot size is not aligned to the lot step; the specification is inconsistent.'
      );
    }

    positionSizeLots = lots;
    positionSizeUnits = lots * contractSize;
    sizingBasis = 'lots';
    warnings.push(
      'Lot size was rounded down to the configured step; actual risk and reward are recalculated from the final valid lot size.'
    );
    if (lots < TINY_LOT_THRESHOLD) {
      warnings.push(
        'The recommended lot size is below 0.000000001; your platform may display it as zero. Verify the display precision with your broker.'
      );
    }
  } else if (resolvedSpec.contractSize !== null) {
    const missing: string[] = [];
    if (resolvedSpec.lotStep === null) missing.push('lot step');
    if (resolvedSpec.minLot === null) missing.push('minimum lot');
    if (resolvedSpec.maxLot === null) missing.push('maximum lot');
    warnings.push(
      `Contract size is configured but ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } missing. A lot recommendation requires all four broker specifications, so the position is shown in ${resolvedSpec.unitLabel} instead and the supplied lot limits were not applied.`
    );
  } else {
    warnings.push(
      'Broker contract size and lot limits are not configured; position size is shown in instrument units.'
    );
  }

  const potentialLoss = stopDistance * positionSizeUnits * stopRate;
  const potentialProfit = targetDistance * positionSizeUnits * targetRate;
  if (
    !isFiniteNumber(potentialLoss) ||
    !isFiniteNumber(potentialProfit) ||
    !(potentialLoss > 0) ||
    !(potentialProfit > 0)
  ) {
    return fail('INVALID_INPUT', 'The calculated monetary loss or profit is not valid.');
  }

  const notionalAccount = positionSizeUnits * input.entry * entryRate;
  const leverage = notionalAccount / input.balance;
  const isExtremePosition =
    positionSizeUnits > MAX_SAFE_POSITION_UNITS || leverage > MAX_SAFE_LEVERAGE_MULTIPLE;

  if (positionSizeUnits > MAX_SAFE_POSITION_UNITS) {
    warnings.push(
      `Position size (${positionSizeUnits.toFixed(2)} ${resolvedSpec.unitLabel}) exceeds the ${MAX_SAFE_POSITION_UNITS.toLocaleString(
        'en-US'
      )} unit safety threshold; verify the levels and broker specifications before trading.`
    );
  }
  if (leverage > MAX_SAFE_LEVERAGE_MULTIPLE) {
    warnings.push(
      `Estimated notional exposure is ${leverage.toFixed(1)}× the account balance, above the ${MAX_SAFE_LEVERAGE_MULTIPLE}× safety threshold; verify the inputs.`
    );
  }

  const riskReward = targetDistance / stopDistance;
  const monetaryRiskReward = potentialProfit / potentialLoss;
  const isSynthetic = SYNTHETIC_SYMBOL_IDS.has(resolvedSpec.id);
  const distanceUnitLabel = isSynthetic ? 'points' : 'pips';
  const stopDistanceUnits = isSynthetic
    ? stopDistance
    : stopDistance / resolvedSpec.pipValue;
  const targetDistanceUnits = isSynthetic
    ? targetDistance
    : targetDistance / resolvedSpec.pipValue;

  return {
    ok: true,
    symbolId: resolvedSpec.id,
    displayName: resolvedSpec.displayName,
    direction: input.direction,
    accountCurrency,
    quoteCurrency: resolvedSpec.quoteCurrency,
    quoteToAccountRate: entryRate,
    stopQuoteToAccountRate: stopRate,
    targetQuoteToAccountRate: targetRate,
    conversionSource: conversion.source,
    conversionIsManual: conversion.isManual,
    conversionApproximation,
    balance: input.balance,
    riskPercent: input.riskPercent,
    riskAmount,
    entry: input.entry,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    stopDistance,
    targetDistance,
    stopPips: stopDistance / resolvedSpec.pipValue,
    targetPips: targetDistance / resolvedSpec.pipValue,
    stopTicks: stopDistance / resolvedSpec.tickSize,
    targetTicks: targetDistance / resolvedSpec.tickSize,
    stopDistanceUnits,
    targetDistanceUnits,
    distanceUnitLabel,
    riskReward,
    monetaryRiskReward,
    positionSizeUnits,
    positionSizeLots,
    sizingBasis,
    unitLabel: resolvedSpec.unitLabel,
    unitDescription: resolvedSpec.unitDescription,
    contractSize: resolvedSpec.contractSize,
    minLot: resolvedSpec.minLot,
    maxLot: resolvedSpec.maxLot,
    lotStep: resolvedSpec.lotStep,
    contractSpecComplete: resolved.complete,
    isSynthetic,
    monetaryEstimate: isSynthetic,
    pointValueMultiplier: isSynthetic ? 1 : null,
    exposureAssumption: isSynthetic
      ? '1 index unit = 1 index point × 1.00 assumed point-value multiplier (linear exposure).'
      : null,
    isExtremePosition,
    potentialLoss,
    potentialProfit,
    balanceAfterStop: input.balance - potentialLoss,
    balanceAfterTarget: input.balance + potentialProfit,
    warnings,
  };
}
