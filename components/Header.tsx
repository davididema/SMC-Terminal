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
  /** Optional notification count for responsive notification bell */
  notificationCount?: number;
  /** Toggle notification drawer/overlay */
  onToggleNotifications?: () => void;
  /** Whether the notification drawer is currently open */
  isNotificationOpen?: boolean;
}

export function Header({
  status,
  selectedSymbol,
  currentPrice,
  lastTickEpoch,
  feedState,
  onReconnect,
  notificationCount = 0,
  onToggleNotifications,
  isNotificationOpen = false,
}: HeaderProps) {
  const isOnline = status === 'CONNECTED';
  const isConnecting = status === 'CONNECTING' || status === 'RECONNECTING';

  const formatLastTickTime = (epoch: number | null) => {
    if (!epoch) return '—';
    const d = new Date(epoch * 1000);
    return d.toLocaleTimeString([], { hour12: false });
  };

  return (
    <header className="terminal-header" role="banner">
      <div className="header-left">
        <div className="brand-badge">
          <div className="brand-logo-icon" aria-hidden="true">SMC</div>
          <span className="brand-title">SMC TERMINAL</span>
        </div>

        <div
          className={`live-badge ${
            isOnline ? 'online' : isConnecting ? 'connecting' : 'offline'
          }`}
          title={`Connection: ${status}`}
        >
          <span className={`live-indicator-dot ${isOnline ? 'pulse' : ''}`} aria-hidden="true" />
          <span className="live-status-text">{isOnline ? 'LIVE' : isConnecting ? 'CONNECTING' : 'OFFLINE'}</span>
        </div>
      </div>

      <div className="header-center">
        <div className="header-symbol-highlight">
          <span className="header-symbol-id">{selectedSymbol.id}</span>{' '}
          <span className="header-symbol-name">
            ({selectedSymbol.displayName})
          </span>
        </div>

        <div className="header-price-highlight mono">
          {currentPrice !== null ? (
            <span>
              {currentPrice.toFixed(selectedSymbol.pipSize)}
              {feedState !== 'LIVE' && (
                <span
                  className="header-feed-note"
                  title="Last received price — the symbol feed is not live"
                  style={{
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
          className="mono header-ws-status"
          style={{
            fontSize: '11px',
            color: isOnline ? '#10b981' : isConnecting ? '#f59e0b' : '#f43f5e',
            fontWeight: 600,
          }}
        >
          WS: {status}
        </div>

        <button
          className="header-btn header-reconnect-btn"
          onClick={onReconnect}
          title="Force Reconnect"
          aria-label="Force Reconnect"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
          </svg>
          <span className="header-btn-text">RECONNECT</span>
        </button>

        {/* NOTIFICATION BELL ICON BUTTON */}
        {onToggleNotifications && (
          <button
            type="button"
            id="btn-toggle-notifications"
            className={`header-btn notification-bell-btn ${isNotificationOpen ? 'active' : ''}`}
            onClick={onToggleNotifications}
            title={notificationCount > 0 ? `${notificationCount} new signals` : 'Notifications'}
            aria-label={`Notifications${notificationCount > 0 ? ` (${notificationCount} unread)` : ''}`}
            aria-expanded={isNotificationOpen}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            {notificationCount > 0 && (
              <span className="notification-badge-count" aria-hidden="true">
                {notificationCount > 99 ? '99+' : notificationCount}
              </span>
            )}
          </button>
        )}
      </div>
    </header>
  );
}
