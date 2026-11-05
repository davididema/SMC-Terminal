'use client';

import React from 'react';

export type MobileTab = 'overview' | 'chart' | 'analysis' | 'events';

interface MobileBottomNavProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  hasActiveSignal?: boolean;
}

export function MobileBottomNav({
  activeTab,
  onTabChange,
  hasActiveSignal = false,
}: MobileBottomNavProps) {
  return (
    <nav className="mobile-bottom-nav" aria-label="Mobile Navigation">
      <button
        type="button"
        id="nav-btn-overview"
        className={`mobile-nav-btn ${activeTab === 'overview' ? 'active' : ''}`}
        onClick={() => onTabChange('overview')}
        aria-label="Overview"
        aria-selected={activeTab === 'overview'}
      >
        <div className="mobile-nav-icon-wrap">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect width="7" height="9" x="3" y="3" rx="1" />
            <rect width="7" height="5" x="14" y="3" rx="1" />
            <rect width="7" height="9" x="14" y="12" rx="1" />
            <rect width="7" height="5" x="3" y="16" rx="1" />
          </svg>
          {hasActiveSignal && <span className="mobile-nav-dot" title="Active Signal" />}
        </div>
        <span className="mobile-nav-label">Overview</span>
      </button>

      <button
        type="button"
        id="nav-btn-chart"
        className={`mobile-nav-btn ${activeTab === 'chart' ? 'active' : ''}`}
        onClick={() => onTabChange('chart')}
        aria-label="Chart"
        aria-selected={activeTab === 'chart'}
      >
        <div className="mobile-nav-icon-wrap">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 3v18h18" />
            <path d="m19 9-5 5-4-4-3 3" />
          </svg>
        </div>
        <span className="mobile-nav-label">Chart</span>
      </button>

      <button
        type="button"
        id="nav-btn-analysis"
        className={`mobile-nav-btn ${activeTab === 'analysis' ? 'active' : ''}`}
        onClick={() => onTabChange('analysis')}
        aria-label="Analysis"
        aria-selected={activeTab === 'analysis'}
      >
        <div className="mobile-nav-icon-wrap">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polygon points="12 2 2 7 12 12 22 7 12 2" />
            <polyline points="2 17 12 22 22 17" />
            <polyline points="2 12 12 17 22 12" />
          </svg>
        </div>
        <span className="mobile-nav-label">Analysis</span>
      </button>

      <button
        type="button"
        id="nav-btn-events"
        className={`mobile-nav-btn ${activeTab === 'events' ? 'active' : ''}`}
        onClick={() => onTabChange('events')}
        aria-label="Events"
        aria-selected={activeTab === 'events'}
      >
        <div className="mobile-nav-icon-wrap">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" x2="20" y1="19" y2="19" />
          </svg>
        </div>
        <span className="mobile-nav-label">Events</span>
      </button>
    </nav>
  );
}

