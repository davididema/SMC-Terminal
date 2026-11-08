'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SignalOutput } from '@/lib/signals/signal-engine';
import type { Timeframe } from '@/lib/deriv/candles';
import { calculateRisk, type RiskCalculationResult } from '@/lib/risk/engine';
import { getRiskInstrumentSpec } from '@/lib/risk/instruments';
import {
  applySignalToRiskForm,
  createRiskFormState,
  isActionableRiskSignalForSymbol,
  resetRiskFormForSymbol,
  riskFormToCalculationInput,
  riskSignalKey,
  type RiskFormSource,
  type RiskFormState,
} from '@/lib/risk/form-state';

interface RiskPanelProps {
  signal?: SignalOutput | null;
  lastGeneratedSignal?: SignalOutput | null;
  symbolId?: string;
  displayName?: string;
  timeframe?: Timeframe | string;
  currentPrice?: number | null;
}

const moneyFormatters = new Map<string, Intl.NumberFormat>();
const MAX_ADAPTIVE_FRACTION_DIGITS = 12;

function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * Ordinary values keep two decimals. Values that would round to zero gain just enough
 * decimals to remain visible; values below the useful decimal range use scientific
 * notation. Returns null when scientific notation is required.
 */
function adaptiveFractionDigits(
  value: number,
  ordinaryDigits = 2
): number | null {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return ordinaryDigits;
  if (magnitude >= 0.5 * 10 ** -ordinaryDigits) return ordinaryDigits;
  if (magnitude < 1e-6) return null;
  return Math.min(
    MAX_ADAPTIVE_FRACTION_DIGITS,
    Math.max(ordinaryDigits + 2, Math.ceil(-Math.log10(magnitude)) + 2)
  );
}

export function formatAdaptiveNumber(
  value: number,
  ordinaryDigits = 2
): string {
  if (!Number.isFinite(value)) return '—';
  const digits = adaptiveFractionDigits(value, ordinaryDigits);
  return digits === null ? value.toExponential(4) : formatNumber(value, digits);
}

function getMoneyFormatter(
  currency: string,
  digits: number
): Intl.NumberFormat | null {
  const key = `${currency}:${digits}`;
  let formatter = moneyFormatters.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    } catch {
      return null;
    }
    moneyFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatMoney(value: number, currency: string): string {
  if (!Number.isFinite(value)) return '—';
  const normalized = value === 0 ? 0 : value;
  const digits = adaptiveFractionDigits(normalized, 2);
  if (digits === null) {
    const sign = normalized < 0 ? '-' : '';
    const magnitude = Math.abs(normalized).toExponential(4);
    const formatter = getMoneyFormatter(currency, 2);
    const symbol =
      formatter?.formatToParts(0).find((part) => part.type === 'currency')?.value ??
      null;
    return symbol === null
      ? `${sign}${magnitude} ${currency}`
      : `${sign}${symbol}${magnitude}`;
  }
  const formatter = getMoneyFormatter(currency, digits);
  return formatter === null
    ? `${formatNumber(normalized, digits)} ${currency}`
    : formatter.format(normalized);
}

export function formatQuantity(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude === 0) return '0';
  if (magnitude >= 1) return formatNumber(value, 2);
  if (magnitude >= 0.01) return formatNumber(value, 4);
  if (magnitude < 1e-6) return value.toExponential(4);
  const digits = Math.min(12, Math.max(6, Math.ceil(-Math.log10(magnitude)) + 1));
  return formatNumber(value, digits);
}

/**
 * Format a recommended lot size with enough precision for its lot step so that a
 * genuinely nonzero size is never presented as `0.0000`. If the value is smaller
 * than the maximum display precision, an explicit below-threshold marker is shown.
 */
export function formatLotSize(value: number, lotStep: number | null): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const stepDigits =
    lotStep !== null && lotStep > 0
      ? Math.min(12, Math.max(2, Math.ceil(-Math.log10(lotStep))))
      : 4;
  let digits = stepDigits;
  let formatted = value.toFixed(digits);
  while (Number(formatted) === 0 && digits < 12) {
    digits += 1;
    formatted = value.toFixed(digits);
  }
  if (Number(formatted) === 0 && value !== 0) {
    return `<${(10 ** -digits).toFixed(digits)}`;
  }
  return formatted;
}

