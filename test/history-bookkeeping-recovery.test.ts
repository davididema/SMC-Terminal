import test from 'node:test';
import assert from 'node:assert/strict';
import { CandleManager } from '../lib/deriv/candles';
import { HistoryRequestRegistry } from '../lib/deriv/history-requests';
import {
  createHistoryBookkeeping,
  markHistoryPending,
  applyHistoryOutcome,
  planHistoryLoad,
} from '../lib/deriv/history-init';

/** Deterministic synthetic candle fixture (never real market data). */
function candle(epoch: number) {
  return { epoch, open: 1, high: 1.2, low: 0.9, close: 1.1 };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * These tests exercise the same pure bookkeeping and request-registry
 * interfaces the dashboard uses (`planHistoryLoad`, `applyHistoryOutcome`,
 * `HistoryRequestRegistry`). They use explicit event ordering and no timers.
 */

// --- B. Empty history response ----------------------------------------------

test('B1 — an empty result clears pending but does not seed, and the pair stays requestable', () => {
  const bookkeeping = createHistoryBookkeeping();
  markHistoryPending(bookkeeping, 'EURUSD', '1m');

  // A valid empty result is applied through the registry callback shape.
  applyHistoryOutcome(bookkeeping, 'EURUSD', '1m', 0);

  assert.equal(bookkeeping.pending.has('EURUSD:1m'), false, 'pending cleared');
  assert.equal(bookkeeping.seeded.has('EURUSD:1m'), false, 'empty result never seeds');
  assert.equal(
    planHistoryLoad('EURUSD', '1m', bookkeeping.seeded, bookkeeping.pending, true),
    'request',
    'the pair is eligible for a later request'
  );
});

test('B2 — an empty history response seeds no candles into the candle manager', () => {
  const manager = new CandleManager(1000);
  manager.seedHistory('EURUSD', '1m', []);

  assert.equal(manager.getHistory('EURUSD', '1m').length, 0, 'no closed candles created');
  assert.equal(manager.getCurrentCandle('EURUSD', '1m'), null, 'no forming candle created');
});

test('B3 — an empty result for one pair does not affect another pair', () => {
  const bookkeeping = createHistoryBookkeeping();
  markHistoryPending(bookkeeping, 'EURUSD', '1m');
  markHistoryPending(bookkeeping, 'GBPUSD', '5m');

  applyHistoryOutcome(bookkeeping, 'EURUSD', '1m', 0);

  assert.equal(bookkeeping.pending.has('EURUSD:1m'), false);
  assert.equal(bookkeeping.pending.has('GBPUSD:5m'), true, 'the other pair is untouched');
  assert.equal(
    planHistoryLoad('GBPUSD', '5m', bookkeeping.seeded, bookkeeping.pending, true),
    'skip-pending'
  );
});

// --- D. Unanswered request ---------------------------------------------------

test('D1 — an unanswered request stays pending and blocks a second attempt', () => {
  const registry = new HistoryRequestRegistry();
  const bookkeeping = createHistoryBookkeeping();
  markHistoryPending(bookkeeping, 'EURUSD', '1m');

  registry.add(1, {
    symbol: 'EURUSD',
    timeframe: '1m',
    generation: 1,
    callback: (symbol, timeframe, candles) =>
      applyHistoryOutcome(bookkeeping, symbol, timeframe, candles.length),
  });

  // No response ever arrives for request id 1.
  assert.equal(registry.size(), 1, 'the request remains registered');
  assert.equal(
    planHistoryLoad('EURUSD', '1m', bookkeeping.seeded, bookkeeping.pending, true),
    'skip-pending',
    'a second attempt is deduplicated while the request is outstanding'
  );
});

test('D2 — generation failure clears the abandoned request and re-enables a retry', () => {
  const registry = new HistoryRequestRegistry();
  const bookkeeping = createHistoryBookkeeping();
  let calls = 0;
  markHistoryPending(bookkeeping, 'EURUSD', '1m');

  registry.add(1, {
    symbol: 'EURUSD',
    timeframe: '1m',
    generation: 1,
    callback: (symbol, timeframe, candles) => {
      calls += 1;
      assert.equal(candles.length, 0, 'abandonment is delivered as an empty result');
      applyHistoryOutcome(bookkeeping, symbol, timeframe, candles.length);
    },
  });

  // The connection generation that owned the request is closed.
  registry.failGeneration(1);

  assert.equal(calls, 1, 'the abandoned request is failed exactly once');
  assert.equal(registry.size(), 0, 'the registry is drained');
  assert.equal(bookkeeping.pending.has('EURUSD:1m'), false, 'pending marker cleared');
  assert.equal(bookkeeping.seeded.has('EURUSD:1m'), false, 'failure never seeds');
  assert.equal(
    planHistoryLoad('EURUSD', '1m', bookkeeping.seeded, bookkeeping.pending, true),
    'request',
    'a fresh attempt is eligible after cleanup'
  );
});

// --- E. Request identity and late responses ---------------------------------

test('E1 — requests for different symbol/timeframe pairs stay isolated in the registry', () => {
  const registry = new HistoryRequestRegistry();
  const fired: string[] = [];
  registry.add(1, {
    symbol: 'EURUSD',
    timeframe: '1m',
    generation: 1,
    callback: (symbol, timeframe) => fired.push(`${symbol}:${timeframe}`),
  });
  registry.add(2, {
    symbol: 'GBPUSD',
    timeframe: '5m',
    generation: 1,
    callback: (symbol, timeframe) => fired.push(`${symbol}:${timeframe}`),
  });

  const first = registry.take(1);
  assert.ok(first, 'request 1 is present');
  first.callback('EURUSD', '1m', [candle(60)]);

  assert.deepEqual(fired, ['EURUSD:1m'], 'only the addressed request fired');
  assert.equal(registry.has(2), true, 'the unrelated request is still in flight');
});

test('E2 — a late response for an abandoned request is never mistaken for a newer one', () => {
  const registry = new HistoryRequestRegistry();
  const fired: string[] = [];
  // Same pair, two generations: generation 1 is stale, generation 2 is current.
  registry.add(1, {
    symbol: 'EURUSD',
    timeframe: '1m',
    generation: 1,
    callback: () => fired.push('old'),
  });
  registry.add(2, {
    symbol: 'EURUSD',
    timeframe: '1m',
    generation: 2,
    callback: () => fired.push('new'),
  });

  // The stale connection closes: only generation 1 is failed and removed.
  registry.failGeneration(1);
  assert.deepEqual(fired, ['old'], 'only the abandoned request was failed');
  assert.equal(registry.has(2), true, 'the newer request survives');

  // A late candles message referencing the abandoned id resolves nothing.
  assert.equal(registry.take(1), undefined, 'the abandoned id is gone');
  assert.deepEqual(fired, ['old'], 'the late message cannot fire the newer callback');

  // The newer request still resolves with its own identity.
  const newer = registry.take(2);
  assert.ok(newer, 'the newer request is still present');
  assert.equal(newer.symbol, 'EURUSD');
  assert.equal(newer.timeframe, '1m');
  newer.callback('EURUSD', '1m', [candle(60)]);
  assert.deepEqual(fired, ['old', 'new']);
});

// --- F. Bounded request timeouts --------------------------------------------

test('F1 — a timeout retires exactly its own request and leaves others in flight', async () => {
  const timedOut: string[] = [];
  const registry = new HistoryRequestRegistry({
    onTimeout: (entry) => timedOut.push(`${entry.symbol}:${entry.timeframe}`),
  });
  const bookkeeping = createHistoryBookkeeping();
  const fired: number[] = [];
  markHistoryPending(bookkeeping, 'EURUSD', '1m');
  markHistoryPending(bookkeeping, 'GBPUSD', '5m');

  registry.add(
    1,
    {
      symbol: 'EURUSD',
      timeframe: '1m',
      generation: 1,
      callback: (symbol, timeframe, candles) => {
        fired.push(candles.length);
        applyHistoryOutcome(bookkeeping, symbol, timeframe, candles.length);
      },
    },
    5
  );
  registry.add(
    2,
    { symbol: 'GBPUSD', timeframe: '5m', generation: 1, callback: () => fired.push(999) },
    1000
  );

  await delay(40);

  assert.deepEqual(fired, [0], 'only the timed-out request is failed, with an empty result');
  assert.deepEqual(timedOut, ['EURUSD:1m'], 'the timeout names the retired request');
  assert.equal(registry.has(1), false, 'the timed-out request is removed');
  assert.equal(registry.has(2), true, 'the unrelated request is still in flight');
  assert.equal(bookkeeping.pending.has('EURUSD:1m'), false, 'pending cleared for the timed-out pair');
  assert.equal(
    planHistoryLoad('EURUSD', '1m', bookkeeping.seeded, bookkeeping.pending, true),
    'request',
    'the timed-out pair is retryable'
  );
  registry.failAll();
});

test('F2 — a successful response clears the request timer', async () => {
  const registry = new HistoryRequestRegistry();
  let calls = 0;
  registry.add(
    1,
    { symbol: 'EURUSD', timeframe: '1m', generation: 1, callback: () => (calls += 1) },
    10
  );

  const entry = registry.take(1);
  assert.ok(entry, 'the request is present');
  entry.callback('EURUSD', '1m', [candle(60)]);

  await delay(35);
  assert.equal(calls, 1, 'the cleared timer does not fire after a successful response');
});

test('F3 — abandoning a generation clears its request timers', async () => {
  const registry = new HistoryRequestRegistry();
  let calls = 0;
  registry.add(
    1,
    { symbol: 'EURUSD', timeframe: '1m', generation: 1, callback: () => (calls += 1) },
    10
  );

  registry.failGeneration(1);
  assert.equal(calls, 1, 'the abandoned request is failed once');

  await delay(35);
  assert.equal(calls, 1, 'the cleared timer does not fire after generation cleanup');
  assert.equal(registry.size(), 0, 'the registry is drained');
});

test('F4 — failing every request clears their timers', async () => {
  const registry = new HistoryRequestRegistry();
  let calls = 0;
  const entries = [
    { symbol: 'EURUSD', timeframe: '1m' as const, generation: 1 },
    { symbol: 'GBPUSD', timeframe: '5m' as const, generation: 1 },
  ];
  entries.forEach((entry, index) =>
    registry.add(index + 1, { ...entry, callback: () => (calls += 1) }, 10)
  );

  registry.failAll();
  assert.equal(calls, 2, 'each in-flight request is failed once');

  await delay(35);
  assert.equal(calls, 2, 'no cleared timer fires after cleanup');
  assert.equal(registry.size(), 0, 'no outstanding requests remain');
});

test('F5 — an old request timer cannot retire a newer request', async () => {
  const registry = new HistoryRequestRegistry();
  const fired: number[] = [];
  registry.add(
    1,
    { symbol: 'EURUSD', timeframe: '1m', generation: 1, callback: () => fired.push(1) },
    5
  );
  registry.add(
    2,
    { symbol: 'EURUSD', timeframe: '1m', generation: 2, callback: () => fired.push(2) },
    1000
  );

  await delay(40);

  assert.deepEqual(fired, [1], 'only the older request timed out');
  assert.equal(registry.has(2), true, 'the newer request survives the older timer');
  registry.failAll();
});
