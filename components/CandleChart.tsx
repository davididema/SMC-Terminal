'use client';

import React, { useRef, useEffect, useState, useMemo } from 'react';
import { Candle, Timeframe, TIMEFRAMES } from '@/lib/deriv/candles';
import { SwingPoint } from '@/lib/analysis/market-structure';
import { StructureBreak } from '@/lib/analysis/structure-breaks';
import {
  ChartViewport,
  createViewport,
  clampViewport,
  panViewport,
  zoomViewport,
  zoomViewportAt,
  resetViewport,
  resumeLive,
  viewportSummary,
  xToIndex,
  clampPriceScale,
  clampCount,
  MIN_VISIBLE_CANDLES,
  DEFAULT_VISIBLE_CANDLES,
  DEFAULT_PRICE_SCALE,
} from '@/lib/ui/chart-viewport';

// Shared plot margins so rendering and pointer math agree exactly.
const CHART_MARGIN = { top: 20, right: 75, bottom: 30, left: 10 } as const;

interface CandleChartProps {
  symbolId: string;
  candles: Candle[];
  currentCandle: Candle | null;
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  pipSize?: number;
  lastPrice?: number | null;
  swings?: SwingPoint[];
  breaks?: StructureBreak[];
}

export function CandleChart({
  symbolId,
  candles,
  currentCandle,
  timeframe,
  onTimeframeChange,
  pipSize = 4,
  lastPrice,
  swings = [],
  breaks = [],
}: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const [crosshairPos, setCrosshairPos] = useState<{ x: number; y: number } | null>(null);

  // Zoom / pan viewport (which slice of the candle history is visible) and the
  // independent vertical price zoom factor.
  const [viewport, setViewport] = useState<ChartViewport>(() =>
    createViewport(0, DEFAULT_VISIBLE_CANDLES)
  );
  const [priceScale, setPriceScale] = useState(DEFAULT_PRICE_SCALE);

  // Latest history length, mirrored into a ref so event listeners registered
  // once (wheel, pointer) always read the current total without re-binding.
  const totalRef = useRef(0);
  // Active pointer drag (pan) state.
  const dragRef = useRef<{ pointerId: number; x: number; start: number } | null>(null);
  // Guard so the hover crosshair is suppressed while dragging.
  const isDraggingRef = useRef(false);

  // Combine historical closed candles with current forming candle
  const displayCandles: Candle[] = React.useMemo(() => {
    const list = [...candles];
    if (currentCandle) {
      // Check if already in list
      const idx = list.findIndex((c) => c.epoch === currentCandle.epoch);
      if (idx >= 0) {
        list[idx] = currentCandle;
      } else {
        list.push(currentCandle);
      }
    }
    return list;
  }, [candles, currentCandle]);

  // Map confirmed swings by candle epoch for fast chart rendering
  const swingsMap = useMemo(() => {
    const map = new Map<number, SwingPoint>();
    for (const s of swings) {
      map.set(s.candleEpoch, s);
    }
    return map;
  }, [swings]);

  // Map confirmed structural breaks by breakCandleEpoch
  const breaksMap = useMemo(() => {
    const map = new Map<number, StructureBreak>();
    for (const b of breaks) {
      map.set(b.breakCandleEpoch, b);
    }
    return map;
  }, [breaks]);

  // Derived, always-valid viewport. Clamping on read (rather than in state)
  // means a following viewport tracks new candles without any state churn.
  const totalCandles = displayCandles.length;
  totalRef.current = totalCandles;
  const activeViewport = useMemo(
    () => clampViewport(viewport, totalCandles),
    [viewport, totalCandles]
  );
  const summary = useMemo(
    () => viewportSummary(activeViewport, totalCandles),
    [activeViewport, totalCandles]
  );

  // A new symbol or timeframe opens pinned to its latest candles at default zoom.
  useEffect(() => {
    setViewport(createViewport(0, DEFAULT_VISIBLE_CANDLES));
    setPriceScale(DEFAULT_PRICE_SCALE);
    dragRef.current = null;
    isDraggingRef.current = false;
  }, [symbolId, timeframe]);

  // Horizontal zoom via the mouse wheel, anchored at the cursor. Registered as
  // a non-passive native listener so the default page scroll can be prevented.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const chartWidth = rect.width - CHART_MARGIN.left - CHART_MARGIN.right;
      if (chartWidth <= 0) return;
      const anchorRatio = (e.clientX - rect.left - CHART_MARGIN.left) / chartWidth;
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      setViewport((prev) => zoomViewportAt(prev, factor, anchorRatio, totalRef.current));
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width;
    const height = rect.height;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    if (displayCandles.length === 0) {
      // Waiting for data state
      ctx.fillStyle = '#64748b';
      ctx.font = '13px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(
        `Awaiting real-time tick data for ${symbolId} (${timeframe})...`,
        width / 2,
        height / 2
      );
      return;
    }

    // Chart margins
    const margin = CHART_MARGIN;
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;

    // Only the viewport's slice of history is drawn.
    const visibleData = displayCandles.slice(
      activeViewport.start,
      activeViewport.start + activeViewport.count
    );
    if (visibleData.length === 0) return;

    // Calculate High & Low
    let minPrice = Infinity;
    let maxPrice = -Infinity;

    for (const c of visibleData) {
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
    }

    if (lastPrice) {
      minPrice = Math.min(minPrice, lastPrice);
      maxPrice = Math.max(maxPrice, lastPrice);
    }

    // Vertical zoom changes the price padding: a larger scale tightens the
    // range (taller candles), a smaller scale widens it (zoomed out).
    const zoom = clampPriceScale(priceScale);
    const padding = 0.08 / zoom;
    const priceRange = maxPrice - minPrice || 0.001;
    const paddedMin = minPrice - priceRange * padding;
    const paddedMax = maxPrice + priceRange * padding;
    const paddedRange = paddedMax - paddedMin;

    const priceToY = (p: number) => {
      return margin.top + chartHeight - ((p - paddedMin) / paddedRange) * chartHeight;
    };

    // Draw Price Grid lines (horizontal)
    const gridLines = 6;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';

    for (let i = 0; i <= gridLines; i++) {
      const price = paddedMin + (paddedRange / gridLines) * i;
      const y = priceToY(price);

      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + chartWidth, y);
      ctx.stroke();

      // Price label on right axis
      ctx.fillStyle = '#64748b';
      ctx.fillText(price.toFixed(pipSize), margin.left + chartWidth + 6, y + 3);
    }

    // Candle widths and spacing
    const candleSlotWidth = chartWidth / visibleData.length;
    const candleBodyWidth = Math.max(2, Math.min(12, candleSlotWidth * 0.7));

    // Draw Candlesticks
    visibleData.forEach((c, idx) => {
      const xCenter = margin.left + idx * candleSlotWidth + candleSlotWidth / 2;
      const isBullish = c.close >= c.open;
      const color = isBullish ? '#10b981' : '#f43f5e';

      const yHigh = priceToY(c.high);
      const yLow = priceToY(c.low);
      const yOpen = priceToY(c.open);
      const yClose = priceToY(c.close);

      const bodyTop = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(1.5, Math.abs(yClose - yOpen));

      // Draw wick
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(xCenter, yHigh);
      ctx.lineTo(xCenter, yLow);
      ctx.stroke();

      // Draw body
      ctx.fillStyle = color;
      ctx.fillRect(xCenter - candleBodyWidth / 2, bodyTop, candleBodyWidth, bodyHeight);

      // Draw Confirmed Swing High / Low Markers & Structure Labels
      const swing = swingsMap.get(c.epoch);
      if (swing) {
        ctx.save();
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';

        if (swing.type === 'HIGH') {
          const markerY = yHigh - 5;
          // Downward pointer
          ctx.fillStyle = '#38bdf8';
          ctx.beginPath();
          ctx.moveTo(xCenter, markerY);
          ctx.lineTo(xCenter - 4, markerY - 5);
          ctx.lineTo(xCenter + 4, markerY - 5);
          ctx.closePath();
          ctx.fill();

          // Label text (HH, LH, EQH)
          ctx.fillText(swing.structureType, xCenter, markerY - 8);
        } else {
          const markerY = yLow + 5;
          // Upward pointer
          ctx.fillStyle = '#f59e0b';
          ctx.beginPath();
          ctx.moveTo(xCenter, markerY);
          ctx.lineTo(xCenter - 4, markerY + 5);
          ctx.lineTo(xCenter + 4, markerY + 5);
          ctx.closePath();
          ctx.fill();

          // Label text (HL, LL, EQL)
          ctx.fillText(swing.structureType, xCenter, markerY + 15);
        }
        ctx.restore();
      }

      // Draw Confirmed BOS / CHoCH Break Labels (Phase 2)
      const breakEvent = breaksMap.get(c.epoch);
      if (breakEvent) {
        ctx.save();
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';

        const isBullish = breakEvent.direction === 'BULLISH';
        const isBOS = breakEvent.type.includes('BOS');
        const isCHOCH = breakEvent.type.includes('CHOCH');

        const text = isBOS
          ? isBullish
            ? 'BOS ↑'
            : 'BOS ↓'
          : isCHOCH
          ? isBullish
            ? 'CHoCH ↑'
            : 'CHoCH ↓'
          : isBullish
          ? 'BREAK ↑'
          : 'BREAK ↓';

        const badgeColor = isBOS
          ? isBullish
            ? '#38bdf8'
            : '#f43f5e'
          : isBullish
          ? '#10b981'
          : '#e879f9';
        const badgeBg = isBOS
          ? isBullish
            ? 'rgba(56, 189, 248, 0.2)'
            : 'rgba(244, 63, 94, 0.2)'
          : isBullish
          ? 'rgba(16, 185, 129, 0.2)'
          : 'rgba(232, 121, 249, 0.2)';

        const badgeY = isBullish
          ? Math.max(margin.top + 28, yHigh - 22)
          : Math.min(margin.top + chartHeight - 28, yLow + 26);
        const textWidth = ctx.measureText(text).width;

        // Subtle pill background
        ctx.fillStyle = badgeBg;
        ctx.fillRect(xCenter - textWidth / 2 - 4, badgeY - 8, textWidth + 8, 12);
        ctx.strokeStyle = badgeColor;
        ctx.lineWidth = 0.8;
        ctx.strokeRect(xCenter - textWidth / 2 - 4, badgeY - 8, textWidth + 8, 12);

        // Text label
        ctx.fillStyle = badgeColor;
        ctx.fillText(text, xCenter, badgeY + 1);

        // Subtle horizontal dashed reference from broken swing price to break candle
        if (breakEvent.brokenPrice) {
          const yBroken = priceToY(breakEvent.brokenPrice);
          ctx.beginPath();
          ctx.setLineDash([2, 3]);
          ctx.strokeStyle = badgeColor;
          ctx.lineWidth = 0.8;
          ctx.moveTo(xCenter - 25, yBroken);
          ctx.lineTo(xCenter, yBroken);
          ctx.stroke();
        }

        ctx.restore();
      }

      // Time axis marker every 8 candles
      if (idx % 8 === 0 || idx === visibleData.length - 1) {
        const date = new Date(c.epoch * 1000);
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const timeStr = `${hours}:${minutes}`;

        ctx.fillStyle = '#475569';
        ctx.textAlign = 'center';
        ctx.fillText(timeStr, xCenter, height - 10);
      }
    });

    // Draw Current Last Price Line
    const activePrice = lastPrice ?? visibleData[visibleData.length - 1]?.close;
    if (activePrice) {
      const yLast = priceToY(activePrice);
      const isUp = currentCandle ? currentCandle.close >= currentCandle.open : true;
      const lineColor = isUp ? '#10b981' : '#f43f5e';

      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(margin.left, yLast);
      ctx.lineTo(margin.left + chartWidth, yLast);
      ctx.stroke();
      ctx.restore();

      // Current Price Badge on Right Axis
      ctx.fillStyle = lineColor;
      ctx.fillRect(margin.left + chartWidth + 2, yLast - 9, margin.right - 6, 18);
      ctx.fillStyle = '#080a0f';
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(activePrice.toFixed(pipSize), margin.left + chartWidth + 5, yLast + 4);
    }

    // Crosshair rendering
    if (crosshairPos && crosshairPos.x >= margin.left && crosshairPos.x <= margin.left + chartWidth) {
      ctx.save();
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 1;

      // Vertical line
      ctx.beginPath();
      ctx.moveTo(crosshairPos.x, margin.top);
      ctx.lineTo(crosshairPos.x, margin.top + chartHeight);
      ctx.stroke();

      // Horizontal line
      ctx.beginPath();
      ctx.moveTo(margin.left, crosshairPos.y);
      ctx.lineTo(margin.left + chartWidth, crosshairPos.y);
      ctx.stroke();
      ctx.restore();
    }
  }, [
    displayCandles,
    activeViewport,
    priceScale,
    timeframe,
    pipSize,
    lastPrice,
    symbolId,
    crosshairPos,
    swingsMap,
    breaksMap,
  ]);

  // Handle Mouse Hover for Crosshair and Tooltip
  const updateHover = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || totalCandles === 0) return;

    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    setCrosshairPos({ x, y });

    const chartWidth = rect.width - CHART_MARGIN.left - CHART_MARGIN.right;
    const index = xToIndex(activeViewport, x, CHART_MARGIN.left, chartWidth, totalCandles);
    setHoveredCandle(index === null ? null : displayCandles[index]);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current) return;
    updateHover(e.clientX, e.clientY);
  };

  const handleMouseLeave = () => {
    if (isDraggingRef.current) return;
    setCrosshairPos(null);
    setHoveredCandle(null);
  };

  // Pointer drag pans the viewport. Panning is relative to the position at
  // drag start so it never accumulates rounding drift.
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || totalCandles === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, x: e.clientX, start: activeViewport.start };
    isDraggingRef.current = true;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const chartWidth = rect.width - CHART_MARGIN.left - CHART_MARGIN.right;
    if (chartWidth <= 0) return;

    const slotWidth = chartWidth / activeViewport.count;
    const deltaCandles = -(e.clientX - drag.x) / slotWidth;
    setViewport((prev) =>
      panViewport({ ...prev, start: drag.start, following: false }, deltaCandles, totalRef.current)
    );
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    isDraggingRef.current = false;
  };

  // Zoom / pan controls
  const handleZoomIn = () => setViewport((prev) => zoomViewport(prev, 1 / 1.3, totalRef.current));
  const handleZoomOut = () => setViewport((prev) => zoomViewport(prev, 1.3, totalRef.current));
  const handleResetView = () => {
    setViewport(resetViewport(totalRef.current));
    setPriceScale(DEFAULT_PRICE_SCALE);
  };
  const handleResumeLive = () => setViewport((prev) => resumeLive(prev, totalRef.current));
  const handlePriceScale = (multiplier: number) =>
    setPriceScale((prev) => clampPriceScale(prev * multiplier));

  const canZoomOut = activeViewport.count < clampCount(totalCandles || 1);
  const canZoomIn = activeViewport.count > MIN_VISIBLE_CANDLES;

  const latestCandle = displayCandles[displayCandles.length - 1];
  const activeTooltip = hoveredCandle || latestCandle;

  return (
    <div className="panel chart-panel">
      <div className="panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div className="panel-title">
            <span>CHART</span>
            <span style={{ color: '#fff' }}>{symbolId}</span>
            <span style={{ color: '#38bdf8', fontSize: '11px', fontWeight: 600 }}>
              [{timeframe.toUpperCase()}]
            </span>
          </div>
          <div className="timeframe-selector">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                id={`btn-timeframe-${tf}`}
                className={`tf-btn ${timeframe === tf ? 'active' : ''}`}
                onClick={() => onTimeframeChange(tf)}
              >
                {tf.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="chart-header-right">
          {activeTooltip && (
            <div
              className="mono"
              style={{
                display: 'flex',
                gap: '12px',
                fontSize: '11px',
                color: '#94a3b8',
              }}
            >
              <span>
                O: <strong style={{ color: '#fff' }}>{activeTooltip.open.toFixed(pipSize)}</strong>
              </span>
              <span>
                H: <strong style={{ color: '#10b981' }}>{activeTooltip.high.toFixed(pipSize)}</strong>
              </span>
              <span>
                L: <strong style={{ color: '#f43f5e' }}>{activeTooltip.low.toFixed(pipSize)}</strong>
              </span>
              <span>
                C: <strong style={{ color: '#fff' }}>{activeTooltip.close.toFixed(pipSize)}</strong>
              </span>
              <span>
                Ticks: <strong style={{ color: '#38bdf8' }}>{activeTooltip.volume}</strong>
              </span>
            </div>
          )}

          <div className="chart-controls" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span
              className={`chart-live-badge ${summary.following ? 'is-live' : 'is-historical'}`}
              title={
                summary.following
                  ? 'Showing the latest candle'
                  : `Showing ${summary.count} candles${summary.candlesBehind > 0 ? `, ${summary.candlesBehind} behind the latest` : ''}`
              }
            >
              {summary.following
                ? 'LIVE'
                : `HISTORICAL${summary.candlesBehind > 0 ? ` · ${summary.candlesBehind} BACK` : ''}`}
            </span>

            <button
              className="tf-btn"
              onClick={handleZoomIn}
              disabled={!canZoomIn}
              title="Zoom in (wheel)"
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              className="tf-btn"
              onClick={handleZoomOut}
              disabled={!canZoomOut}
              title="Zoom out (wheel)"
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              className="tf-btn"
              onClick={handleResumeLive}
              title="Jump to the latest candle"
              aria-label="Jump to the latest candle"
            >
              »
            </button>
            <button
              className="tf-btn"
              onClick={handleResetView}
              title="Reset zoom and pan"
              aria-label="Reset zoom and pan"
            >
              RST
            </button>

            <span style={{ width: 1, height: 16, background: 'var(--border-color)' }} />

            <button
              className="tf-btn"
              onClick={() => handlePriceScale(1 / 1.3)}
              title="Zoom price scale in"
              aria-label="Zoom price scale in"
            >
              ⇕+
            </button>
            <button
              className="tf-btn"
              onClick={() => handlePriceScale(1.3)}
              title="Zoom price scale out"
              aria-label="Zoom price scale out"
            >
              ⇕−
            </button>
          </div>
        </div>
      </div>

      <div className="chart-wrapper" ref={containerRef}>
        <canvas
          ref={canvasRef}
          className="chart-canvas"
          style={{ touchAction: 'none', cursor: 'grab' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>
    </div>
  );
}