function formatPrice(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(Math.max(0, precision));
}

function formatSignalTime(epoch: number | null | undefined): string {
  if (!epoch || !Number.isFinite(epoch) || epoch <= 0) return '—';
  return `${new Date(epoch * 1000).toISOString().slice(11, 19)} UTC`;
}

function sourceLabel(
  source: RiskFormSource,
  hasCurrentSignal: boolean
): string {
  if (source === 'signal') {
    return hasCurrentSignal
      ? 'Auto-filled from the current signal.'
      : 'Levels retained from the last auto-fill; no current signal.';
  }
  if (source === 'historical-signal') {
    return 'Auto-filled from the last generated signal (historical, not current).';
  }
  return 'Manual entry.';
}

function formatPosition(result: RiskCalculationResult): {
  primary: string;
  secondary: string;
} {
  if (!result.ok) return { primary: '—', secondary: '—' };

  if (result.sizingBasis === 'lots' && result.positionSizeLots !== null) {
    return {
      primary: `${formatLotSize(result.positionSizeLots, result.lotStep)} lots`,
      secondary: `${formatQuantity(result.positionSizeUnits)} ${result.unitLabel} · ${formatMoney(
        result.potentialLoss,
        result.accountCurrency
      )} at stop`,
    };
  }

  return {
    primary: `${formatQuantity(result.positionSizeUnits)} ${result.unitLabel}`,
    secondary: `Linear unit sizing · ${formatMoney(
      result.potentialLoss,
      result.accountCurrency
    )} at stop`,
  };
}

