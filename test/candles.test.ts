import test from 'node:test';
import assert from 'node:assert/strict';
import { CandleManager, Candle, TickData } from '../lib/deriv/candles';

const SYMBOL = 'EURUSD';
const TF = '1m';

function tick(price: number, epoch: number, symbol = SYMBOL): TickData {
  return { symbol, derivSymbol: `frx${symbol}`, price, epoch, pipSize: 5 };
}

function seedCandle(epoch: number, open: number, high: number, low: number, close: number) {
  return { epoch, open, high, low, close };
}

// 1. Same-period ticks accumulate OHLC and volume ---------------------------

test('C1 — same-period ticks update open, high, low, close and volume', () => {
  const manager = new CandleManager();
  manager.processTick(tick(1.1, 100));
  manager.processTick(tick(1.15, 110));
  manager.processTick(tick(1.05, 115));

  const candle = manager.getCurrentCandle(SYMBOL, TF)!;
  assert.equal(candle.epoch, 60);
  assert.equal(candle.open, 1.1);
  assert.equal(candle.high, 1.15);
  assert.equal(candle.low, 1.05);
  assert.equal(candle.close, 1.05);
  assert.equal(candle.volume, 3);
  assert.equal(candle.isClosed, false);
});

// 2. Rollover finalises BEFORE emitting the close event ---------------------

test('C2 — period rollover finalises the previous candle before emitting close', () => {
  const manager = new CandleManager();
  const closedEpochs: number[] = [];
  const historyLenAtClose: number[] = [];

  manager.onCandleClose((_symbol, _tf, candle) => {
    closedEpochs.push(candle.epoch);
    historyLenAtClose.push(
      manager.getHistory(SYMBOL, TF).filter((c) => c.epoch === candle.epoch).length
    );
  });

  manager.processTick(tick(1.1, 100));
  manager.processTick(tick(1.2, 119));
  assert.equal(closedEpochs.length, 0, 'no close fires while the period is ongoing');

  manager.processTick(tick(1.3, 120));
  assert.deepEqual(closedEpochs, [60]);
  assert.equal(historyLenAtClose[0], 1, 'the finalized candle is in history when close fires');
});

// 3. Emitted closed candle agrees with the finalized candle in history ------

test('C3 — emitted closed candle matches the finalized candle in history', () => {
  const manager = new CandleManager();
  const emitted: Candle[] = [];
  manager.onCandleClose((_symbol, _tf, candle) => emitted.push({ ...candle }));

  manager.processTick(tick(1.1, 100));
  manager.processTick(tick(1.25, 119));
  manager.processTick(tick(1.3, 120));

  const history = manager.getHistory(SYMBOL, TF);
  assert.equal(history.length, 1);
  assert.deepEqual(emitted[0], history[0]);
  assert.equal(history[0].isClosed, true);
  assert.equal(history[0].open, 1.1);
  assert.equal(history[0].high, 1.25);
  assert.equal(history[0].low, 1.1);
  assert.equal(history[0].close, 1.25);
  assert.equal(history[0].volume, 2);
});

// 4. Maximum-history trimming ------------------------------------------------

test('C4 — maximum-history trimming drops the oldest closed candles', () => {
  const manager = new CandleManager(3);
  manager.processTick(tick(1.0, 60));
  manager.processTick(tick(1.0, 120));
  manager.processTick(tick(1.0, 180));
  manager.processTick(tick(1.0, 240));
  manager.processTick(tick(1.0, 300));

  const history = manager.getHistory(SYMBOL, TF);
  assert.equal(history.length, 3);
  assert.deepEqual(
    history.map((c) => c.epoch),
    [120, 180, 240]
  );
});

// 5. Out-of-order ticks do not corrupt state ---------------------------------

test('C5 — out-of-order ticks do not corrupt existing candle state', () => {
  const manager = new CandleManager();
  manager.processTick(tick(1.1, 100));
  manager.processTick(tick(1.2, 130));

  const before = manager.getCurrentCandle(SYMBOL, TF)!;
  // A tick whose period predates the currently forming candle is ignored.
  manager.processTick(tick(9.9, 10));
  assert.deepEqual(manager.getCurrentCandle(SYMBOL, TF), before);

  // A tick older than seeded history is ignored when no forming candle exists.
  const seeded = new CandleManager();
  seeded.seedHistory(SYMBOL, TF, [seedCandle(600, 1.0, 1.0, 1.0, 1.0)]);
  const historyBefore = seeded.getHistory(SYMBOL, TF);
  seeded.processTick(tick(2.0, 60));
  assert.deepEqual(seeded.getHistory(SYMBOL, TF), historyBefore);
  assert.equal(seeded.getCurrentCandle(SYMBOL, TF), null);
});

