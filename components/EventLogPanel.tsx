'use client';

import React, { useRef, useEffect } from 'react';
import { DerivLogEntry } from '@/lib/deriv/websocket';

interface EventLogPanelProps {
  logs: DerivLogEntry[];
  onClearLogs?: () => void;
}

export function EventLogPanel({ logs, onClearLogs }: EventLogPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div className="panel log-panel">
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
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" x2="20" y1="19" y2="19" />
          </svg>
          <span>LIVE SYSTEM & WEBSOCKET EVENT LOG ({logs.length})</span>
        </div>

        {onClearLogs && (
          <button
            onClick={onClearLogs}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#64748b',
              fontSize: '10px',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
            }}
          >
            CLEAR LOG
          </button>
        )}
      </div>

      <div className="log-scroll" ref={scrollRef}>
        {logs.length === 0 ? (
          <div style={{ color: '#475569', padding: '4px' }}>No events logged yet.</div>
        ) : (
          logs.map((entry) => (
            <div key={entry.id} className="log-entry">
              <span className="log-time">[{formatTime(entry.timestamp)}]</span>
              <span className={`log-msg ${entry.level}`}>{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
