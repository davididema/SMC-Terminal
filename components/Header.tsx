'use client';

import React from 'react';
import { ConnectionStatus } from '@/lib/deriv/websocket';
import { DerivSymbolConfig } from '@/lib/deriv/symbols';
import { FeedState, feedStateLabel } from '@/lib/deriv/feed';

interface HeaderProps {
  status: ConnectionStatus;
  selectedSymbol: DerivSymbolConfig;
  currentPrice: number | null;
  lastTickEpoch: number | null;
  feedState: FeedState;
  onReconnect: () => void;
}

export function Header({
  status,
  selectedSymbol,
  currentPrice,
  lastTickEpoch,
  feedState,
  onReconnect,
}: HeaderProps) {
  const isOnline = status === 'CONNECTED';
  const isConnecting = status === 'CONNECTING' || status === 'RECONNECTING';

  const formatLastTickTime = (epoch: number | null) => {
    if (!epoch) return '—';
    const d = new Date(epoch * 1000);
    return d.toLocaleTimeString([], { hour12: false });
  };

  return (
    <header className="terminal-header">
      <div className="header-left">
        <div className="brand-badge">
          <div className="brand-logo-icon">SMC</div>
          <span>SMC TERMINAL</span>
        </div>

        <div
          className={`live-badge ${
            isOnline ? 'online' : isConnecting ? 'connecting' : 'offline'
          }`}
        >
          <span className={`live-indicator-dot ${isOnline ? 'pulse' : ''}`} />
          <span>{isOnline ? 'LIVE' : isConnecting ? 'CONNECTING' : 'OFFLINE'}</span>
        </div>
      </div>

      <div className="header-center">
        <div className="header-symbol-highlight">
          {selectedSymbol.id}{' '}
          <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 500 }}>
            ({selectedSymbol.displayName})
          </span>
        </div>

        <div className="header-price-highlight mono" style={{ color: '#fff' }}>
          {currentPrice !== null ? (
            <span>
              {currentPrice.toFixed(selectedSymbol.pipSize)}
              {feedState !== 'LIVE' && (
                <span
                  title="Last received price — the symbol feed is not live"
                  style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    marginLeft: '6px',
                    color: feedState === 'STALE' ? '#f59e0b' : '#94a3b8',
                  }}
                >
                  LAST · {feedStateLabel(feedState)}
                </span>
              )}
            </span>
          ) : (
            <span style={{ color: '#64748b' }}>Waiting for tick...</span>
          )}
        </div>

        <div className="header-tick-time">
          LAST TICK: <span style={{ color: '#94a3b8' }}>{formatLastTickTime(lastTickEpoch)}</span>
        </div>
      </div>

      <div className="header-right">
        <div
          className="mono"
          style={{
            fontSize: '11px',
            color: isOnline ? '#10b981' : isConnecting ? '#f59e0b' : '#f43f5e',
            fontWeight: 600,
          }}
        >
          WS: {status}
        </div>

        <button className="header-btn" onClick={onReconnect} title="Force Reconnect">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
          </svg>
          <span>RECONNECT</span>
        </button>
      </div>
    </header>
  );
}
