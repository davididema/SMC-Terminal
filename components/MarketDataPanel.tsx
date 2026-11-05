'use client';

import React from 'react';
import { ConnectionStatus } from '@/lib/deriv/websocket';
import { FeedState, feedStateLabel } from '@/lib/deriv/feed';

interface MarketDataPanelProps {
  status: ConnectionStatus;
  isWsActive: boolean;
  totalTicks: number;
  lastTickEpoch: number | null;
  activeTimeframe: string;
  activeCandlesCount: number;
  candles1mCount?: number;
  feedState: FeedState;
  feedMessage?: string;
  selectedSymbolId: string;
}

const FEED_COLORS: Record<FeedState, string> = {
  LIVE: '#10b981',
  STALE: '#f59e0b',
  PENDING: '#38bdf8',
  CLOSED: '#94a3b8',
  UNAVAILABLE: '#f43f5e',
  IDLE: '#64748b',
};

export function MarketDataPanel({
  status,
  isWsActive,
  totalTicks,
  lastTickEpoch,
  activeTimeframe,
  activeCandlesCount,
  candles1mCount = 0,
  feedState,
  feedMessage,
  selectedSymbolId,
}: MarketDataPanelProps) {
  const formatTime = (epoch: number | null) => {
    if (!epoch) return '—';
    const d = new Date(epoch * 1000);
    return d.toLocaleTimeString([], { hour12: false });
  };

  return (
    <div className="panel market-data-panel">
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
            <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
            <path d="M12 12v9" />
            <path d="m8 17 4 4 4-4" />
          </svg>
          <span>MARKET DATA CONNECTION</span>
        </div>
      </div>

      <div className="panel-body">
        <div className="metric-grid">
          <div className="metric-item">
            <div className="metric-label">Connection</div>
            <div
              className="metric-val mono"
              style={{
                color: status === 'CONNECTED' ? '#10b981' : '#f43f5e',
              }}
            >
              {status}
            </div>
          </div>

          <div className="metric-item">
            <div className="metric-label">WebSocket</div>
            <div
              className="metric-val mono"
              style={{
                color: isWsActive ? '#10b981' : '#64748b',
              }}
            >
              {isWsActive ? 'ACTIVE' : 'INACTIVE'}
            </div>
          </div>

          <div className="metric-item">
            <div className="metric-label">Ticks Received</div>
            <div className="metric-val mono" style={{ color: '#38bdf8' }}>
              {totalTicks.toLocaleString()}
            </div>
          </div>

          <div className="metric-item">
            <div className="metric-label">Last Tick Time</div>
            <div className="metric-val mono">{formatTime(lastTickEpoch)}</div>
          </div>

          <div className="metric-item">
            <div className="metric-label">Active Timeframe</div>
            <div className="metric-val mono" style={{ color: '#38bdf8' }}>
              {activeTimeframe.toUpperCase()}
            </div>
          </div>

          <div className="metric-item">
            <div className="metric-label">{activeTimeframe.toUpperCase()} Candles</div>
            <div className="metric-val mono">{activeCandlesCount}</div>
          </div>

          <div className="metric-item" style={{ gridColumn: '1 / 3' }} title={feedMessage}>
            <div className="metric-label">{selectedSymbolId} Feed</div>
            <div
              className="metric-val mono"
              style={{
                color: FEED_COLORS[feedState],
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: FEED_COLORS[feedState],
                }}
              />
              {feedStateLabel(feedState).toUpperCase()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
