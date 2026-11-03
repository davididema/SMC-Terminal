'use client';

import React from 'react';
import { Timeframe } from '@/lib/deriv/candles';
import { SignalDiagnostics, PairDiagnostics } from '@/lib/signals/signal-diagnostics';
import { buildSignalDiagnosticsView } from '@/lib/ui/signal-diagnostics-view';

interface SignalDiagnosticsPanelProps {
  diagnostics?: SignalDiagnostics | null;
  symbolId: string;
  timeframe: Timeframe | string;
  onReset?: () => void;
  showReset?: boolean;
  showSkippedIfMeasured?: boolean;
}

export function SignalDiagnosticsPanel({
  diagnostics,
  symbolId,
  timeframe,
  onReset,
  showReset = true,
  showSkippedIfMeasured = false,
}: SignalDiagnosticsPanelProps) {
  const d = diagnostics ? diagnostics.getPairDiagnostics(symbolId, timeframe as Timeframe) : null;
  const view = buildSignalDiagnosticsView({
    diagnostics: d,
    symbolId,
    timeframe,
    showSkippedIfMeasured,
  });

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
            <path d="M3 3v18h18M7 13l3 3 7-7" />
          </svg>
          <span>SIGNAL DIAGNOSTICS</span>
        </div>
        <div style={{ fontSize: '10px', color: '#64748b', letterSpacing: '0.4px' }}>
          {String(symbolId)} · {String(timeframe).toUpperCase()}
        </div>
      </div>

      <div className="panel-body">
        <div className="signal-details-list mono">
          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Completed Evaluations:</span>
            <span>{view.completedEvaluations}</span>
          </div>
          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>LONG Emissions:</span>
            <span>{view.longEmissions}</span>
          </div>
          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>SHORT Emissions:</span>
            <span>{view.shortEmissions}</span>
          </div>
          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>NO_TRADE Results:</span>
            <span>{view.noTradeResults}</span>
          </div>
          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Total Rejection Codes:</span>
            <span>{view.totalRejectionCodes}</span>
          </div>
          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Duplicate Rejections:</span>
            <span>{view.duplicateRejections}</span>
          </div>
          {view.hasSkippedMeasurement && (
            <div className="signal-detail-row">
              <span style={{ color: '#64748b' }}>Skipped Evaluations:</span>
              <span>{view.skippedEvaluations}</span>
            </div>
          )}
          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>First:</span>
            <span>{view.firstAt}</span>
          </div>
          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Most Recent:</span>
            <span>{view.lastAt}</span>
          </div>
          <div className="signal-detail-row">
            <span style={{ color: '#64748b' }}>Recent Timestamps:</span>
            <span>{view.recentCount}</span>
          </div>
        </div>

        {view.rejectionsTop.length > 0 && (
          <div
            className="signal-details-list mono"
            style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.05)' }}
          >
            <div
              style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', marginBottom: '2px' }}
            >
              Top Rejection Reasons
            </div>
            {view.rejectionsTop.map((r) => (
              <div key={r.code} className="signal-detail-row">
                <span style={{ color: '#94a3b8' }}>{r.code}</span>
                <span>{r.count}</span>
              </div>
            ))}
          </div>
        )}

        {!view.hasAnyEvaluations && (
          <div style={{ marginTop: '8px', fontSize: '11px', color: '#64748b' }}>
            No diagnostic evaluations recorded for this pair yet.
          </div>
        )}

        {showReset && onReset && (
          <div style={{ marginTop: '10px' }}>
            <button
              onClick={onReset}
              style={{
                background: 'transparent',
                color: '#94a3b8',
                border: '1px solid rgba(255,255,255,0.1)',
                padding: '4px 8px',
                fontSize: '10px',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                cursor: 'pointer',
              }}
            >
              Reset Diagnostics
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
