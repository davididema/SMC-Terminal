import type { SignalOutput } from '../signals/signal-engine';
import type {
  RiskCalculationInput,
  RiskContractOverride,
  RiskDirection,
} from './engine';

export type RiskFormSource = 'signal' | 'historical-signal' | 'manual';

export type ActionableRiskSignal = SignalOutput & {
  decision: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  takeProfit: number;
};

export interface RiskFormState {
  balance: string;
  riskPercent: string;
  direction: RiskDirection;
  entry: string;
  stopLoss: string;
  takeProfit: string;
  accountCurrency: string;
  conversionRate: string;
  contractSize: string;
  minLot: string;
  maxLot: string;
  lotStep: string;
  source: RiskFormSource;
}

export type RiskFormInputResult =
  | { input: RiskCalculationInput; error?: undefined }
  | { input?: undefined; error: string };

export interface SignalIdentity {
  symbol: string;
  timeframe: string;
  triggerId: string;
  zoneId: string;
}

/**
 * Actionable structure-break identities produced by `structure-breaks.ts`:
 * `${symbol}:${timeframe}:${type}:${breakCandleEpoch}:${brokenSwingEpoch}`.
 * `INITIAL_*` breaks are excluded because the signal engine never emits them as triggers.
 */
const ACTIONABLE_TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'BULLISH_BOS',
  'BEARISH_BOS',
  'BULLISH_CHOCH',
  'BEARISH_CHOCH',
]);

/**
 * Zone identities produced by `fvg.ts`, `order-blocks.ts`, and `liquidity.ts`:
 * `${symbol}:${timeframe}:${kind}:${subtype}:${epoch}`.
 */
const ZONE_SUBTYPES_BY_KIND: Readonly<Record<string, ReadonlySet<string>>> = {
  FVG: new Set(['BULLISH', 'BEARISH']),
  OB: new Set(['BULLISH', 'BEARISH']),
  LIQ: new Set(['BUY_SIDE', 'SELL_SIDE', 'EQH', 'EQL']),
};

function isEpochSegment(value: string): boolean {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
}

function isTriggerIdentity(
  identity: string,
  symbol: string,
  timeframe: string
): boolean {
  const parts = identity.split(':');
  if (parts.length !== 5) return false;
  const [idSymbol, idTimeframe, type, breakEpoch, brokenSwingEpoch] = parts;
  return (
    idSymbol === symbol &&
    idTimeframe === timeframe &&
    ACTIONABLE_TRIGGER_TYPES.has(type) &&
    isEpochSegment(breakEpoch) &&
    isEpochSegment(brokenSwingEpoch)
  );
}

function isZoneIdentity(
  identity: string,
  symbol: string,
  timeframe: string
): boolean {
  const parts = identity.split(':');
  if (parts.length !== 5) return false;
  const [idSymbol, idTimeframe, kind, subtype, epoch] = parts;
  if (idSymbol !== symbol || idTimeframe !== timeframe) return false;
  if (!isEpochSegment(epoch)) return false;
  return ZONE_SUBTYPES_BY_KIND[kind]?.has(subtype) ?? false;
}

/**
 * Parse the engine-authoritative identity `${symbol}:${timeframe}:${triggerId}:${zoneId}`.
 * Returns null unless exactly four logical components are present, so callers can
 * refuse to auto-populate from an incomplete, overlong, or invented identity.
 *
 * The engine's trigger and zone identifiers are themselves colon-delimited and carry
 * the same `${symbol}:${timeframe}:` prefix (for example
 * `EURUSD:1m:BULLISH_CHOCH:...:EURUSD:1m:FVG:...`). Those identifiers are still the
 * third and fourth logical components, so they are reconstructed rather than mistaken
 * for extra top-level components. Nested identifiers are validated against the exact
 * producer formats, including non-empty typed components and numeric epochs. A plain
 * four-segment identity (`EURUSD:1m:trig:zone`) is also accepted. Identities with
 * fewer than four segments, empty components, or extra/malformed nested segments are
 * rejected.
 */
