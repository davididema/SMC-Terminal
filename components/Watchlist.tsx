'use client';

import React from 'react';
import { DerivSymbolConfig, SUPPORTED_SYMBOLS } from '@/lib/deriv/symbols';
import { FeedState, FeedStatus, feedStateLabel } from '@/lib/deriv/feed';

interface WatchlistProps {
  selectedSymbolId: string;
  onSelectSymbol: (symbol: DerivSymbolConfig) => void;
  prices: Map<string, number>;
  feedStatuses: Map<string, FeedStatus>;
}

const FEED_COLORS: Record<FeedState, string> = {
  LIVE: '#10b981',
  STALE: '#f59e0b',
  PENDING: '#38bdf8',
  CLOSED: '#94a3b8',
  UNAVAILABLE: '#f43f5e',
  IDLE: '#475569',
};

export function Watchlist({
  selectedSymbolId,
  onSelectSymbol,
  prices,
  feedStatuses,
}: WatchlistProps) {
  return (
    <div className="panel watchlist-container">
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
            <path d="M3 3v18h18" />
            <path d="m19 9-5 5-4-4-3 3" />
          </svg>
          <span>WATCHLIST ({SUPPORTED_SYMBOLS.length})</span>
        </div>
      </div>

      <div className="panel-body" style={{ padding: '6px' }}>
        <div className="watchlist-items">
          {SUPPORTED_SYMBOLS.map((s) => {
            const isSelected = s.id === selectedSymbolId;
            const price = prices.get(s.id);
            const status = feedStatuses.get(s.id);
            const state: FeedState = status?.state ?? 'IDLE';
            const isStale = state === 'STALE';

            return (
              <div
                key={s.id}
                className={`watchlist-item ${isSelected ? 'selected' : ''}`}
                onClick={() => onSelectSymbol(s)}
              >
                <div className="symbol-meta">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span className="symbol-id">{s.id}</span>
                    {isStale && (
                      <span
                        style={{
                          fontSize: '9px',
                          color: '#f59e0b',
                          background: 'rgba(245,158,11,0.15)',
                          padding: '1px 4px',
                          borderRadius: '2px',
                        }}
                      >
                        STALE
                      </span>
                    )}
                  </div>
                  <span className="symbol-category">{s.category}</span>
                </div>

                <div className="symbol-price-info">
                  <div
                    className="symbol-price"
                    style={{
                      color:
                        state === 'LIVE'
                          ? '#fff'
                          : price !== undefined
                            ? '#cbd5e1'
                            : '#64748b',
                    }}
                  >
                    {price !== undefined ? (
                      <>
                        {price.toFixed(s.pipSize)}
                        {state !== 'LIVE' && (
                          <span
                            title="Last received price — the symbol feed is not live"
                            style={{
                              fontSize: '9px',
                              color: '#64748b',
                              marginLeft: '4px',
                              fontWeight: 500,
                            }}
                          >
                            last
                          </span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </div>
                  <div className="symbol-status-tag" title={status?.errorMessage ?? undefined}>
                    <span
                      style={{
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        backgroundColor: FEED_COLORS[state],
                      }}
                    />
                    <span style={{ color: '#64748b' }}>{feedStateLabel(state)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
