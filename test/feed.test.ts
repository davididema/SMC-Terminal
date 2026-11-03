import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTick,
  classifySubscriptionError,
  deriveFeedState,
  feedStateLabel,
  symbolFromSubscriptionError,
} from '../lib/deriv/feed';

test('parseTick accepts a valid synthetic tick and maps the symbol ID', () => {
  const tick = parseTick({
    symbol: 'R_75',
    quote: '1234.56',
    epoch: 1700000000,
    pip_size: '0.01',
    bid: '1234.55',
    ask: '1234.57',
  });
  assert.ok(tick);
  assert.equal(tick.symbol, 'V75');
  assert.equal(tick.derivSymbol, 'R_75');
  assert.equal(tick.price, 1234.56);
  assert.equal(tick.epoch, 1700000000);
  assert.equal(tick.pipSize, 0.01);
  assert.equal(tick.bid, 1234.55);
  assert.equal(tick.ask, 1234.57);
});

test('parseTick maps a valid forex tick to its internal symbol', () => {
  const tick = parseTick({ symbol: 'frxEURUSD', quote: 1.09345, epoch: 1700000060 });
  assert.ok(tick);
  assert.equal(tick.symbol, 'EURUSD');
  assert.equal(tick.price, 1.09345);
  assert.equal(tick.bid, undefined);
  assert.equal(tick.ask, undefined);
});

test('parseTick rejects malformed or non-finite payloads without fabricating a price', () => {
  const invalid: unknown[] = [
    null,
    undefined,
    42,
    'tick',
    {},
    { symbol: 'R_75' },
    { symbol: '', quote: 1, epoch: 1 },
    { symbol: 'R_75', quote: 'abc', epoch: 1 },
    { symbol: 'R_75', quote: 0, epoch: 1 },
    { symbol: 'R_75', quote: -5, epoch: 1 },
    { symbol: 'R_75', quote: Infinity, epoch: 1 },
    { symbol: 'R_75', quote: 1, epoch: 0 },
    { symbol: 'R_75', quote: 1, epoch: -1 },
    { symbol: 'R_75', quote: 1, epoch: 'soon' },
  ];
  for (const raw of invalid) {
    assert.equal(parseTick(raw), null, `expected ${JSON.stringify(raw)} to be rejected`);
  }
});

test('parseTick falls back to the raw deriv symbol when unknown', () => {
  const tick = parseTick({ symbol: 'frxZZZ', quote: 1, epoch: 1 });
  assert.ok(tick);
  assert.equal(tick.symbol, 'frxZZZ');
});

test('parseTick drops non-finite bid/ask rather than emitting NaN', () => {
  const tick = parseTick({ symbol: 'R_10', quote: 1, epoch: 1, bid: 'x', ask: null });
  assert.ok(tick);
  assert.equal(tick.bid, undefined);
  assert.equal(tick.ask, undefined);
});

test('classifySubscriptionError distinguishes a closed market from an invalid symbol', () => {
  assert.equal(classifySubscriptionError('MarketIsClosed'), 'CLOSED');
  assert.equal(classifySubscriptionError('UnknownSymbol'), 'UNAVAILABLE');
  assert.equal(classifySubscriptionError('InvalidSymbol'), 'UNAVAILABLE');
  assert.equal(classifySubscriptionError(null), 'UNAVAILABLE');
  assert.equal(classifySubscriptionError(undefined), 'UNAVAILABLE');
});

test('deriveFeedState requires an actual tick before reporting LIVE', () => {
  assert.equal(deriveFeedState({ hasTick: false, isStale: false }), 'PENDING');
  assert.equal(deriveFeedState({ hasTick: false, isStale: true }), 'PENDING');
  assert.equal(deriveFeedState({ hasTick: true, isStale: false }), 'LIVE');
  assert.equal(deriveFeedState({ hasTick: true, isStale: true }), 'STALE');
});

test('deriveFeedState lets a subscription error override any tick history', () => {
  assert.equal(
    deriveFeedState({ hasTick: true, isStale: false, errorCode: 'MarketIsClosed' }),
    'CLOSED'
  );
  assert.equal(
    deriveFeedState({ hasTick: false, isStale: false, errorCode: 'UnknownSymbol' }),
    'UNAVAILABLE'
  );
});

test('feedStateLabel maps every state to a human label', () => {
  assert.equal(feedStateLabel('LIVE'), 'Live');
  assert.equal(feedStateLabel('STALE'), 'Stalled');
  assert.equal(feedStateLabel('PENDING'), 'Waiting');
  assert.equal(feedStateLabel('CLOSED'), 'Market closed');
  assert.equal(feedStateLabel('UNAVAILABLE'), 'Unavailable');
  assert.equal(feedStateLabel('IDLE'), 'Idle');
});

test('symbolFromSubscriptionError resolves tick subscriptions only', () => {
  assert.deepEqual(symbolFromSubscriptionError({ ticks: 'frxEURUSD' }), {
    symbol: 'EURUSD',
    isTickSubscription: true,
  });
  assert.deepEqual(symbolFromSubscriptionError({ ticks: 'R_75' }), {
    symbol: 'V75',
    isTickSubscription: true,
  });
  assert.equal(symbolFromSubscriptionError({ ticks_history: 'frxEURUSD' }), null);
  assert.equal(symbolFromSubscriptionError({}), null);
  assert.equal(symbolFromSubscriptionError(null), null);
});