export function parseSignalId(
  signalId: string | null | undefined
): SignalIdentity | null {
  if (typeof signalId !== 'string') return null;
  const parts = signalId.split(':');
  if (parts.length < 4) return null;

  if (parts.length === 4) {
    const [symbol, timeframe, triggerId, zoneId] = parts;
    if (!symbol || !timeframe || !triggerId || !zoneId) return null;
    return { symbol, timeframe, triggerId, zoneId };
  }

  const [symbol, timeframe] = parts;
  if (!symbol || !timeframe) return null;

  const prefix = `${symbol}:${timeframe}:`;
  if (!signalId.startsWith(prefix)) return null;

  const rest = signalId.slice(prefix.length);
  if (!rest.startsWith(prefix)) return null;

  const zoneStart = rest.indexOf(prefix, prefix.length);
  if (zoneStart <= prefix.length) return null;

  const triggerId = rest.slice(0, zoneStart - 1);
  const zoneId = rest.slice(zoneStart);
  if (
    !isTriggerIdentity(triggerId, symbol, timeframe) ||
    !isZoneIdentity(zoneId, symbol, timeframe)
  ) {
    return null;
  }

  return { symbol, timeframe, triggerId, zoneId };
}

export function hasValidSignalId(
  signal: SignalOutput | null | undefined
): boolean {
  return parseSignalId(signal?.signalId) !== null;
}

export function isActionableRiskSignal(
  signal: SignalOutput | null | undefined
): signal is ActionableRiskSignal {
  if (!signal) return false;
  if (!hasValidSignalId(signal)) return false;
  if (signal.decision !== 'LONG' && signal.decision !== 'SHORT') return false;
  return (
    typeof signal.entry === 'number' &&
    Number.isFinite(signal.entry) &&
    typeof signal.stopLoss === 'number' &&
    Number.isFinite(signal.stopLoss) &&
    typeof signal.takeProfit === 'number' &&
    Number.isFinite(signal.takeProfit)
  );
}

export function isSignalForSymbol(
  signal: SignalOutput | null | undefined,
  symbolId: string
): boolean {
  const identity = parseSignalId(signal?.signalId);
  if (!identity) return false;
  return identity.symbol === symbolId;
}

export function isSignalForTimeframe(
  signal: SignalOutput | null | undefined,
  timeframe: string | null | undefined
): boolean {
  const identity = parseSignalId(signal?.signalId);
  if (!identity) return false;
  if (!timeframe) return false;
  return identity.timeframe === timeframe;
}

export function isSignalForContext(
  signal: SignalOutput | null | undefined,
  symbolId: string,
  timeframe?: string | null
): boolean {
  const identity = parseSignalId(signal?.signalId);
  if (!identity) return false;
  if (identity.symbol !== symbolId) return false;
  if (!timeframe) return false;
  return identity.timeframe === timeframe;
}

export function isActionableRiskSignalForSymbol(
  signal: SignalOutput | null | undefined,
  symbolId: string,
  timeframe?: string | null
): signal is ActionableRiskSignal {
  return (
    isActionableRiskSignal(signal) &&
    isSignalForContext(signal, symbolId, timeframe)
  );
}

export function riskSignalKey(
  signal: SignalOutput | null | undefined,
  symbolId: string,
  timeframe?: string
): string | null {
  if (!isActionableRiskSignalForSymbol(signal, symbolId, timeframe)) return null;
  return [
    symbolId,
    timeframe ?? '',
    signal.signalId ?? '',
    signal.timestamp,
    signal.decision,
    signal.entry,
    signal.stopLoss,
    signal.takeProfit,
  ].join('|');
}

function levelsFromSignal(
  signal: ActionableRiskSignal
): Pick<RiskFormState, 'direction' | 'entry' | 'stopLoss' | 'takeProfit'> {
  return {
    direction: signal.decision,
    entry: String(signal.entry),
    stopLoss: String(signal.stopLoss),
    takeProfit: String(signal.takeProfit),
  };
}

