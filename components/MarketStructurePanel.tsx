'use client';

import React, { useState } from 'react';
import { MarketStructureState } from '@/lib/analysis/market-structure';

interface MarketStructurePanelProps {
  data?: MarketStructureState | null;
}

export function MarketStructurePanel({ data }: MarketStructurePanelProps) {
  const [showDebug, setShowDebug] = useState(false);

  const symbol = data?.symbol ?? '—';
  const timeframe = data?.timeframe ? data.timeframe.toUpperCase() : '—';
  const structuralBias = data?.structuralBias ?? 'NEUTRAL';

  const formatEpoch = (epoch?: number | null) => {
    if (!epoch) return '—';
    const d = new Date(epoch * 1000);
    return d.toLocaleTimeString([], { hour12: false });
  };

  const swingHigh = data?.latestSwingHigh;
  const swingLow = data?.latestSwingLow;
  const recentSeq = data?.recentStructureSequence ?? [];

  // Phase 2: Protected Levels and Breaks
  const protectedHigh = data?.protectedHigh;
  const protectedLow = data?.protectedLow;
  const latestBOS = data?.latestBOS;
  const latestCHoCH = data?.latestCHoCH;

  const getBiasColor = (bias: string) => {
    switch (bias) {
      case 'BULLISH':
        return '#10b981';
      case 'BEARISH':
        return '#f43f5e';
      default:
        return '#94a3b8';
    }
  };

  return (
    <div className="panel market-structure-panel">
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
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <span>MARKET STRUCTURE (BOS / CHOCH)</span>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '10px', color: '#64748b' }}>
            {symbol} [{timeframe}]
          </span>
          <button
            id="btn-toggle-market-structure-debug"
            onClick={() => setShowDebug(!showDebug)}
            style={{
              background: showDebug ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '3px',
              color: showDebug ? '#38bdf8' : '#94a3b8',
              fontSize: '9px',
              padding: '2px 6px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
            title="Toggle Debug / Inspection View"
          >
            {showDebug ? 'DEBUG ON' : 'INSPECT'}
          </button>
        </div>
      </div>

      <div className="panel-body">
        <div className="metric-grid">
          {/* 1. Structural Bias */}
          <div className="metric-item" style={{ gridColumn: '1 / 3' }}>
            <div className="metric-label">Swing-Based Structural Bias</div>
            <div
              className="metric-val mono"
              style={{
                color: getBiasColor(structuralBias),
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span
                style={{
                  width: '7px',
                  height: '7px',
                  borderRadius: '50%',
                  backgroundColor: getBiasColor(structuralBias),
                }}
              />
              <strong>{structuralBias}</strong>
              <span style={{ fontSize: '10px', color: '#64748b', fontWeight: 400 }}>
                ({data?.swings?.length ?? 0} swings, {data?.breaks?.length ?? 0} breaks)
              </span>
            </div>
          </div>

          {/* 2. Protected Levels (Phase 2) */}
          {protectedLow && (
            <div className="metric-item" style={{ gridColumn: '1 / 3', background: 'rgba(16, 185, 129, 0.08)' }}>
              <div className="metric-label" style={{ color: '#10b981' }}>Protected Low (HL)</div>
              <div className="metric-val mono" style={{ color: '#fff' }}>
                {protectedLow.price}
                <span style={{ fontSize: '10px', color: '#64748b', marginLeft: '6px' }}>
                  @ {formatEpoch(protectedLow.candleEpoch)}
                </span>
              </div>
            </div>
          )}

          {protectedHigh && (
            <div className="metric-item" style={{ gridColumn: '1 / 3', background: 'rgba(244, 63, 94, 0.08)' }}>
              <div className="metric-label" style={{ color: '#f43f5e' }}>Protected High (LH)</div>
              <div className="metric-val mono" style={{ color: '#fff' }}>
                {protectedHigh.price}
                <span style={{ fontSize: '10px', color: '#64748b', marginLeft: '6px' }}>
                  @ {formatEpoch(protectedHigh.candleEpoch)}
                </span>
              </div>
            </div>
          )}

          {/* 3. Last BOS */}
          <div className="metric-item">
            <div className="metric-label">Last BOS</div>
            <div className="metric-val mono" style={{ color: latestBOS?.direction === 'BULLISH' ? '#38bdf8' : '#f43f5e', fontSize: '11px' }}>
              {latestBOS ? (
                <>
                  <div>{latestBOS.type}</div>
                  <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '2px' }}>
                    Level: <strong style={{ color: '#fff' }}>{latestBOS.brokenPrice}</strong>
                  </div>
                  <div style={{ fontSize: '9px', color: '#64748b' }}>
                    Conf: {formatEpoch(latestBOS.confirmedAtEpoch)}
                  </div>
                </>
              ) : (
                'None'
              )}
            </div>
          </div>

          {/* 4. Last CHoCH */}
          <div className="metric-item">
            <div className="metric-label">Last CHoCH</div>
            <div className="metric-val mono" style={{ color: latestCHoCH?.direction === 'BULLISH' ? '#10b981' : '#e879f9', fontSize: '11px' }}>
              {latestCHoCH ? (
                <>
                  <div>{latestCHoCH.type}</div>
                  <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '2px' }}>
                    Level: <strong style={{ color: '#fff' }}>{latestCHoCH.brokenPrice}</strong>
                  </div>
                  <div style={{ fontSize: '9px', color: '#64748b' }}>
                    Conf: {formatEpoch(latestCHoCH.confirmedAtEpoch)}
                  </div>
                </>
              ) : (
                'None'
              )}
            </div>
          </div>

          {/* 5. Latest Swings */}
          <div className="metric-item">
            <div className="metric-label">Latest Swing High</div>
            <div className="metric-val mono" style={{ color: '#10b981' }}>
              {swingHigh ? swingHigh.price : '—'}
            </div>
            {swingHigh && (
              <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px' }}>
                <span style={{ color: '#38bdf8' }}>[{swingHigh.structureType}]</span> @ {formatEpoch(swingHigh.candleEpoch)}
              </div>
            )}
          </div>

          <div className="metric-item">
            <div className="metric-label">Latest Swing Low</div>
            <div className="metric-val mono" style={{ color: '#f43f5e' }}>
              {swingLow ? swingLow.price : '—'}
            </div>
            {swingLow && (
              <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px' }}>
                <span style={{ color: '#f59e0b' }}>[{swingLow.structureType}]</span> @ {formatEpoch(swingLow.candleEpoch)}
              </div>
            )}
          </div>

          {/* 6. Recent Structure Sequence */}
          <div className="metric-item" style={{ gridColumn: '1 / 3' }}>
            <div className="metric-label">Recent Structure</div>
            <div
              className="metric-val mono"
              style={{
                fontSize: '11px',
                color: '#e2e8f0',
                display: 'flex',
                gap: '6px',
                alignItems: 'center',
                flexWrap: 'wrap',
                marginTop: '4px',
              }}
            >
              {recentSeq.length > 0 ? (
                recentSeq.map((st, idx) => (
                  <React.Fragment key={idx}>
                    <span
                      style={{
                        padding: '2px 5px',
                        borderRadius: '3px',
                        background:
                          st === 'HH' || st === 'HL'
                            ? 'rgba(16, 185, 129, 0.15)'
                            : st === 'LH' || st === 'LL'
                            ? 'rgba(244, 63, 94, 0.15)'
                            : 'rgba(148, 163, 184, 0.15)',
                        color:
                          st === 'HH' || st === 'HL'
                            ? '#10b981'
                            : st === 'LH' || st === 'LL'
                            ? '#f43f5e'
                            : '#94a3b8',
                        fontWeight: 600,
                      }}
                    >
                      {st}
                    </span>
                    {idx < recentSeq.length - 1 && <span style={{ color: '#475569' }}>→</span>}
                  </React.Fragment>
                ))
              ) : (
                <span style={{ color: '#64748b' }}>Awaiting swing confirmation...</span>
              )}
            </div>
          </div>

          {/* 7. Optional Debug / Inspection Section */}
          {showDebug && (
            <div
              className="metric-item mono"
              style={{
                gridColumn: '1 / 3',
                background: 'rgba(15, 23, 42, 0.6)',
                border: '1px dashed rgba(56, 189, 248, 0.3)',
                padding: '8px',
                borderRadius: '4px',
                fontSize: '10px',
                color: '#94a3b8',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              <div style={{ color: '#38bdf8', fontWeight: 600, marginBottom: '2px' }}>
                // ENGINE INSPECTION (PHASE 2: BOS / CHOCH)
              </div>
              <div>Symbol: <span style={{ color: '#fff' }}>{symbol}</span> | Timeframe: <span style={{ color: '#fff' }}>{timeframe}</span></div>
              <div>Total Confirmed Breaks: <span style={{ color: '#38bdf8' }}>{data?.breaks?.length ?? 0}</span></div>
              <div>Confirmation Mode: <span style={{ color: '#10b981' }}>Closed Candle Only</span> (Zero Look-ahead)</div>
              {protectedLow && (
                <div>Protected Low: <span style={{ color: '#10b981' }}>{protectedLow.price}</span> (@ {formatEpoch(protectedLow.candleEpoch)})</div>
              )}
              {protectedHigh && (
                <div>Protected High: <span style={{ color: '#f43f5e' }}>{protectedHigh.price}</span> (@ {formatEpoch(protectedHigh.candleEpoch)})</div>
              )}
              {latestBOS && (
                <div>Last BOS: <span style={{ color: '#38bdf8' }}>{latestBOS.type}</span> @ {latestBOS.brokenPrice} (Confirmed @ {formatEpoch(latestBOS.confirmedAtEpoch)})</div>
              )}
              {latestCHoCH && (
                <div>Last CHoCH: <span style={{ color: '#e879f9' }}>{latestCHoCH.type}</span> @ {latestCHoCH.brokenPrice} (Confirmed @ {formatEpoch(latestCHoCH.confirmedAtEpoch)})</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
