import test from 'node:test';
import assert from 'node:assert/strict';
import { historyKey, planHistoryLoad } from '../lib/deriv/history-init';
import { CandleManager, TickData } from '../lib/deriv/candles';

function tick(symbol: string, epoch: number, price: number): TickData {
  return { symbol, derivSymbol: 'test', price, epoch };
}

test('historyKey encodes both symbol and timeframe', () => {
  assert.equal(historyKey('EURUSD', '1m'), 'EURUSD:1m');
  assert.notEqual(historyKey('EURUSD', '1m'), historyKey('GBPUSD', '1m'));
  assert.notEqual(historyKey('EURUSD', '1m'), historyKey('EURUSD', '5m'));
});

test('a pair with three live candles still triggers historical backfill', () => {
  const manager = new CandleManager(1000);

  // Four ticks across three completed 1m periods produces three closed live candles.
  manager.processTick(tick('EURUSD', 0, 1.0));
  manager.processTick(tick('EURUSD', 60, 1.1));
  manager.processTick(tick('EURUSD', 120, 1.2));
  manager.processTick(tick('EURUSD', 180, 1.3));

  assert.equal(
    manager.getHistory('EURUSD', '1m').length,
    3,
    'expected three accumulated live candles'
  );

  // Even though live candles exist, the pair has never been backfilled.
  const plan = planHistoryLoad('EURUSD', '1m', new Set(), new Set(), true);
  assert.equal(plan, 'request');
});

test('a successfully initialized pair does not trigger repeated requests', () => {
  const seeded = new Set<string>([historyKey('EURUSD', '1m')]);
  assert.equal(planHistoryLoad('EURUSD', '1m', seeded, new Set(), true), 'skip-seeded');
});

test('concurrent requests for the same pair are deduplicated', () => {
  const pending = new Set<string>([historyKey('EURUSD', '1m')]);
  assert.equal(planHistoryLoad('EURUSD', '1m', new Set(), pending, true), 'skip-pending');
});

test('a failed request can be retried once pending is cleared', () => {
  const seeded = new Set<string>();
  const pending = new Set<string>([historyKey('EURUSD', '5m')]);

  assert.equal(planHistoryLoad('EURUSD', '5m', seeded, pending, true), 'skip-pending');

  // Failure cleanup clears the pending marker without marking the pair seeded.
  pending.delete(historyKey('EURUSD', '5m'));
  assert.equal(planHistoryLoad('EURUSD', '5m', seeded, pending, true), 'request');
});

test('seeding one pair does not suppress requests for other pairs', () => {
  const seeded = new Set<string>([historyKey('EURUSD', '1m')]);
  const pending = new Set<string>();

  assert.equal(planHistoryLoad('GBPUSD', '1m', seeded, pending, true), 'request');
  assert.equal(planHistoryLoad('EURUSD', '5m', seeded, pending, true), 'request');
});

test('missing client yields no-client plan', () => {
  assert.equal(planHistoryLoad('EURUSD', '1m', new Set(), new Set(), false), 'no-client');
});

test('historical seed merges with live candles without duplicate epochs and keeps live volume', () => {
  const manager = new CandleManager(1000);

  // Three live ticks build an unclosed current 1m candle at epoch 120 (volume 3).
  manager.processTick(tick('EURUSD', 120, 1.1));
  manager.processTick(tick('EURUSD', 125, 1.12));
  manager.processTick(tick('EURUSD', 128, 1.11));

  // Historical backfill overlaps the live candle epoch and adds earlier epochs.
  manager.seedHistory('EURUSD', '1m', [
    { epoch: 0, open: 1.0, high: 1.05, low: 0.98, close: 1.02 },
    { epoch: 60, open: 1.02, high: 1.08, low: 1.0, close: 1.06 },
    { epoch: 120, open: 1.06, high: 1.2, low: 1.04, close: 1.15 },
  ]);

  const all = manager.getAllCandles('EURUSD', '1m');
  const epochs = all.map((c) => c.epoch);
  assert.equal(new Set(epochs).size, epochs.length, 'no duplicate epochs');
  assert.ok(epochs.includes(0) && epochs.includes(60) && epochs.includes(120));

  const merged = all.find((c) => c.epoch === 120);
  assert.ok(merged, 'epoch 120 present');
  assert.equal(merged!.volume, 3, 'accumulated live volume retained');
});

test('symbol and timeframe candle histories remain isolated', () => {
  const manager = new CandleManager(1000);

  manager.seedHistory('EURUSD', '1m', [
    { epoch: 0, open: 1.0, high: 1.1, low: 0.9, close: 1.0 },
    { epoch: 60, open: 1.0, high: 1.2, low: 0.95, close: 1.1 },
  ]);

  assert.ok(manager.getHistory('EURUSD', '1m').length > 0, 'seeded pair has history');
  assert.equal(manager.getHistory('GBPUSD', '1m').length, 0, 'other symbol empty');
  assert.equal(manager.getHistory('EURUSD', '5m').length, 0, 'other timeframe empty');
});
