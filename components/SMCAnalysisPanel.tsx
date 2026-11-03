'use client';

import React, { useState } from 'react';
import { SMCAnalysisResult } from '@/lib/analysis/smc';
import { getSymbolConfig } from '@/lib/deriv/symbols';
import {
  DEFAULT_LIST_LIMIT,
  absoluteDistance,
  capList,
  clamp01,
  collectionStateLabel,
  computeDealingRange,
  countByState,
  distanceToZone,
  findNearestByPrice,
  formatCountSummary,
  formatPips,
  formatPrice,
  formatTimestamp,
  fvgState,
  liquidityLevelState,
  objectStateLabel,
  orderBlockState,
  rangePosition,
  resolveCollectionState,
  type CollectionState,
} from '@/lib/ui/smc-view';

interface SMCAnalysisPanelProps {
  data?: SMCAnalysisResult | null;
  /** Close of the last closed candle; matches the analysis engine's premium/discount price. */
  referencePrice?: number | null;
}

function badgeClass(label: string): string {
  return `smc-badge ${label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

interface SectionProps {
  id: string;
  title: string;
  meta?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function Section({ id, title, meta, defaultOpen = false, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const headerId = `${id}-header`;
  const bodyId = `${id}-body`;

  return (
    <div className="smc-section">
      <h3 className="smc-section-heading">
        <button
          id={headerId}
          type="button"
          className="smc-section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((prev) => !prev)}
        >
          <span className="smc-chevron" aria-hidden="true">
            {open ? '\u25be' : '\u25b8'}
          </span>
          <span className="smc-section-title">{title}</span>
          {meta !== undefined && <span className="smc-section-meta">{meta}</span>}
        </button>
      </h3>
      <div
        id={bodyId}
        role="region"
        aria-labelledby={headerId}
        hidden={!open}
        className="smc-section-body"
      >
        {open ? children : null}
      </div>
    </div>
  );
}

interface DetailRowProps {
  primary: string;
  state?: string;
  fields: Array<[string, string]>;
}

function DetailRow({ primary, state, fields }: DetailRowProps) {
  return (
    <div className="smc-row">
      <div className="smc-row-top">
        <span className="smc-row-primary mono">{primary}</span>
        {state && <span className={badgeClass(state)}>{state}</span>}
      </div>
      {fields.length > 0 && (
        <div className="smc-row-fields mono">
          {fields.map(([key, value]) => (
            <span className="smc-row-field" key={key}>
              <span className="smc-row-key">{key}</span>
              <span className="smc-row-value">{value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface MetricProps {
  label: string;
  value: string;
  waiting?: boolean;
}

function Metric({ label, value, waiting = false }: MetricProps) {
  return (
    <div className="metric-item">
      <div className="metric-label">{label}</div>
      <div className={`metric-val ${waiting ? 'waiting' : ''}`}>{value}</div>
    </div>
  );
}

function collectionValue(state: CollectionState, count: number): string {
  if (state === 'WAITING FOR DATA') return 'WAITING FOR DATA';
  if (state === 'NONE_DETECTED') return 'None detected';
  return `${count}`;
}

export function SMCAnalysisPanel({ data, referencePrice = null }: SMCAnalysisPanelProps) {
  const symbol = data?.symbol ?? null;
  const timeframe = data?.timeframe ? data.timeframe.toUpperCase() : '—';
  const symbolConfig = symbol ? getSymbolConfig(symbol) : undefined;
  const decimals = symbolConfig?.pipSize ?? 5;

  const zone = data?.zone ?? 'WAITING FOR DATA';
  const ref = referencePrice ?? null;
  const refLabel = formatPrice(ref, decimals);

  const liquidity = data?.liquidity;
  const buyLevels = liquidity?.buySideLiquidity ?? [];
  const sellLevels = liquidity?.sellSideLiquidity ?? [];
  const equalHighs = liquidity?.equalHighs ?? [];
  const equalLows = liquidity?.equalLows ?? [];

  const liquidityStatus = liquidity?.status;
  const buyState = resolveCollectionState(liquidityStatus, buyLevels.length);
  const sellState = resolveCollectionState(liquidityStatus, sellLevels.length);
  const eqhState = resolveCollectionState(liquidityStatus, equalHighs.length);
  const eqlState = resolveCollectionState(liquidityStatus, equalLows.length);

  const fvg = data?.fvg;
  const bullishFVGs = fvg?.bullishFVGs ?? [];
  const bearishFVGs = fvg?.bearishFVGs ?? [];
  const fvgStatus = fvg?.status;
  const bullishFvgState = resolveCollectionState(fvgStatus, bullishFVGs.length);
  const bearishFvgState = resolveCollectionState(fvgStatus, bearishFVGs.length);
  const fvgCounts = countByState([...bullishFVGs, ...bearishFVGs], fvgState);

  const orderBlocks = data?.orderBlocks;
  const bullishOBs = orderBlocks?.bullishOrderBlocks ?? [];
  const bearishOBs = orderBlocks?.bearishOrderBlocks ?? [];
  const obStatus = orderBlocks?.status;
  const bullishOBState = resolveCollectionState(obStatus, bullishOBs.length);
  const bearishOBState = resolveCollectionState(obStatus, bearishOBs.length);
  const obCounts = countByState([...bullishOBs, ...bearishOBs], orderBlockState);

  const latestHigh = data?.marketStructure?.latestSwingHigh?.price ?? null;
  const latestLow = data?.marketStructure?.latestSwingLow?.price ?? null;
  const dealingRange = computeDealingRange(latestHigh, latestLow);
  const position = dealingRange ? rangePosition(ref, dealingRange) : null;

  const nearestBuy = findNearestByPrice(buyLevels, ref, (level) => level.price);
  const nearestSell = findNearestByPrice(sellLevels, ref, (level) => level.price);
  const nearestFvg = findNearestByPrice(
    [...bullishFVGs, ...bearishFVGs],
    ref,
    (gap) => (gap.topPrice + gap.bottomPrice) / 2
  );
  const nearestOB = findNearestByPrice(
    [...bullishOBs, ...bearishOBs],
    ref,
    (block) => (block.high + block.low) / 2
  );

  const buyList = capList(buyLevels, DEFAULT_LIST_LIMIT);
  const sellList = capList(sellLevels, DEFAULT_LIST_LIMIT);
  const eqhList = capList(equalHighs, DEFAULT_LIST_LIMIT);
  const eqlList = capList(equalLows, DEFAULT_LIST_LIMIT);
  const bullishFvgList = capList(bullishFVGs, DEFAULT_LIST_LIMIT);
  const bearishFvgList = capList(bearishFVGs, DEFAULT_LIST_LIMIT);
  const bullishOBList = capList(bullishOBs, DEFAULT_LIST_LIMIT);
  const bearishOBList = capList(bearishOBs, DEFAULT_LIST_LIMIT);

  const liquidityMeta = `${buyLevels.length} buy / ${sellLevels.length} sell`;

  return (
    <div className="panel smc-panel" style={{ flex: 1 }}>
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
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
          </svg>
          <span>SMC ANALYSIS</span>
        </div>
        <span className="smc-panel-meta mono">
          {symbol ?? '—'} [{timeframe}] · ref {refLabel}
        </span>
      </div>

      <div className="panel-body smc-workspace">
        {/* Premium / Discount */}
        <Section
          id="smc-zone"
          title="Premium / Discount"
          meta={zone}
          defaultOpen
        >
          <div className="metric-grid">
            <Metric
              label="Zone"
              value={zone}
              waiting={zone === 'WAITING FOR DATA'}
            />
            <Metric
              label="Equilibrium"
              value={dealingRange ? formatPrice(dealingRange.midpoint, decimals) : '—'}
              waiting={!dealingRange}
            />
            <Metric
              label="Range High"
              value={dealingRange ? formatPrice(dealingRange.high, decimals) : '—'}
              waiting={!dealingRange}
            />
            <Metric
              label="Range Low"
              value={dealingRange ? formatPrice(dealingRange.low, decimals) : '—'}
              waiting={!dealingRange}
            />
          </div>

          {dealingRange && position !== null ? (
            <div className="smc-range">
              <div className="smc-range-track" aria-hidden="true">
                <div className="smc-range-band" />
                <div
                  className="smc-range-marker"
                  style={{ left: `${clamp01(position) * 100}%` }}
                />
              </div>
              <div className="smc-range-labels mono">
                <span>{formatPrice(dealingRange.low, decimals)}</span>
                <span className="smc-range-equilibrium">EQ</span>
                <span>{formatPrice(dealingRange.high, decimals)}</span>
              </div>
            </div>
          ) : (
            <div className="smc-empty">Dealing range unavailable.</div>
          )}
        </Section>

        {/* Liquidity */}
        <Section
          id="smc-liquidity"
          title="Liquidity"
          meta={liquidityStatus === 'WAITING FOR DATA' ? 'WAITING FOR DATA' : liquidityMeta}
        >
          <div className="metric-grid">
            <Metric
              label="Buy-Side"
              value={collectionValue(buyState, buyLevels.length)}
              waiting={buyState !== 'ACTIVE'}
            />
            <Metric
              label="Sell-Side"
              value={collectionValue(sellState, sellLevels.length)}
              waiting={sellState !== 'ACTIVE'}
            />
            <Metric
              label="Equal Highs"
              value={collectionValue(eqhState, equalHighs.length)}
              waiting={eqhState !== 'ACTIVE'}
            />
            <Metric
              label="Equal Lows"
              value={collectionValue(eqlState, equalLows.length)}
              waiting={eqlState !== 'ACTIVE'}
            />
          </div>

          {(nearestBuy || nearestSell) && (
            <div className="smc-nearest">
              <div className="smc-subtitle">Nearest to reference</div>
              {nearestBuy && (
                <div className="smc-nearest-line mono">
                  <span>Buy {formatPrice(nearestBuy.price, decimals)}</span>
                  <span>{formatPips(absoluteDistance(ref, nearestBuy.price), symbol ?? '')}</span>
                </div>
              )}
              {nearestSell && (
                <div className="smc-nearest-line mono">
                  <span>Sell {formatPrice(nearestSell.price, decimals)}</span>
                  <span>{formatPips(absoluteDistance(ref, nearestSell.price), symbol ?? '')}</span>
                </div>
              )}
            </div>
          )}

          <div className="smc-list-block">
            <div className="smc-subtitle">
              Buy-Side Levels <span className="smc-subtitle-count">{formatCountSummary(buyList.items.length, buyList.total)}</span>
            </div>
            {buyList.items.length === 0 ? (
              <div className="smc-empty">
                {collectionStateLabel(buyState) === 'WAITING FOR DATA'
                  ? 'WAITING FOR DATA'
                  : 'None detected'}
              </div>
            ) : (
              buyList.items.map((level) => (
                <DetailRow
                  key={level.id}
                  primary={`@ ${formatPrice(level.price, decimals)}`}
                  state={objectStateLabel(liquidityLevelState(level))}
                  fields={[
                    ['dist', formatPips(absoluteDistance(ref, level.price), symbol ?? '')],
                    ['created', formatTimestamp(level.epoch)],
                    ...(level.swept
                      ? ([['swept', formatTimestamp(level.sweptEpoch)]] as Array<[string, string]>)
                      : []),
                  ]}
                />
              ))
            )}
            {buyList.hidden > 0 && (
              <div className="smc-list-more">
                Showing {buyList.items.length} of {buyList.total}
              </div>
            )}
          </div>

          <div className="smc-list-block">
            <div className="smc-subtitle">
              Sell-Side Levels <span className="smc-subtitle-count">{formatCountSummary(sellList.items.length, sellList.total)}</span>
            </div>
            {sellList.items.length === 0 ? (
              <div className="smc-empty">
                {collectionStateLabel(sellState) === 'WAITING FOR DATA'
                  ? 'WAITING FOR DATA'
                  : 'None detected'}
              </div>
            ) : (
              sellList.items.map((level) => (
                <DetailRow
                  key={level.id}
                  primary={`@ ${formatPrice(level.price, decimals)}`}
                  state={objectStateLabel(liquidityLevelState(level))}
                  fields={[
                    ['dist', formatPips(absoluteDistance(ref, level.price), symbol ?? '')],
                    ['created', formatTimestamp(level.epoch)],
                    ...(level.swept
                      ? ([['swept', formatTimestamp(level.sweptEpoch)]] as Array<[string, string]>)
                      : []),
                  ]}
                />
              ))
            )}
            {sellList.hidden > 0 && (
              <div className="smc-list-more">
                Showing {sellList.items.length} of {sellList.total}
              </div>
            )}
          </div>

          <div className="smc-list-block">
            <div className="smc-subtitle">
              Equal Highs / Lows <span className="smc-subtitle-count">{formatCountSummary(eqhList.items.length + eqlList.items.length, eqhList.total + eqlList.total)}</span>
            </div>
            {equalHighs.length === 0 && equalLows.length === 0 ? (
              <div className="smc-empty">
                {collectionStateLabel(eqhState) === 'WAITING FOR DATA'
                  ? 'WAITING FOR DATA'
                  : 'None detected'}
              </div>
            ) : (
              [...eqhList.items, ...eqlList.items].map((cluster) => (
                <DetailRow
                  key={cluster.id}
                  primary={`${cluster.type} @ ${formatPrice(cluster.price, decimals)}`}
                  fields={[
                    ['count', `${cluster.count}`],
                    [
                      'tolerance',
                      cluster.tolerancePips !== undefined
                        ? `${cluster.tolerancePips.toFixed(1)} pips`
                        : '—',
                    ],
                    ['updated', formatTimestamp(cluster.epoch)],
                  ]}
                />
              ))
            )}
            {eqhList.hidden + eqlList.hidden > 0 && (
              <div className="smc-list-more">
                Showing {eqhList.items.length + eqlList.items.length} of{' '}
                {eqhList.total + eqlList.total}
              </div>
            )}
          </div>
        </Section>

        {/* Fair Value Gaps */}
        <Section
          id="smc-fvg"
          title="Imbalances"
          meta={fvgStatus === 'WAITING FOR DATA' ? 'WAITING FOR DATA' : `${fvgCounts.MITIGATED}/${bullishFVGs.length + bearishFVGs.length} mitigated`}
        >
          <div className="metric-grid">
            <Metric
              label="Bullish FVG"
              value={collectionValue(bullishFvgState, bullishFVGs.length)}
              waiting={bullishFvgState !== 'ACTIVE'}
            />
            <Metric
              label="Bearish FVG"
              value={collectionValue(bearishFvgState, bearishFVGs.length)}
              waiting={bearishFvgState !== 'ACTIVE'}
            />
            <Metric
              label="Unmitigated"
              value={fvgStatus === 'WAITING FOR DATA' ? 'WAITING FOR DATA' : `${fvg?.unmitigatedCount ?? 0}`}
              waiting={fvgStatus === 'WAITING FOR DATA'}
            />
            <Metric
              label="Nearest Gap"
              value={
                nearestFvg ? formatPips(absoluteDistance(ref, (nearestFvg.topPrice + nearestFvg.bottomPrice) / 2), symbol ?? '') : '—'
              }
              waiting={!nearestFvg}
            />
          </div>

          <div className="smc-list-block">
            <div className="smc-subtitle">
              Bullish FVG <span className="smc-subtitle-count">{formatCountSummary(bullishFvgList.items.length, bullishFvgList.total)}</span>
            </div>
            {bullishFvgList.items.length === 0 ? (
              <div className="smc-empty">
                {collectionStateLabel(bullishFvgState) === 'WAITING FOR DATA' ? 'WAITING FOR DATA' : 'None detected'}
              </div>
            ) : (
              bullishFvgList.items.map((gap) => (
                <DetailRow
                  key={gap.id}
                  primary={`${formatPrice(gap.bottomPrice, decimals)} – ${formatPrice(gap.topPrice, decimals)}`}
                  state={objectStateLabel(fvgState(gap))}
                  fields={[
                    ['dist', formatPips(distanceToZone(ref, gap.bottomPrice, gap.topPrice), symbol ?? '')],
                    ['epoch', formatTimestamp(gap.epoch)],
                    ...(gap.mitigated
                      ? ([['mitigated', formatTimestamp(gap.mitigationEpoch)]] as Array<[string, string]>)
                      : []),
                  ]}
                />
              ))
            )}
            {bullishFvgList.hidden > 0 && (
              <div className="smc-list-more">
                Showing {bullishFvgList.items.length} of {bullishFvgList.total}
              </div>
            )}
          </div>

          <div className="smc-list-block">
            <div className="smc-subtitle">
              Bearish FVG <span className="smc-subtitle-count">{formatCountSummary(bearishFvgList.items.length, bearishFvgList.total)}</span>
            </div>
            {bearishFvgList.items.length === 0 ? (
              <div className="smc-empty">
                {collectionStateLabel(bearishFvgState) === 'WAITING FOR DATA' ? 'WAITING FOR DATA' : 'None detected'}
              </div>
            ) : (
              bearishFvgList.items.map((gap) => (
                <DetailRow
                  key={gap.id}
                  primary={`${formatPrice(gap.bottomPrice, decimals)} – ${formatPrice(gap.topPrice, decimals)}`}
                  state={objectStateLabel(fvgState(gap))}
                  fields={[
                    ['dist', formatPips(distanceToZone(ref, gap.bottomPrice, gap.topPrice), symbol ?? '')],
                    ['epoch', formatTimestamp(gap.epoch)],
                    ...(gap.mitigated
                      ? ([['mitigated', formatTimestamp(gap.mitigationEpoch)]] as Array<[string, string]>)
                      : []),
                  ]}
                />
              ))
            )}
            {bearishFvgList.hidden > 0 && (
              <div className="smc-list-more">
                Showing {bearishFvgList.items.length} of {bearishFvgList.total}
              </div>
            )}
          </div>
        </Section>

        {/* Order Blocks */}
        <Section
          id="smc-orderblocks"
          title="Order Blocks"
          meta={obStatus === 'WAITING FOR DATA' ? 'WAITING FOR DATA' : `${obCounts.ACTIVE} active`}
        >
          <div className="metric-grid">
            <Metric
              label="Bullish OB"
              value={collectionValue(bullishOBState, bullishOBs.length)}
              waiting={bullishOBState !== 'ACTIVE'}
            />
            <Metric
              label="Bearish OB"
              value={collectionValue(bearishOBState, bearishOBs.length)}
              waiting={bearishOBState !== 'ACTIVE'}
            />
            <Metric
              label="Invalidated"
              value={obStatus === 'WAITING FOR DATA' ? 'WAITING FOR DATA' : `${obCounts.INVALIDATED}`}
              waiting={obStatus === 'WAITING FOR DATA'}
            />
            <Metric
              label="Nearest Block"
              value={
                nearestOB ? formatPips(absoluteDistance(ref, (nearestOB.high + nearestOB.low) / 2), symbol ?? '') : '—'
              }
              waiting={!nearestOB}
            />
          </div>

          <div className="smc-list-block">
            <div className="smc-subtitle">
              Bullish OB <span className="smc-subtitle-count">{formatCountSummary(bullishOBList.items.length, bullishOBList.total)}</span>
            </div>
            {bullishOBList.items.length === 0 ? (
              <div className="smc-empty">
                {collectionStateLabel(bullishOBState) === 'WAITING FOR DATA' ? 'WAITING FOR DATA' : 'None detected'}
              </div>
            ) : (
              bullishOBList.items.map((block) => (
                <DetailRow
                  key={block.id}
                  primary={`${formatPrice(block.low, decimals)} – ${formatPrice(block.high, decimals)}`}
                  state={objectStateLabel(orderBlockState(block))}
                  fields={[
                    ['dist', formatPips(distanceToZone(ref, block.low, block.high), symbol ?? '')],
                    [
                      'refined',
                      block.refinedPips !== undefined ? `${block.refinedPips.toFixed(1)} pips` : '—',
                    ],
                    ['epoch', formatTimestamp(block.epoch)],
                    ...(block.mitigated
                      ? ([['mitigated', formatTimestamp(block.mitigationEpoch)]] as Array<[string, string]>)
                      : []),
                    ...(block.invalidated
                      ? ([['invalidated', formatTimestamp(block.invalidatedEpoch)]] as Array<[string, string]>)
                      : []),
                  ]}
                />
              ))
            )}
            {bullishOBList.hidden > 0 && (
              <div className="smc-list-more">
                Showing {bullishOBList.items.length} of {bullishOBList.total}
              </div>
            )}
          </div>

          <div className="smc-list-block">
            <div className="smc-subtitle">
              Bearish OB <span className="smc-subtitle-count">{formatCountSummary(bearishOBList.items.length, bearishOBList.total)}</span>
            </div>
            {bearishOBList.items.length === 0 ? (
              <div className="smc-empty">
                {collectionStateLabel(bearishOBState) === 'WAITING FOR DATA' ? 'WAITING FOR DATA' : 'None detected'}
              </div>
            ) : (
              bearishOBList.items.map((block) => (
                <DetailRow
                  key={block.id}
                  primary={`${formatPrice(block.low, decimals)} – ${formatPrice(block.high, decimals)}`}
                  state={objectStateLabel(orderBlockState(block))}
                  fields={[
                    ['dist', formatPips(distanceToZone(ref, block.low, block.high), symbol ?? '')],
                    [
                      'refined',
                      block.refinedPips !== undefined ? `${block.refinedPips.toFixed(1)} pips` : '—',
                    ],
                    ['epoch', formatTimestamp(block.epoch)],
                    ...(block.mitigated
                      ? ([['mitigated', formatTimestamp(block.mitigationEpoch)]] as Array<[string, string]>)
                      : []),
                    ...(block.invalidated
                      ? ([['invalidated', formatTimestamp(block.invalidatedEpoch)]] as Array<[string, string]>)
                      : []),
                  ]}
                />
              ))
            )}
            {bearishOBList.hidden > 0 && (
              <div className="smc-list-more">
                Showing {bearishOBList.items.length} of {bearishOBList.total}
              </div>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}
