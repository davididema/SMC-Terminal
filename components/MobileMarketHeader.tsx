'use client';

import React from 'react';
import { DerivSymbolConfig, SUPPORTED_SYMBOLS } from '@/lib/deriv/symbols';
import { FeedState, feedStateLabel } from '@/lib/deriv/feed';
import { Timeframe } from '@/lib/deriv/candles';
import { StructuralBias } from '@/lib/analysis/market-structure';

interface MobileMarketHeaderProps {
  selectedSymbol: DerivSymbolConfig;
  onSelectSymbol: (symbol: DerivSymbolConfig) => void;
  currentPrice: number | null;
  lastTickEpoch: number | null;
  feedState: FeedState;
  timeframe: Timeframe;
  structuralBias?: StructuralBias | null;
}

const FEED_COLORS: Record<FeedState, string> = {
  LIVE: '#10b981',
  STALE: '#f59e0b',
  PENDING: '#38bdf8',
  CLOSED: '#94a3b8',
  UNAVAILABLE: '#f43f5e',
  IDLE: '#64748b',
};

export function MobileMarketHeader({
  selectedSymbol,
  onSelectSymbol,
  currentPrice,
  lastTickEpoch,
  feedState,
  timeframe,
  structuralBias,
}: MobileMarketHeaderProps) {
  const formatTime = (epoch: number | null) => {
    if (!epoch) return '—';
    const d = new Date(epoch * 1000);
    return d.toLocaleTimeString([], { hour12: false });
  };

  const biasColor =
    structuralBias === 'BULLISH'
      ? '#10b981'
      : structuralBias === 'BEARISH'
      ? '#f43f5e'
      : '#94a3b8';

  return (
    <div className="mobile-market-header" role="region" aria-label="Mobile Market Information">
      <div className="mobile-market-top">
        {/* Symbol Selector Dropdown for Mobile */}
        <div className="mobile-symbol-selector">
          <label htmlFor="mobile-symbol-select" className="visually-hidden">
            Select Market Symbol
          </label>
          <select
            id="mobile-symbol-select"
            className="mobile-symbol-select"
            value={selectedSymbol.id}
            onChange={(e) => {
              const symbol = SUPPORTED_SYMBOLS.find((s) => s.id === e.target.value);
              if (symbol) onSelectSymbol(symbol);
            }}
          >
            {SUPPORTED_SYMBOLS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} — {s.displayName} ({s.category})
              </option>
            ))}
          </select>
          <div className="mobile-symbol-display">
            <span className="mobile-symbol-id">{selectedSymbol.id}</span>
            <span className="mobile-symbol-name">{selectedSymbol.displayName}</span>
            <span className="mobile-symbol-chevron" aria-hidden="true">▾</span>
          </div>
        </div>

        {/* Timeframe & Bias Badges */}
        <div className="mobile-market-badges">
          <span className="mobile-badge mobile-tf-badge mono">{timeframe.toUpperCase()}</span>
          {structuralBias && (
            <span
              className="mobile-badge mobile-bias-badge"
              style={{ color: biasColor, borderColor: biasColor }}
            >
              {structuralBias}
            </span>
          )}
        </div>
      </div>

      <div className="mobile-market-price-row">
        <div className="mobile-price-container">
          {currentPrice !== null ? (
            <span className="mobile-price-val mono">
              {currentPrice.toFixed(selectedSymbol.pipSize)}
            </span>
          ) : (
            <span className="mobile-price-val waiting mono">Waiting for tick...</span>
          )}
        </div>

        <div className="mobile-market-meta">
          <div className="mobile-feed-indicator" title={feedStateLabel(feedState)}>
            <span
              className="mobile-feed-dot"
              style={{ backgroundColor: FEED_COLORS[feedState] }}
            />
            <span className="mobile-feed-text" style={{ color: FEED_COLORS[feedState] }}>
              {feedStateLabel(feedState)}
            </span>
          </div>
          <span className="mobile-last-tick mono">
            {formatTime(lastTickEpoch)}
          </span>
        </div>
      </div>
    </div>
  );
}

