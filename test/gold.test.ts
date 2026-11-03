import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_SYMBOLS,
  getSymbolConfig,
  getSymbolIdFromDerivSymbol,
  getPipValue,
  getTickSize,
} from '../lib/deriv/symbols';
import { parseTick } from '../lib/deriv/feed';
import {
  classifySubscriptionError,
  deriveFeedState,
  symbolFromSubscriptionError,
} from '../lib/deriv/feed';
import {
  CandleManager,
  Candle,
  TickData,
  TIMEFRAMES,
  TIMEFRAME_SECONDS,
} from '../lib/deriv/candles';
import { getSymbolEqualityTolerance } from '../lib/analysis/market-structure';
import { SMCEngine } from '../lib/analysis/smc';
import { formatPips } from '../lib/ui/smc-view';

const GOLD = 'XAUUSD';
const GOLD_DERIV = 'frxXAUUSD';

function goldTick(price: number, epoch: number): TickData {
  return { symbol: GOLD, derivSymbol: GOLD_DERIV, price, epoch, pipSize: 2 };
}

// --- Registration & metadata -------------------------------------------------

test('Gold is registered with the verified Deriv symbol and metal metadata', () => {
  const config = getSymbolConfig(GOLD);
  assert.ok(config, 'XAUUSD must be registered');
  assert.equal(config!.derivSymbol, GOLD_DERIV);
  assert.equal(config!.displayName, 'XAU/USD');
  assert.equal(config!.category, 'Metals');
  assert.equal(config!.pipSize, 2);
  assert.equal(config!.market, 'commodities');
  assert.equal(config!.submarket, 'metals');
  assert.equal(config!.derivPipSize, 0.01);
});

test('Gold is registered exactly once and maps both directions', () => {
  assert.equal(SUPPORTED_SYMBOLS.filter((s) => s.id === GOLD).length, 1);
  assert.equal(SUPPORTED_SYMBOLS.filter((s) => s.derivSymbol === GOLD_DERIV).length, 1);
  assert.equal(getSymbolIdFromDerivSymbol(GOLD_DERIV), GOLD);
  // A different metal symbol is not silently aliased to Gold.
  assert.equal(getSymbolIdFromDerivSymbol('frxXAGUSD'), undefined);
});

test('Gold uses metal-appropriate tick/pip scaling rather than forex conventions', () => {
  assert.equal(getTickSize(GOLD), 0.01);
  assert.equal(getPipValue(GOLD), 0.1);
  // Distinct from a forex major, proving the scaling is instrument-aware.
  assert.equal(getTickSize('EURUSD'), 0.00001);
  assert.equal(getPipValue('EURUSD'), 0.0001);
  assert.equal(formatPips(1.0, GOLD), '10.0 pips');
  assert.equal(formatPips(0.2, GOLD), '2.0 pips');
  assert.equal(formatPips(1.0, 'EURUSD'), '10000.0 pips');
});

test('Gold equality tolerance scales to gold price, not forex pips', () => {
  const price = 4194.51;
  const tolerance = getSymbolEqualityTolerance(GOLD, price);
  assert.ok(Math.abs(tolerance - Math.max(3 * 0.01, price * 0.00015)) < 1e-9);
  assert.ok(tolerance > 0.5, 'gold tolerance is on a dollar scale');
  assert.ok(getSymbolEqualityTolerance('EURUSD', 1.1) < 0.01, 'forex tolerance stays sub-pip');
});

// --- Tick parsing ------------------------------------------------------------

test('parseTick accepts a live-shaped Gold tick', () => {
  const tick = parseTick({
    symbol: GOLD_DERIV,
    quote: '4194.51',
    epoch: 1700000000,
    pip_size: '0.01',
    bid: '4194.50',
    ask: '4194.52',
  });
  assert.ok(tick);
  assert.equal(tick.symbol, GOLD);
  assert.equal(tick.derivSymbol, GOLD_DERIV);
  assert.equal(tick.price, 4194.51);
  assert.equal(tick.epoch, 1700000000);
  assert.equal(tick.pipSize, 0.01);
  assert.equal(tick.bid, 4194.5);
  assert.equal(tick.ask, 4194.52);
});

test('parseTick rejects invalid Gold ticks instead of fabricating a price', () => {
  const invalid: unknown[] = [
    { symbol: GOLD_DERIV, quote: 0, epoch: 1 },
    { symbol: GOLD_DERIV, quote: -4194, epoch: 1 },
    { symbol: GOLD_DERIV, quote: 'cheese', epoch: 1 },
    { symbol: GOLD_DERIV, quote: Infinity, epoch: 1 },
    { symbol: GOLD_DERIV, quote: NaN, epoch: 1 },
    { symbol: GOLD_DERIV, quote: 4194, epoch: 0 },
    { symbol: GOLD_DERIV, quote: 4194, epoch: -5 },
    { symbol: '', quote: 4194, epoch: 1 },
  ];
  for (const raw of invalid) {
    assert.equal(parseTick(raw), null, `expected ${JSON.stringify(raw)} to be rejected`);
  }
});

// --- Feed status -------------------------------------------------------------

test('Gold subscription errors resolve to the internal symbol and closed state', () => {
  assert.deepEqual(symbolFromSubscriptionError({ ticks: GOLD_DERIV }), {
    symbol: GOLD,
    isTickSubscription: true,
  });
  assert.equal(classifySubscriptionError('MarketIsClosed'), 'CLOSED');
  assert.equal(
    deriveFeedState({ hasTick: false, isStale: false, errorCode: 'MarketIsClosed' }),
    'CLOSED'
  );
  assert.equal(deriveFeedState({ hasTick: true, isStale: false }), 'LIVE');
  assert.equal(deriveFeedState({ hasTick: true, isStale: true }), 'STALE');
});