export function createRiskFormState(
  signal: SignalOutput | null | undefined,
  symbolId?: string,
  timeframe?: string | null
): RiskFormState {
  const actionable =
    isActionableRiskSignal(signal) &&
    (!symbolId || isSignalForContext(signal, symbolId, timeframe));
  return {
    balance: '10000',
    riskPercent: '1',
    direction: actionable ? signal.decision : 'LONG',
    entry: actionable ? String(signal.entry) : '',
    stopLoss: actionable ? String(signal.stopLoss) : '',
    takeProfit: actionable ? String(signal.takeProfit) : '',
    accountCurrency: 'USD',
    conversionRate: '',
    contractSize: '',
    minLot: '',
    maxLot: '',
    lotStep: '',
    source: actionable ? 'signal' : 'manual',
  };
}

export function applySignalToRiskForm(
  state: RiskFormState,
  signal: SignalOutput | null | undefined,
  source: RiskFormSource = 'signal',
  symbolId?: string,
  timeframe?: string | null
): RiskFormState {
  if (!isActionableRiskSignal(signal)) return state;
  if (symbolId && !isSignalForContext(signal, symbolId, timeframe)) return state;
  return {
    ...state,
    ...levelsFromSignal(signal),
    source,
  };
}

export function resetRiskFormForSymbol(
  previous: RiskFormState,
  signal: SignalOutput | null | undefined,
  symbolId: string,
  timeframe?: string | null
): RiskFormState {
  return {
    ...createRiskFormState(signal, symbolId, timeframe),
    balance: previous.balance,
    riskPercent: previous.riskPercent,
    accountCurrency: previous.accountCurrency,
  };
}

function parseNumber(value: string): number | null {
  const normalized = value.replace(/,/g, '').trim();
  if (normalized === '') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredNumber(value: string, label: string): number | string {
  const parsed = parseNumber(value);
  if (parsed === null) return `${label} must be a valid number.`;
  return parsed;
}

function optionalPositive(value: string, label: string): number | undefined | string {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = parseNumber(value);
  if (parsed === null || parsed <= 0) return `${label} must be a positive number.`;
  return parsed;
}

export function riskFormToCalculationInput(
  state: RiskFormState,
  symbolId: string
): RiskFormInputResult {
  const balance = requiredNumber(state.balance, 'Account balance');
  if (typeof balance === 'string') return { error: balance };

  const riskPercent = requiredNumber(state.riskPercent, 'Risk per trade');
  if (typeof riskPercent === 'string') return { error: riskPercent };

  const entry = requiredNumber(state.entry, 'Entry');
  if (typeof entry === 'string') return { error: entry };

  const stopLoss = requiredNumber(state.stopLoss, 'Stop loss');
  if (typeof stopLoss === 'string') return { error: stopLoss };

  const takeProfit = requiredNumber(state.takeProfit, 'Take profit');
  if (typeof takeProfit === 'string') return { error: takeProfit };

  const currency = state.accountCurrency.trim().toUpperCase() || 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { error: 'Account currency must be a three-letter ISO code.' };
  }

  const conversionRate = optionalPositive(state.conversionRate, 'Conversion rate');
  if (typeof conversionRate === 'string') return { error: conversionRate };

  const contractSize = optionalPositive(state.contractSize, 'Contract size');
  if (typeof contractSize === 'string') return { error: contractSize };

  const minLot = optionalPositive(state.minLot, 'Minimum lot');
  if (typeof minLot === 'string') return { error: minLot };

  const maxLot = optionalPositive(state.maxLot, 'Maximum lot');
  if (typeof maxLot === 'string') return { error: maxLot };

  const lotStep = optionalPositive(state.lotStep, 'Lot step');
  if (typeof lotStep === 'string') return { error: lotStep };

  const contractOverride: RiskContractOverride = {};
  if (contractSize !== undefined) contractOverride.contractSize = contractSize;
  if (minLot !== undefined) contractOverride.minLot = minLot;
  if (maxLot !== undefined) contractOverride.maxLot = maxLot;
  if (lotStep !== undefined) contractOverride.lotStep = lotStep;

  return {
    input: {
      symbolId,
      direction: state.direction,
      balance,
      riskPercent,
      entry,
      stopLoss,
      takeProfit,
      accountCurrency: currency,
      quoteToAccountRate: conversionRate,
      contractOverride:
        Object.keys(contractOverride).length > 0 ? contractOverride : undefined,
    },
  };
}