// 6. History promotion on the first relevant live tick -----------------------

test('C6 — a live tick promotes the matching historical candle into the forming candle', () => {
  const manager = new CandleManager();
  manager.seedHistory(SYMBOL, TF, [seedCandle(60, 1.0, 1.2, 0.9, 1.1)]);
  assert.equal(manager.getHistory(SYMBOL, TF).length, 1);
  assert.equal(manager.getCurrentCandle(SYMBOL, TF), null);

  manager.processTick(tick(1.3, 70));

  const current = manager.getCurrentCandle(SYMBOL, TF)!;
  assert.equal(current.epoch, 60);
  assert.equal(current.isClosed, false);
  assert.equal(current.open, 1.0);
  assert.equal(current.high, 1.3);
  assert.equal(current.low, 0.9);
  assert.equal(current.close, 1.3);
  assert.equal(current.volume, 2);
  assert.equal(manager.getHistory(SYMBOL, TF).length, 0);
});

// 7. P1 regression: stale tick time must not promote a completed candle ------

test('C7 — a stale tick time cannot promote a newer completed history candle', () => {
  const manager = new CandleManager();
  // The live feed stops inside the period that starts at epoch 60.
  manager.processTick(tick(1.1, 100));
  assert.equal(manager.getCurrentCandle(SYMBOL, TF)!.epoch, 60);

  // The history backfill only later returns completed candles for periods
  // 60..180, all NEWER than the frozen live tick time.
  manager.seedHistory(SYMBOL, TF, [
    seedCandle(60, 1.0, 1.1, 0.9, 1.05),
    seedCandle(120, 1.05, 1.2, 1.0, 1.15),
    seedCandle(180, 1.15, 1.3, 1.1, 1.25),
  ]);

  const history = manager.getHistory(SYMBOL, TF);
  assert.deepEqual(
    history.map((c) => c.epoch),
    [60, 120, 180]
  );
  assert.ok(
    history.every((c) => c.isClosed),
    'all seeded candles stay closed'
  );
  assert.equal(manager.getCurrentCandle(SYMBOL, TF), null, 'no candle is wrongly promoted');

  // A subsequent live tick in period 180 legitimately forms that period.
  manager.processTick(tick(1.4, 200));
  const current = manager.getCurrentCandle(SYMBOL, TF)!;
  assert.equal(current.epoch, 180);
  assert.equal(current.isClosed, false);
  assert.equal(current.volume, 2);
});

test('C7b — a genuine forming candle is still promoted when the live tick is current', () => {
  const manager = new CandleManager();
  // Live tick falls inside period 120; history's newest candle is that period.
  manager.processTick(tick(1.1, 130));
  manager.seedHistory(SYMBOL, TF, [
    seedCandle(60, 1.0, 1.1, 0.9, 1.0),
    seedCandle(120, 1.0, 1.2, 0.95, 1.15),
  ]);

  const current = manager.getCurrentCandle(SYMBOL, TF)!;
  assert.equal(current.epoch, 120);
  assert.equal(current.isClosed, false);
  assert.deepEqual(
    manager.getHistory(SYMBOL, TF).map((c) => c.epoch),
    [60]
  );
});

// 8. No duplicate candles from seeding + live ticks --------------------------

test('C8 — seeding and live ticks do not produce duplicate candles', () => {
  const manager = new CandleManager();
  manager.processTick(tick(1.1, 100));
  manager.processTick(tick(1.12, 110));

  const seeded = [
    seedCandle(0, 1.0, 1.05, 0.95, 1.0),
    seedCandle(60, 1.0, 1.2, 0.98, 1.15),
  ];
  manager.seedHistory(SYMBOL, TF, seeded);
  // Re-seeding the identical epochs must remain idempotent.
  manager.seedHistory(SYMBOL, TF, seeded);

  const all = manager.getAllCandles(SYMBOL, TF);
  const epochs = all.map((c) => c.epoch);
  assert.equal(new Set(epochs).size, epochs.length, 'no duplicate epochs');

  const candle60 = all.find((c) => c.epoch === 60)!;
  assert.equal(candle60.volume, 2, 'accumulated live volume retained');
  assert.equal(manager.getHistory(SYMBOL, TF).length, 1, 'only the closed epoch 0 remains in history');
});
