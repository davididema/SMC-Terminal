import {
  getPipValue,
  getSymbolConfig,
  getTickSize,
  SUPPORTED_SYMBOLS,
  type InstrumentCategory,
} from '../deriv/symbols';

export type RiskSizingBasis = 'units' | 'lots';

export interface RiskInstrumentSpec {
  id: string;
  displayName: string;
  category: InstrumentCategory;
  quoteCurrency: string;
  pricePrecision: number;
  tickSize: number;
  pipValue: number;
  unitLabel: string;
  unitDescription: string;
  contractSize: number | null;
  minLot: number | null;
  maxLot: number | null;
  lotStep: number | null;
  contractSpecSource: 'not-configured';
}

const QUOTE_CURRENCY_BY_SYMBOL: Readonly<Record<string, string>> = {
  EURUSD: 'USD',
  GBPUSD: 'USD',
  USDJPY: 'JPY',
  AUDUSD: 'USD',
  XAUUSD: 'USD',
  V75: 'USD',
  V10: 'USD',
  BOOM1000: 'USD',
  CRASH1000: 'USD',
};

function getUnit(symbolId: string, category: InstrumentCategory): {
  unitLabel: string;
  unitDescription: string;
} {
  if (category === 'Forex') {
    return {
      unitLabel: 'base units',
      unitDescription: '1 unit = 1 unit of the pair base currency',
    };
  }
  if (category === 'Metals') {
    return {
      unitLabel: 'troy oz',
      unitDescription: '1 unit = 1 troy ounce of gold',
    };
  }
  if (symbolId === 'BOOM1000' || symbolId === 'CRASH1000') {
    return {
      unitLabel: 'index units',
      unitDescription: '1 unit = linear exposure to 1 index point',
    };
  }
  return {
    unitLabel: 'index units',
    unitDescription: '1 unit = linear exposure to 1 index point',
  };
}

export function getRiskInstrumentSpec(symbolId: string): RiskInstrumentSpec | null {
  const symbol = getSymbolConfig(symbolId);
  if (!symbol) return null;

  const quoteCurrency = QUOTE_CURRENCY_BY_SYMBOL[symbolId];
  const tickSize = getTickSize(symbolId);
  const pipValue = getPipValue(symbolId);
  if (!quoteCurrency || tickSize === undefined || pipValue === undefined) return null;

  const unit = getUnit(symbolId, symbol.category);

  return {
    id: symbol.id,
    displayName: symbol.displayName,
    category: symbol.category,
    quoteCurrency,
    pricePrecision: symbol.pipSize,
    tickSize,
    pipValue,
    unitLabel: unit.unitLabel,
    unitDescription: unit.unitDescription,
    contractSize: null,
    minLot: null,
    maxLot: null,
    lotStep: null,
    contractSpecSource: 'not-configured',
  };
}

export function listRiskInstrumentSpecs(): RiskInstrumentSpec[] {
  return SUPPORTED_SYMBOLS.map((symbol) => getRiskInstrumentSpec(symbol.id)).filter(
    (spec): spec is RiskInstrumentSpec => spec !== null
  );
}
