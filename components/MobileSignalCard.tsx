'use client';

import React from 'react';
import type { SignalOutput, SignalDirection } from '@/lib/signals/signal-engine';
import type { StructuralBias } from '@/lib/analysis/market-structure';
import type { PremiumDiscountZone } from '@/lib/analysis/smc';
import type { Timeframe } from '@/lib/deriv/candles';
import type { FeedState } from '@/lib/deriv/feed';
import { feedStateLabel } from '@/lib/deriv/feed';
import { getSymbolConfig } from '@/lib/deriv/symbols';
import { buildSignalView, buildHistoricalSignalView } from '@/lib/ui/signal-view';

interface MobileSignalCardProps {
  signal?: SignalOutput | null;
  lastGeneratedSignal?: SignalOutput | null;
  symbolId?: string;
  displayName?: string;
  timeframe?: Timeframe | string;
  marketBias?: StructuralBias | null;
  region?: PremiumDiscountZone | null;
  direction?: SignalDirection | null;
  evaluatedAt?: Date | null;
  hasClosedCandles?: boolean;
  feedState?: FeedState;
  lastClosedCandleEpoch?: number | null;
}

export function MobileSignalCard({
  signal,
  lastGeneratedSignal,
  symbolId = '-',
  displayName,
  timeframe = '-',
  marketBias,
  region,
  direction,
  evaluatedAt,
  hasClosedCandles = false,
  feedState = 'IDLE',
  lastClosedCandleEpoch = null,
}: MobileSignalCardProps) {
  const config = getSymbolConfig(symbolId);
  const decimals = config?.pipSize ?? 5;

  const view = buildSignalView({
    signal,
    symbolId,
    displayName: displayName ?? symbolId,
    timeframe,
    marketBias,
    region,
    direction,
    evaluatedAt,
    hasClosedCandles,
    decimals,
    feedLabel: feedStateLabel(feedState),
    lastClosedCandleEpoch,
  });

  const historical = buildHistoricalSignalView({
    signal: lastGeneratedSignal,
    symbolId,
    displayName: displayName ?? symbolId,
    timeframe,
    decimals,
  });

  const decisionClass =
    view.decision === 'LONG'
      ? 'is-long'
      : view.decision === 'SHORT'
        ? 'is-short'
        : 'is-no-trade';

  const historicalClass =
    historical.direction === 'LONG'
      ? 'is-long'
      : historical.direction === 'SHORT'
        ? 'is-short'
        : 'is-neutral';

  return (
    <section className="mobile-signal-card" aria-label={`Trade signal for ${view.symbolLine}`}>
      <div className="mobile-signal-top">
        <div>
          <div className="mobile-signal-eyebrow">
            {view.symbolLine} · {String(timeframe).toUpperCase()}
          </div>
          <div className={`mobile-signal-decision ${decisionClass}`}>{view.decision}</div>
        </div>
        <div className="mobile-signal-confidence">
          <span>Confidence</span>
          <strong>{view.confidence}</strong>
        </div>
      </div>

      <div className="mobile-signal-setup">
        <span>Setup</span>
        <strong>{view.setup}</strong>
      </div>

      <div className="mobile-signal-chips">
        <span className="mobile-signal-chip">Bias: {view.marketBias}</span>
        <span className="mobile-signal-chip">Zone: {view.region}</span>
        <span className="mobile-signal-chip">Feed: {view.feedLabel}</span>
      </div>

      <div className="mobile-signal-levels">
        <div className="mobile-signal-level">
          <span>Entry</span>
          <strong>{view.entry}</strong>
        </div>
        <div className="mobile-signal-level">
          <span>Stop Loss</span>
          <strong>{view.stopLoss}</strong>
        </div>
        <div className="mobile-signal-level">
          <span>Take Profit</span>
          <strong>{view.takeProfit}</strong>
        </div>
        <div className="mobile-signal-level">
          <span>Risk / Reward</span>
          <strong>{view.riskReward}</strong>
        </div>
      </div>

      <details className="mobile-signal-details">
        <summary>Signal details</summary>
        <div className="mobile-signal-detail-list">
          <div className="mobile-signal-detail-row">
            <span>Status</span>
            <span>{view.status}</span>
          </div>
          <div className="mobile-signal-detail-row">
            <span>Intended Direction</span>
            <span>{view.direction}</span>
          </div>
          <div className="mobile-signal-detail-row">
            <span>Signal Time ({view.timezoneLabel})</span>
            <span>{view.signalTime}</span>
          </div>
          <div className="mobile-signal-detail-row">
            <span>Last Data Candle</span>
            <span>{view.lastCandleTime}</span>
          </div>
          <div className="mobile-signal-detail-row">
            <span>Evaluated At</span>
            <span>{view.evaluatedAt}</span>
          </div>

          {view.rejections.length > 0 && (
            <div className="mobile-signal-rejections">
              <div className="mobile-signal-subheading">Rejection reasons</div>
              {view.rejections.map((rejection) => (
                <div key={rejection.code} className="mobile-signal-rejection">
                  <span>{rejection.code}</span>
                  <span>{rejection.explanation}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mobile-signal-reason">
            <div className="mobile-signal-subheading">Reason</div>
            <p>{view.reason}</p>
          </div>

          <div className="mobile-signal-historical">
            <div className="mobile-signal-subheading">{historical.label}</div>
            {historical.present ? (
              <>
                <div className="mobile-signal-detail-row">
                  <span>Direction</span>
                  <span className={historicalClass}>{historical.direction}</span>
                </div>
                <div className="mobile-signal-detail-row">
                  <span>Pair</span>
                  <span>
                    {historical.symbolLine} · {String(historical.timeframe).toUpperCase()}
                  </span>
                </div>
                <div className="mobile-signal-detail-row">
                  <span>Setup</span>
                  <span>{historical.setup}</span>
                </div>
                <div className="mobile-signal-detail-row">
                  <span>Confidence</span>
                  <span>{historical.confidence}</span>
                </div>
                <div className="mobile-signal-detail-row">
                  <span>Entry</span>
                  <span>{historical.entry}</span>
                </div>
                <div className="mobile-signal-detail-row">
                  <span>Stop Loss</span>
                  <span>{historical.stopLoss}</span>
                </div>
                <div className="mobile-signal-detail-row">
                  <span>Take Profit</span>
                  <span>{historical.takeProfit}</span>
                </div>
                <div className="mobile-signal-detail-row">
                  <span>Risk / Reward</span>
                  <span>{historical.riskReward}</span>
                </div>
                <div className="mobile-signal-detail-row">
                  <span>Signal Time ({historical.timezoneLabel})</span>
                  <span>{historical.signalTime}</span>
                </div>
                <p className="mobile-signal-validity">{historical.validityNote}</p>
              </>
            ) : (
              <p className="mobile-signal-validity">{historical.emptyNote}</p>
            )}
          </div>
        </div>
      </details>
    </section>
  );
}
