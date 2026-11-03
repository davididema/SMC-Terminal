'use client';

import React from 'react';

export function RiskPanel() {
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
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span>RISK MANAGEMENT (DISABLED)</span>
        </div>
      </div>

      <div className="panel-body">
        <div className="metric-grid mono">
          <div className="metric-item">
            <div className="metric-label">Account Balance</div>
            <div className="metric-val" style={{ color: '#64748b' }}>
              —
            </div>
          </div>

          <div className="metric-item">
            <div className="metric-label">Risk Per Trade</div>
            <div className="metric-val" style={{ color: '#64748b' }}>
              —
            </div>
          </div>

          <div className="metric-item">
            <div className="metric-label">Position Size</div>
            <div className="metric-val" style={{ color: '#64748b' }}>
              —
            </div>
          </div>

          <div className="metric-item">
            <div className="metric-label">Potential Loss</div>
            <div className="metric-val" style={{ color: '#64748b' }}>
              —
            </div>
          </div>

          <div className="metric-item">
            <div className="metric-label">Potential Profit</div>
            <div className="metric-val" style={{ color: '#64748b' }}>
              —
            </div>
          </div>

          <div className="metric-item">
            <div className="metric-label">Target R:R</div>
            <div className="metric-val" style={{ color: '#64748b' }}>
              —
            </div>
          </div>
        </div>

        <div
          style={{
            marginTop: '10px',
            fontSize: '10px',
            color: '#64748b',
            borderTop: '1px solid rgba(255, 255, 255, 0.05)',
            paddingTop: '6px',
          }}
        >
          Phase 1: Trade execution and risk sizing disabled. No broker orders placed.
        </div>
      </div>
    </div>
  );
}