export function RiskPanel({
  signal,
  lastGeneratedSignal,
  symbolId = '',
  displayName,
  timeframe = '',
  currentPrice,
}: RiskPanelProps) {
  const timeframeLabel = String(timeframe).toUpperCase();
  const timeframeId = String(timeframe);
  const [form, setForm] = useState<RiskFormState>(() =>
    createRiskFormState(signal, symbolId, timeframeId)
  );
  const lastSignalKeyRef = useRef<string | null>(
    riskSignalKey(signal, symbolId, timeframeId)
  );
  const lastSymbolRef = useRef(symbolId);
  const lastTimeframeRef = useRef(timeframeId);

  useEffect(() => {
    const key = riskSignalKey(signal, symbolId, timeframeId);

    if (
      symbolId !== lastSymbolRef.current ||
      timeframeId !== lastTimeframeRef.current
    ) {
      lastSymbolRef.current = symbolId;
      lastTimeframeRef.current = timeframeId;
      lastSignalKeyRef.current = key;
      setForm((previous) =>
        resetRiskFormForSymbol(previous, signal, symbolId, timeframeId)
      );
      return;
    }

    if (key === null) {
      lastSignalKeyRef.current = null;
      return;
    }

    if (key !== lastSignalKeyRef.current) {
      lastSignalKeyRef.current = key;
      setForm((previous) =>
        applySignalToRiskForm(previous, signal, 'signal', symbolId, timeframeId)
      );
    }
  }, [signal, symbolId, timeframeId]);

  const parsed = useMemo(
    () => riskFormToCalculationInput(form, symbolId),
    [form, symbolId]
  );
  const result = useMemo(
    () => (parsed.input ? calculateRisk(parsed.input) : null),
    [parsed]
  );

  const spec = getRiskInstrumentSpec(symbolId);
  const hasCurrentSignal = isActionableRiskSignalForSymbol(
    signal,
    symbolId,
    timeframeId
  );
  const hasHistoricalSignal = isActionableRiskSignalForSymbol(
    lastGeneratedSignal,
    symbolId,
    timeframeId
  );
  const position = result ? formatPosition(result) : { primary: '—', secondary: '—' };
  const levelsBlank =
    form.entry.trim() === '' &&
    form.stopLoss.trim() === '' &&
    form.takeProfit.trim() === '';

  const updateField = (
    field: Exclude<keyof RiskFormState, 'source'>,
    value: string
  ) => {
    setForm((previous) => ({ ...previous, [field]: value, source: 'manual' }));
  };

  const setDirection = (direction: 'LONG' | 'SHORT') => {
    setForm((previous) => ({ ...previous, direction, source: 'manual' }));
  };

  const useSignal = (
    chosen: SignalOutput | null | undefined,
    source: RiskFormSource
  ) => {
    if (!isActionableRiskSignalForSymbol(chosen, symbolId, timeframeId)) return;
    setForm((previous) =>
      applySignalToRiskForm(previous, chosen, source, symbolId, timeframeId)
    );
  };

  const resetForm = () => {
    setForm((previous) =>
      resetRiskFormForSymbol(
        previous,
        hasCurrentSignal ? signal : null,
        symbolId,
        timeframeId
      )
    );
  };

  return (
    <div className="panel risk-panel">
      <div className="panel-header">
        <div className="panel-title">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span>RISK MANAGEMENT</span>
        </div>
        <div className="risk-header-meta">
          <span className="risk-readonly-badge">READ-ONLY</span>
          <span>
            {displayName ?? symbolId ?? '—'}
            {timeframeLabel ? ` · ${timeframeLabel}` : ''}
          </span>
        </div>
      </div>

      <div className="panel-body risk-panel-body">
        <div className="risk-source-row">
          <span
            className={`risk-source-dot ${
              hasCurrentSignal ? 'is-live' : form.source === 'manual' ? 'is-manual' : 'is-stale'
            }`}
          />
          <span className="risk-source-text">
            {sourceLabel(form.source, hasCurrentSignal)}
          </span>
          {hasCurrentSignal && signal ? (
            <span className="risk-source-time">
              {signal.decision} · {formatSignalTime(signal.timestamp)}
            </span>
          ) : null}
        </div>

        {!hasCurrentSignal && hasHistoricalSignal && lastGeneratedSignal ? (
          <div className="risk-historical-row">
            <span>
              Last generated {lastGeneratedSignal.decision} signal ·{' '}
              {formatSignalTime(lastGeneratedSignal.timestamp)}
            </span>
            <button
              type="button"
              className="risk-link-button"
              onClick={() => useSignal(lastGeneratedSignal, 'historical-signal')}
            >
              Use last signal
            </button>
          </div>
        ) : null}

        <div className="risk-form">
          <div className="risk-form-grid">
            <label className="risk-field" htmlFor="risk-balance">
              <span>Account Balance</span>
              <input
                id="risk-balance"
                className="risk-input mono"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={form.balance}
                onChange={(event) => updateField('balance', event.target.value)}
              />
            </label>

            <label className="risk-field" htmlFor="risk-percent">
              <span>Risk Per Trade</span>
              <div className="risk-input-with-suffix">
                <input
                  id="risk-percent"
                  className="risk-input mono"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.riskPercent}
                  onChange={(event) => updateField('riskPercent', event.target.value)}
                />
                <span>%</span>
              </div>
            </label>
          </div>

          <div className="risk-direction-row">
            <span className="risk-field-label">Direction</span>
            <div className="risk-direction-group" role="group" aria-label="Trade direction">
              <button
                type="button"
                className={`risk-direction-btn is-long ${
                  form.direction === 'LONG' ? 'active' : ''
                }`}
                aria-pressed={form.direction === 'LONG'}
                onClick={() => setDirection('LONG')}
              >
                LONG
              </button>
              <button
                type="button"
                className={`risk-direction-btn is-short ${
                  form.direction === 'SHORT' ? 'active' : ''
                }`}
                aria-pressed={form.direction === 'SHORT'}
                onClick={() => setDirection('SHORT')}
              >
                SHORT
              </button>
            </div>
          </div>

          <div className="risk-level-grid">
            <label className="risk-field" htmlFor="risk-entry">
              <span>Entry</span>
              <input
                id="risk-entry"
                className="risk-input mono"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={form.entry}
                onChange={(event) => updateField('entry', event.target.value)}
              />
            </label>

            <label className="risk-field" htmlFor="risk-stop">
              <span>Stop Loss</span>
              <input
                id="risk-stop"
                className="risk-input mono"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={form.stopLoss}
                onChange={(event) => updateField('stopLoss', event.target.value)}
              />
            </label>

            <label className="risk-field" htmlFor="risk-target">
              <span>Take Profit</span>
              <input
                id="risk-target"
                className="risk-input mono"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={form.takeProfit}
                onChange={(event) => updateField('takeProfit', event.target.value)}
              />
            </label>
          </div>

          <div className="risk-actions">
            {hasCurrentSignal ? (
              <button
                type="button"
                className="risk-action-btn is-primary"
                onClick={() => useSignal(signal, 'signal')}
              >
                Use current signal
              </button>
            ) : null}
            <button type="button" className="risk-action-btn" onClick={resetForm}>
              Reset
            </button>
            {currentPrice ? (
              <span className="risk-current-price">
                Live: {formatPrice(currentPrice, spec?.pricePrecision ?? 5)}
              </span>
            ) : null}
          </div>

          <details className="risk-advanced">
            <summary>Advanced assumptions</summary>
            <div className="risk-advanced-body">
              <div className="risk-form-grid">
                <label className="risk-field" htmlFor="risk-account-currency">
                  <span>Account Currency</span>
                  <input
                    id="risk-account-currency"
                    className="risk-input mono"
                    maxLength={3}
                    autoComplete="off"
                    spellCheck={false}
                    value={form.accountCurrency}
                    onChange={(event) =>
                      updateField('accountCurrency', event.target.value.toUpperCase())
                    }
                  />
                </label>

                <label className="risk-field" htmlFor="risk-conversion">
                  <span>Quote → Account Rate</span>
                  <input
                    id="risk-conversion"
                    className="risk-input mono"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Auto when possible"
                    value={form.conversionRate}
                    onChange={(event) => updateField('conversionRate', event.target.value)}
                  />
                </label>
              </div>

              <div className="risk-form-grid">
                <label className="risk-field" htmlFor="risk-contract-size">
                  <span>Contract Size (units/lot)</span>
                  <input
                    id="risk-contract-size"
                    className="risk-input mono"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Not verified"
                    value={form.contractSize}
                    onChange={(event) => updateField('contractSize', event.target.value)}
                  />
                </label>

                <label className="risk-field" htmlFor="risk-lot-step">
                  <span>Lot Step</span>
                  <input
                    id="risk-lot-step"
                    className="risk-input mono"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Optional"
                    value={form.lotStep}
                    onChange={(event) => updateField('lotStep', event.target.value)}
                  />
                </label>
              </div>

              <div className="risk-form-grid">
                <label className="risk-field" htmlFor="risk-min-lot">
                  <span>Minimum Lot</span>
                  <input
                    id="risk-min-lot"
                    className="risk-input mono"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Optional"
                    value={form.minLot}
                    onChange={(event) => updateField('minLot', event.target.value)}
                  />
                </label>

                <label className="risk-field" htmlFor="risk-max-lot">
                  <span>Maximum Lot</span>
                  <input
                    id="risk-max-lot"
                    className="risk-input mono"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Optional"
                    value={form.maxLot}
                    onChange={(event) => updateField('maxLot', event.target.value)}
                  />
                </label>
              </div>

              <p className="risk-help">
                Contract size and lot limits are not assumed. Leave them blank to size in
                instrument units. A lot recommendation requires all four broker-verified
                values: contract size, lot step, minimum lot and maximum lot. For USDJPY
                with a USD account, the JPY-to-USD entry rate is derived from the entry
                price and exits are converted at the stop-loss and take-profit prices.
              </p>
            </div>
          </details>
        </div>

        <div className="risk-results" aria-live="polite">
          {!spec ? (
            <div className="risk-error">
              <strong>UNSUPPORTED_INSTRUMENT</strong>
              <span>
                No verified risk specification is available for &quot;
                {symbolId || 'this instrument'}&quot;.
              </span>
            </div>
          ) : null}

          {spec && levelsBlank ? (
            <div className="risk-empty">
              Enter entry, stop loss, and take profit to calculate risk.
            </div>
          ) : null}

          {spec && !levelsBlank && parsed.error ? (
            <div className="risk-error">{parsed.error}</div>
          ) : null}

          {spec && !levelsBlank && !parsed.error && result && !result.ok ? (
            <div className="risk-error">
              <strong>{result.code}</strong>
              <span>{result.message}</span>
            </div>
          ) : null}

          {spec && !levelsBlank && !parsed.error && !result ? (
            <div className="risk-empty">
              Enter entry, stop loss, and take profit to calculate risk.
            </div>
          ) : null}

          {spec && !levelsBlank && !parsed.error && result?.ok ? (
            <>
              <div className="risk-primary-result">
                <div className="risk-primary-label">RECOMMENDED POSITION SIZE</div>
                <div className="risk-primary-value">{position.primary}</div>
                <div className="risk-primary-sub">{position.secondary}</div>
                {result.monetaryEstimate ? (
                  <div className="risk-primary-sub risk-synthetic-sub">
                    Estimated P/L. {result.exposureAssumption}
                  </div>
                ) : null}
              </div>

              <div className="risk-result-grid">
                <div className="risk-result-card">
                  <span>Risk Amount</span>
                  <strong>{formatMoney(result.riskAmount, result.accountCurrency)}</strong>
                </div>
                <div className="risk-result-card">
                  <span>
                    {result.monetaryEstimate
                      ? 'Estimated Potential Loss'
                      : 'Potential Loss'}
                  </span>
                  <strong className="is-loss">
                    {formatMoney(result.potentialLoss, result.accountCurrency)}
                  </strong>
                </div>
                <div className="risk-result-card">
                  <span>
                    {result.monetaryEstimate
                      ? 'Estimated Potential Profit'
                      : 'Potential Profit'}
                  </span>
                  <strong className="is-profit">
                    {formatMoney(result.potentialProfit, result.accountCurrency)}
                  </strong>
                </div>
                <div className="risk-result-card">
                  <span>Price R:R</span>
                  <strong>1:{formatNumber(result.riskReward, 2)}</strong>
                </div>
                <div className="risk-result-card">
                  <span>Monetary R:R</span>
                  <strong>1:{formatAdaptiveNumber(result.monetaryRiskReward)}</strong>
                  <small>Account-currency estimate</small>
                </div>
                <div className="risk-result-card">
                  <span>SL Distance</span>
                  <strong>
                    {formatPrice(result.stopDistance, spec?.pricePrecision ?? 5)}
                    <small>
                      {' '}
                      · {formatNumber(result.stopDistanceUnits, 1)}{' '}
                      {result.distanceUnitLabel}
                    </small>
                  </strong>
                </div>
                <div className="risk-result-card">
                  <span>TP Distance</span>
                  <strong>
                    {formatPrice(result.targetDistance, spec?.pricePrecision ?? 5)}
                    <small>
                      {' '}
                      · {formatNumber(result.targetDistanceUnits, 1)}{' '}
                      {result.distanceUnitLabel}
                    </small>
                  </strong>
                </div>
                <div className="risk-result-card">
                  <span>Balance After SL</span>
                  <strong>{formatMoney(result.balanceAfterStop, result.accountCurrency)}</strong>
                </div>
                <div className="risk-result-card">
                  <span>Balance After TP</span>
                  <strong>{formatMoney(result.balanceAfterTarget, result.accountCurrency)}</strong>
                </div>
              </div>

              {result.monetaryEstimate ? (
                <div className="risk-synthetic-note">
                  <strong>Estimated synthetic P/L — not guaranteed broker P/L.</strong>
                  <span>
                    Linear exposure assumption: {result.exposureAssumption} Assumed
                    point-value multiplier:{' '}
                    {formatNumber(result.pointValueMultiplier ?? 1, 2)}.
                  </span>
                </div>
              ) : null}

              {result.conversionApproximation ? (
                <div className="risk-detail-line risk-conversion-detail">
                  <span>Conversion approximation</span>
                  <span className="mono">
                    entry {formatNumber(result.quoteToAccountRate, 6)} · stop{' '}
                    {formatNumber(result.stopQuoteToAccountRate, 6)} · target{' '}
                    {formatNumber(result.targetQuoteToAccountRate, 6)}
                  </span>
                </div>
              ) : null}

              <div className="risk-detail-line">
                <span>Entry</span>
                <span className="mono">
                  {formatPrice(result.entry, spec?.pricePrecision ?? 5)}
                </span>
                <span>Stop</span>
                <span className="mono">
                  {formatPrice(result.stopLoss, spec?.pricePrecision ?? 5)}
                </span>
                <span>Target</span>
                <span className="mono">
                  {formatPrice(result.takeProfit, spec?.pricePrecision ?? 5)}
                </span>
              </div>

              {result.warnings.map((warning) => (
                <div className="risk-warning" key={warning}>
                  {warning}
                </div>
              ))}
            </>
          ) : null}
        </div>

        <div className="risk-disclaimer">
          Read-only estimate. No orders are placed. Verify contract specifications,
          lot limits, and currency conversion with your broker before trading.
        </div>
      </div>
    </div>
  );
}