// --- Candle generation across every timeframe --------------------------------

test('Gold ticks build candles on every supported timeframe', () => {
  const manager = new CandleManager(500);
  // Multiple of 86400, hence aligned to every timeframe boundary so each
  // candle periods at the exact tick epoch.
  const base = 1699920000;
  manager.processTick(goldTick(4194.0, base));
  manager.processTick(goldTick(4196.5, base + 1));
  manager.processTick(goldTick(4192.25, base + 2));

  for (const tf of TIMEFRAMES) {
    const current = manager.getCurrentCandle(GOLD, tf);
    assert.ok(current, `expected a forming Gold candle for ${tf}`);
    assert.equal(current!.epoch, base, `epoch aligned for ${tf}`);
    assert.equal(current!.open, 4194.0, `open for ${tf}`);
    assert.equal(current!.high, 4196.5, `high for ${tf}`);
    assert.equal(current!.low, 4192.25, `low for ${tf}`);
    assert.equal(current!.close, 4192.25, `close for ${tf}`);
    assert.equal(current!.volume, 3, `volume for ${tf}`);
  }
});

test('Gold history seeds and merges across every timeframe without duplicates', () => {
  const manager = new CandleManager(500);
  const base = 1700000000;
  for (const tf of TIMEFRAMES) {
    // The seeded epochs describe whole periods of THIS timeframe, exactly like
    // the history a provider delivers.
    const period = TIMEFRAME_SECONDS[tf];
    const first = Math.floor(base / period) * period;
    const second = first + period;
    manager.seedHistory(GOLD, tf, [
      { epoch: first, open: 4190, high: 4200, low: 4185, close: 4195 },
      { epoch: second, open: 4195, high: 4210, low: 4190, close: 4205 },
    ]);
    const history = manager.getHistory(GOLD, tf);
    assert.equal(history.length, 2, `history length for ${tf}`);
    assert.equal(history[0].epoch, first);
    assert.equal(history[1].epoch, second);
    assert.equal(history[1].close, 4205);

    // Re-seeding the same epochs must not duplicate candles.
    manager.seedHistory(GOLD, tf, [
      { epoch: first, open: 4190, high: 4200, low: 4185, close: 4195 },
      { epoch: second, open: 4195, high: 4210, low: 4190, close: 4205 },
    ]);
    assert.equal(manager.getHistory(GOLD, tf).length, 2, `dedup for ${tf}`);
  }
});

// --- SMC analysis over Gold candles ------------------------------------------

function goldCandles(): Candle[] {
  return [
    { epoch: 1000, open: 4180, high: 4195, low: 4170, close: 4190, volume: 10, isClosed: true },
    { epoch: 1060, open: 4190, high: 4205, low: 4180, close: 4200, volume: 10, isClosed: true },
    { epoch: 1120, open: 4200, high: 4230, low: 4195, close: 4225, volume: 10, isClosed: true },
    { epoch: 1180, open: 4225, high: 4220, low: 4190, close: 4200, volume: 10, isClosed: true },
    { epoch: 1240, open: 4200, high: 4205, low: 4175, close: 4180, volume: 10, isClosed: true },
    { epoch: 1300, open: 4180, high: 4260, low: 4178, close: 4255, volume: 10, isClosed: true },
  ];
}

test('SMC analysis runs on Gold candles and keeps Gold identity', () => {
  const engine = new SMCEngine();
  const result = engine.analyze(GOLD, '1m', goldCandles());
  assert.equal(result.symbol, GOLD);
  assert.equal(result.timeframe, '1m');
  assert.equal(result.marketStructure.symbol, GOLD);
  assert.equal(result.liquidity.symbol, GOLD);
  assert.ok(result.marketStructure.swings.length >= 1, 'gold swings detected');
  assert.ok(result.marketStructure.swings[0].id.startsWith(`${GOLD}:1m:`));
});

test('SMC Gold analysis is deterministic for unchanged closed candles', () => {
  const engine = new SMCEngine();
  const stable = (r: ReturnType<SMCEngine['analyze']>) =>
    JSON.stringify({ ...r, analyzedAt: 0 });
  const first = engine.analyze(GOLD, '1H', goldCandles());
  const second = engine.analyze(GOLD, '1H', goldCandles());
  assert.equal(stable(first), stable(second));
});

// --- Per-symbol isolation ----------------------------------------------------

test('Gold and forex candle state stay isolated with no cross-symbol leakage', () => {
  const manager = new CandleManager(500);
  const base = 1700000000;
  manager.processTick(goldTick(4194.0, base));
  manager.processTick({
    symbol: 'EURUSD',
    derivSymbol: 'frxEURUSD',
    price: 1.0934,
    epoch: base,
    pipSize: 5,
  });

  assert.equal(manager.getCurrentCandle(GOLD, '1m')!.close, 4194.0);
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')!.close, 1.0934);
  assert.equal(manager.getState(GOLD)!.tickCount, 1);
  assert.equal(manager.getState('EURUSD')!.tickCount, 1);

  // History seeded for Gold must not appear under the forex symbol. The seeded
  // epoch describes a CLOSED 5m period (the live tick still forms the current
  // one), so it belongs to the closed history.
  manager.seedHistory(GOLD, '5m', [
    {
      epoch: Math.floor(base / 300) * 300 - 300,
      open: 4190,
      high: 4200,
      low: 4185,
      close: 4195,
    },
  ]);
  assert.equal(manager.getHistory('EURUSD', '5m').length, 0);
  assert.equal(manager.getHistory(GOLD, '5m').length, 1);
});
