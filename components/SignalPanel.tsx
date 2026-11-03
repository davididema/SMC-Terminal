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

interface SignalPanelProps {
  signal?: SignalOutput | null;
  /**
   * Most recently generated genuine LONG/SHORT for the currently selected pair,
   * retained across NO_TRADE evaluations. Distinct from `signal` (the latest
   * evaluation). Historical only — never a claim of current validity.
   */
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
  /** Epoch of the most recent completed candle, when known. */
  lastClosedCandleEpoch?: number | null;
}

export function SignalPanel({
  signal,
  lastGeneratedSignal,
  symbolId = '—',
  displayName,
  timeframe = '—',
  marketBias,
  region,
  direction,
  evaluatedAt,
  hasClosedCandles = false,
  feedState = 'IDLE',
  lastClosedCandleEpoch = null,
}: SignalPanelProps) {
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

  const historicalColor =
    historical.direction === 'LONG'
      ? '#10b981'
      : historical.direction === 'SHORT'
      ? '#f43f5e'
      : '#94a3b8';

  const decisionColor =
    view.decision === 'LONG'
      ? '#10b981'
      : view.decision === 'SHORT'
      ? '#f43f5e'
      : '#94a3b8';

  return (
    <div className="panel">
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
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
          <span>TRADE SIGNAL</span>
        </div>
        <div style={{ fontSize: '10px', color: '#64748b', letterSpacing: '0.4px' }}>
          {view.symbolLine} · {String(timeframe).toUpperCase()}
        </div>
      </div>

      <div className="panel-body">
        {/* Signal Decision Badge */}
        <div className={`signal-box ${view.decision.replace(' ', '_')}`}>
          <div
            style={{
              fontSize: '10px',
              textTransform: 'uppercase',
              color: '#64748b',
              letterSpacing: '0.5px',
            }}
          >
            DECISION
          </div>
          <div className="signal-decision-text" style={{ color: decisionColor }}>
            {view.decision}
          </div>
        </div>

        {/* Evaluation Context */}
        <div className="signal-details-list mono">
          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Status:</span>
            <span style={{ color: view.status === 'EVALUATED' ? '#10b981' : '#f59e0b' }}>
              {view.status}
            </span>
          </div>

          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Market Bias:</span>
            <span>{view.marketBias}</span>
          </div>

          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Zone Region:</span>
            <span>{view.region}</span>
          </div>

          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Intended Direction:</span>
            <span>{view.direction}</span>
          </div>

          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Feed:</span>
            <span>{view.feedLabel}</span>
          </div>
        </div>

        {/* Signal Details */}
        <div className="signal-details-list mono">
          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Confidence:</span>
            <span>{view.confidence}</span>
          </div>

          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Setup:</span>
            <span>{view.setup}</span>
          </div>

          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Entry:</span>
            <span>{view.entry}</span>
          </div>

          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Stop Loss:</span>
            <span>{view.stopLoss}</span>
          </div>

          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Take Profit:</span>
            <span>{view.takeProfit}</span>
          </div>

          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Risk/Reward:</span>
            <span>{view.riskReward}</span>
          </div>

          {view.rejections.length > 0 && (
            <div style={{ marginTop: '6px', fontSize: '11px', color: '#94a3b8' }}>
              <div
                style={{
                  fontSize: '10px',
                  color: '#64748b',
                  textTransform: 'uppercase',
                  marginBottom: '2px',
                }}
              >
                Rejection reasons
              </div>
              {view.rejections.map((r) => (
                <div key={r.code} style={{ marginBottom: '3px' }}>
                  <span style={{ color: '#f43f5e', fontFamily: 'monospace' }}>{r.code}</span>
                  <span> — {r.explanation}</span>
                </div>
              ))}
            </div>
          )}

          <div
            style={{
              marginTop: '8px',
              paddingTop: '8px',
              borderTop: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            <div
              style={{
                fontSize: '10px',
                color: '#64748b',
                textTransform: 'uppercase',
                marginBottom: '2px',
              }}
            >
              Reason
            </div>
            <div style={{ fontSize: '11px', color: '#94a3b8', fontStyle: 'italic' }}>
              {view.reason}
            </div>
          </div>

          <div
            style={{
              marginTop: '8px',
              paddingTop: '8px',
              borderTop: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            <div
              style={{
                fontSize: '10px',
                color: '#64748b',
                textTransform: 'uppercase',
                marginBottom: '2px',
              }}
            >
              Timing ({view.timezoneLabel})
            </div>
            <div className="signal-detail-row">
              <span style={{ color: '#64748b' }}>Signal Time:</span>
              <span>{view.signalTime}</span>
            </div>
            <div className="signal-detail-row">
              <span style={{ color: '#64748b' }}>Last Data Candle:</span>
              <span>{view.lastCandleTime}</span>
            </div>
            <div className="signal-detail-row">
              <span style={{ color: '#64748b' }}>Evaluated At:</span>
              <span>{view.evaluatedAt}</span>
            </div>
          </div>
        </div>

        {/* Last generated signal (historical) — distinct from the latest evaluation */}
        <div
          className="signal-details-list mono"
          style={{
            marginTop: '12px',
            paddingTop: '10px',
            borderTop: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div
            style={{
              fontSize: '10px',
              color: '#64748b',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              marginBottom: '4px',
            }}
          >
            {historical.label}
          </div>
          {historical.present ? (
            <>
              <div className="signal-detail-row">
                <span style={{ color: '#64748b' }}>Direction:</span>
                <span style={{ color: historicalColor }}>{historical.direction}</span>
              </div>
              <div className="signal-detail-row">
                <span style={{ color: '#64748b' }}>Pair:</span>
                <span>
                  {historical.symbolLine} · {String(historical.timeframe).toUpperCase()}
                </span>
              </div>
              <div className="signal-detail-row">
                <span style={{ color: '#64748b' }}>Setup:</span>
                <span>{historical.setup}</span>
              </div>
              <div className="signal-detail-row">
                <span style={{ color: '#64748b' }}>Confidence:</span>
                <span>{historical.confidence}</span>
              </div>
              <div className="signal-detail-row">
                <span style={{ color: '#64748b' }}>Entry:</span>
                <span>{historical.entry}</span>
              </div>
              <div className="signal-detail-row">
                <span style={{ color: '#64748b' }}>Stop Loss:</span>
                <span>{historical.stopLoss}</span>
              </div>
              <div className="signal-detail-row">
                <span style={{ color: '#64748b' }}>Take Profit:</span>
                <span>{historical.takeProfit}</span>
              </div>
              <div className="signal-detail-row">
                <span style={{ color: '#64748b' }}>Risk/Reward:</span>
                <span>{historical.riskReward}</span>
              </div>
              <div className="signal-detail-row">
                <span style={{ color: '#64748b' }}>
                  Signal Time ({historical.timezoneLabel}):
                </span>
                <span>{historical.signalTime}</span>
              </div>
              <div style={{ marginTop: '6px', fontSize: '10px', color: '#f59e0b' }}>
                {historical.validityNote}
              </div>
            </>
          ) : (
            <div style={{ fontSize: '11px', color: '#64748b' }}>{historical.emptyNote}</div>
          )}
        </div>
      </div>
    </div>
  );
}