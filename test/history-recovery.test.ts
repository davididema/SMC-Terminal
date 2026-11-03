import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryRequestRegistry } from '../lib/deriv/history-requests';
import {
  createHistoryBookkeeping,
  markHistoryPending,
  applyHistoryOutcome,
  planHistoryLoad,
} from '../lib/deriv/history-init';

function candle(epoch: number) {
  return { epoch, open: 1, high: 1, low: 1, close: 1 };
}

// Test A — Disconnect during backfill: an in-flight request abandoned by a
// connection close is failed once with an empty result, the registry is
// drained, and the dashboard's pending marker is cleared without seeding.
test('A: a request abandoned by connection closure resolves once and clears pending', () => {
  const registry = new HistoryRequestRegistry();
  const bookkeeping = createHistoryBookkeeping();
  let calls = 0;

  markHistoryPending(bookkeeping, 'EURUSD', '5m');
  registry.add(1, {
    symbol: 'EURUSD',
    timeframe: '5m',
    generation: 1,
    callback: (symbol, timeframe, candles) => {
      calls += 1;
      assert.equal(symbol, 'EURUSD');
      assert.equal(timeframe, '5m');
      assert.equal(candles.length, 0);
      applyHistoryOutcome(bookkeeping, symbol, timeframe, candles.length);
    },
  });

  // Connection generation 1 closes while the request is still in flight.
  registry.failGeneration(1);

  assert.equal(calls, 1, 'callback invoked exactly once');
  assert.equal(registry.size(), 0, 'registry drained after failure');
  assert.equal(bookkeeping.pending.has('EURUSD:5m'), false, 'pending marker cleared');
  assert.equal(bookkeeping.seeded.has('EURUSD:5m'), false, 'failure must not seed the pair');
});

// Test B — Retry after disconnect: once the abandoned request's pending marker
// is cleared, the pair is retryable rather than blocked as skip-pending.
test('B: an abandoned request is retryable instead of returning skip-pending', () => {
  const registry = new HistoryRequestRegistry();
  const bookkeeping = createHistoryBookkeeping();
  markHistoryPending(bookkeeping, 'EURUSD', '5m');

  assert.equal(
    planHistoryLoad('EURUSD', '5m', bookkeeping.seeded, bookkeeping.pending, true),
    'skip-pending'
  );

  registry.add(1, {
    symbol: 'EURUSD',
    timeframe: '5m',
    generation: 1,
    callback: (symbol, timeframe, candles) =>
      applyHistoryOutcome(bookkeeping, symbol, timeframe, candles.length),
  });

  registry.failGeneration(1);

  assert.equal(
    planHistoryLoad('EURUSD', '5m', bookkeeping.seeded, bookkeeping.pending, true),
    'request',
    'a later attempt must be permitted after the abandoned request fails'
  );
});

// Test C — Old request versus new request: failing a stale connection's
// generation must not resolve or remove a newer request for the same pair, and
// a response is applied at most once.
test('C: failing an old generation cannot resolve a newer request for the same pair', () => {
  const registry = new HistoryRequestRegistry();
  const events: string[] = [];

  registry.add(1, {
    symbol: 'EURUSD',
    timeframe: '5m',
    generation: 1,
    callback: () => events.push('old'),
  });
  registry.add(2, {
    symbol: 'EURUSD',
    timeframe: '5m',
    generation: 2,
    callback: () => events.push('new'),
  });

  registry.failGeneration(1);

  assert.deepEqual(events, ['old'], 'only the stale generation was failed');
  assert.equal(registry.has(2), true, 'the newer request remains in flight');

  const newer = registry.take(2);
  assert.ok(newer, 'the newer request is still resolvable');
  newer.callback('EURUSD', '5m', [candle(0)]);
  assert.deepEqual(events, ['old', 'new']);

  // At-most-once: a late/duplicate message for the same id cannot fire again.
  assert.equal(registry.take(2), undefined);
  assert.deepEqual(events, ['old', 'new']);
});

// Test D — Successful request remains correct: a real response seeds the pair,
// deduplication still skips repeat requests, and a duplicate id is ignored.
test('D: a successful response seeds the pair and repeat requests stay deduplicated', () => {
  const registry = new HistoryRequestRegistry();
  const bookkeeping = createHistoryBookkeeping();
  markHistoryPending(bookkeeping, 'EURUSD', '5m');

  registry.add(10, {
    symbol: 'EURUSD',
    timeframe: '5m',
    generation: 3,
    callback: (symbol, timeframe, candles) =>
      applyHistoryOutcome(bookkeeping, symbol, timeframe, candles.length),
  });

  const completed = registry.take(10);
  assert.ok(completed, 'request present before completion');
  completed.callback('EURUSD', '5m', [candle(0), candle(60)]);

  assert.equal(bookkeeping.pending.has('EURUSD:5m'), false);
  assert.equal(bookkeeping.seeded.has('EURUSD:5m'), true, 'successful response seeds the pair');
  assert.equal(
    planHistoryLoad('EURUSD', '5m', bookkeeping.seeded, bookkeeping.pending, true),
    'skip-seeded',
    'already-seeded pair is not re-requested'
  );

  // A duplicate response for the consumed request id is ignored.
  assert.equal(registry.take(10), undefined);
  assert.equal(
    planHistoryLoad('EURUSD', '5m', bookkeeping.seeded, bookkeeping.pending, true),
    'skip-seeded'
  );
});

// Intentional disconnect tears down every in-flight request, across
// generations, so nothing is left registered on the discarded client.
test('intentional disconnect fails every in-flight request regardless of generation', () => {
  const registry = new HistoryRequestRegistry();
  const failed: number[] = [];

  registry.add(1, {
    symbol: 'EURUSD',
    timeframe: '5m',
    generation: 1,
    callback: () => failed.push(1),
  });
  registry.add(2, {
    symbol: 'GBPUSD',
    timeframe: '1m',
    generation: 2,
    callback: () => failed.push(2),
  });

  registry.failAll();

  assert.deepEqual(failed.sort(), [1, 2]);
  assert.equal(registry.size(), 0);
});
