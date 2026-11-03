/**
 * Phase 4B — G2: a same-period out-of-order tick must not overwrite the
 * currently forming candle.
 *
 * The confirmed defect: the symbol-level live edge correctly refused to move
 * backwards for a delayed tick, but the tick was still delivered to the candle
 * update branch. When the delayed tick belonged to the same period as the
 * forming candle, it overwrote `close`, expanded `high`/`low` and incremented
 * `volume` even though its event time was older than the newest accepted event.
 *
 * Equal timestamps are intentionally NOT treated as out of order. The feed can
 * legitimately deliver several quotes within the same second, and the existing
 * duplicate-tick behaviour (D6 C1) accepts them as price updates for the
 * forming candle. Accepting an equal epoch cannot regress accepted state: the
 * candle's accepted event time stays monotonic (non-decreasing), never older.
 *
 * These tests use synthetic epochs and in-memory state only. No socket, no
 * network, no fabricated market data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Candle, CandleManager, TickData } from '../lib/deriv/candles';

function tick(symbol: string, price: number, epoch: number): TickData {
  return { symbol, derivSymbol: symbol, price, epoch };
}

// =============================================================================================
// A — same-period stale ticks are rejected
// =============================================================================================

test('G2 A — an older tick in the forming period cannot overwrite the candle', () => {
  const manager = new CandleManager();

  manager.processTick(tick('EURUSD', 1.13, 730));
  const accepted = manager.getCurrentCandle('EURUSD', '1m')!;
  assert.equal(accepted.epoch, 720, 'both ticks belong to the 1m period 720');
  assert.equal(accepted.close, 1.13);

  // The delayed tick is older but belongs to the same forming period.
  manager.processTick(tick('EURUSD', 9.9, 725));

  const after = manager.getCurrentCandle('EURUSD', '1m')!;
  assert.equal(after.close, 1.13, 'the accepted close is not overwritten');
  assert.equal(after.open, accepted.open, 'the open is unchanged');
  assert.equal(after.high, accepted.high, 'a stale price cannot expand the high');
  assert.equal(after.low, accepted.low, 'a stale price cannot expand the low');
  assert.equal(after.volume, accepted.volume, 'a stale tick is not counted');
  assert.equal(manager.getState('EURUSD')!.lastTickTime, 730, 'the live edge is unchanged');
  assert.equal(manager.getState('EURUSD')!.lastPrice, 1.13, 'the accepted price is unchanged');
});

test('G2 A2 — an older tick after a newer same-period tick changes nothing', () => {
  const manager = new CandleManager();

  manager.processTick(tick('EURUSD', 1.13, 730));
  manager.processTick(tick('EURUSD', 1.15, 735));
  const accepted = manager.getCurrentCandle('EURUSD', '1m')!;
  assert.equal(accepted.close, 1.15);

  manager.processTick(tick('EURUSD', 9.9, 725));

  const after = manager.getCurrentCandle('EURUSD', '1m')!;
  assert.deepEqual(after, accepted, 'the entire candle state is unchanged');
  assert.equal(manager.getState('EURUSD')!.lastTickTime, 735, 'the newest time is kept');
  assert.equal(manager.getState('EURUSD')!.lastPrice, 1.15, 'the newest price is kept');
});

// =============================================================================================
// B — a newer tick still updates the forming candle
// =============================================================================================

test('G2 B — a newer tick in the same period updates the candle normally', () => {
  const manager = new CandleManager();

  manager.processTick(tick('EURUSD', 1.13, 730));
  manager.processTick(tick('EURUSD', 1.15, 735));

  const current = manager.getCurrentCandle('EURUSD', '1m')!;
  assert.equal(current.epoch, 720);
  assert.equal(current.close, 1.15, 'the newer quote becomes the close');
  assert.equal(current.high, 1.15, 'the newer quote expands the high');
  assert.equal(current.low, 1.13, 'the low is the lower accepted quote');
  assert.equal(current.volume, 2, 'both accepted ticks are counted');
  assert.equal(manager.getState('EURUSD')!.lastTickTime, 735);
  assert.equal(manager.getState('EURUSD')!.lastPrice, 1.15);
});

// =============================================================================================
// C — equal timestamps keep their existing price-update semantics
// =============================================================================================

test('G2 C — equal timestamps are still accepted as same-second price updates', () => {
  const manager = new CandleManager();

  manager.processTick(tick('EURUSD', 1.13, 730));
  manager.processTick(tick('EURUSD', 1.14, 730));
  manager.processTick(tick('EURUSD', 1.12, 730));

  const current = manager.getCurrentCandle('EURUSD', '1m')!;
  assert.equal(current.epoch, 720);
  assert.equal(current.open, 1.13);
  assert.equal(current.high, 1.14);
  assert.equal(current.low, 1.12);
  assert.equal(current.close, 1.12, 'the newest same-second quote wins');
  assert.equal(current.volume, 3, 'every same-second quote is counted');
  assert.equal(manager.getState('EURUSD')!.lastTickTime, 730, 'the accepted time is not regressed');
  assert.equal(manager.getState('EURUSD')!.lastPrice, 1.12);
});

// =============================================================================================
// D — rollover
// =============================================================================================

test('G2 D — a valid later-period tick closes the old candle and starts the new one', () => {
  const manager = new CandleManager();
  const closes: Candle[] = [];
  manager.onCandleClose((_symbol, timeframe, closed) => {
    if (timeframe === '1m') closes.push(closed);
  });

  manager.processTick(tick('EURUSD', 1.13, 730));
  manager.processTick(tick('EURUSD', 1.2, 790));

  assert.equal(closes.length, 1, 'the previous candle closes exactly once');
  assert.equal(closes[0].epoch, 720);
  assert.equal(closes[0].close, 1.13);

  const history = manager.getHistory('EURUSD', '1m');
  assert.deepEqual(history.map((c) => c.epoch), [720]);
  assert.equal(history[0].close, 1.13);

  const current = manager.getCurrentCandle('EURUSD', '1m')!;
  assert.equal(current.epoch, 780, 'the next period forms');
  assert.equal(current.open, 1.2);
  assert.equal(current.high, 1.2);
  assert.equal(current.low, 1.2);
  assert.equal(current.close, 1.2);
  assert.equal(current.volume, 1);
  assert.equal(manager.getState('EURUSD')!.lastTickTime, 790);
});

test('G2 D2 — stale ticks around a rollover cannot corrupt the new candle', () => {
  const manager = new CandleManager();
  const closes: Candle[] = [];
  manager.onCandleClose((_symbol, timeframe, closed) => {
    if (timeframe === '1m') closes.push(closed);
  });

  manager.processTick(tick('EURUSD', 1.13, 730));
  manager.processTick(tick('EURUSD', 1.2, 790));

  // Older than the rollover tick but inside the NEW forming period.
  manager.processTick(tick('EURUSD', 9.9, 785));
  // Older still: it belongs to the period that was already closed.
  manager.processTick(tick('EURUSD', 8.8, 725));

  const current = manager.getCurrentCandle('EURUSD', '1m')!;
  assert.equal(current.epoch, 780);
  assert.equal(current.open, 1.2);
  assert.equal(current.high, 1.2);
  assert.equal(current.low, 1.2);
  assert.equal(current.close, 1.2, 'the new candle keeps its accepted close');
  assert.equal(current.volume, 1, 'stale ticks are not counted');
  assert.equal(closes.length, 1, 'no extra close is emitted');
  assert.equal(manager.getHistory('EURUSD', '1m').length, 1);
  assert.equal(manager.getState('EURUSD')!.lastTickTime, 790, 'the live edge did not regress');
  assert.equal(manager.getState('EURUSD')!.lastPrice, 1.2);
});

// =============================================================================================
// E — invalid timestamps
// =============================================================================================

test('G2 E — an invalid timestamp cannot corrupt the candle or accepted state', () => {
  const manager = new CandleManager();
  manager.processTick(tick('EURUSD', 1.13, 730));
  const accepted = manager.getCurrentCandle('EURUSD', '1m')!;

  const invalid: Array<[string, unknown]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -120],
    ['non-numeric', 'not-a-number'],
  ];
  for (const [label, epoch] of invalid) {
    manager.processTick({
      symbol: 'EURUSD',
      derivSymbol: 'EURUSD',
      price: 9.9,
      epoch: epoch as number,
    });
    assert.deepEqual(
      manager.getCurrentCandle('EURUSD', '1m'),
      accepted,
      `the candle survives an epoch of ${label}`
    );
    assert.equal(
      manager.getState('EURUSD')!.lastTickTime,
      730,
      `the accepted time survives an epoch of ${label}`
    );
    assert.equal(manager.getState('EURUSD')!.lastPrice, 1.13);
  }

  assert.equal(manager.getHistory('EURUSD', '1m').length, 0, 'no trusted candle was created');
});

// =============================================================================================
// F — isolation
// =============================================================================================

test('G2 F1 — an out-of-order tick of one symbol cannot affect another symbol', () => {
  const manager = new CandleManager();

  manager.processTick(tick('EURUSD', 1.13, 730));
  manager.processTick(tick('GBPUSD', 1.2, 700));
  manager.processTick(tick('EURUSD', 9.9, 725));

  const eurusd = manager.getCurrentCandle('EURUSD', '1m')!;
  const gbpusd = manager.getCurrentCandle('GBPUSD', '1m')!;
  assert.equal(eurusd.epoch, 720);
  assert.equal(eurusd.close, 1.13, 'the stale tick is rejected');
  assert.equal(gbpusd.epoch, 660);
  assert.equal(gbpusd.close, 1.2, 'the other symbol is untouched');
  assert.equal(manager.getState('EURUSD')!.lastTickTime, 730);
  assert.equal(manager.getState('GBPUSD')!.lastTickTime, 700);
});

test('G2 F2 — same-period protection holds across timeframes', () => {
  const manager = new CandleManager();

  manager.processTick(tick('EURUSD', 1.13, 730));
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.close, 1.13);
  assert.equal(manager.getCurrentCandle('EURUSD', '5m')?.close, 1.13);

  // 725 is older than 730 in BOTH the 1m and the 5m period.
  manager.processTick(tick('EURUSD', 9.9, 725));
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.close, 1.13);
  assert.equal(manager.getCurrentCandle('EURUSD', '5m')?.close, 1.13);

  // 735 is newer and updates both timeframes normally.
  manager.processTick(tick('EURUSD', 1.15, 735));
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.close, 1.15);
  assert.equal(manager.getCurrentCandle('EURUSD', '5m')?.close, 1.15);

  // 790 rolls the 1m candle forward but stays inside the same 5m period.
  manager.processTick(tick('EURUSD', 1.2, 790));
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.epoch, 780);
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.close, 1.2);
  assert.equal(manager.getCurrentCandle('EURUSD', '5m')?.epoch, 600);
  assert.equal(manager.getCurrentCandle('EURUSD', '5m')?.close, 1.2);

  // 785 is stale for both: it is older than the newest accepted event.
  manager.processTick(tick('EURUSD', 9.9, 785));
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.close, 1.2);
  assert.equal(manager.getCurrentCandle('EURUSD', '5m')?.close, 1.2);
  assert.equal(manager.getHistory('EURUSD', '1m').length, 1, 'only the 1m rollover closed');
  assert.equal(manager.getHistory('EURUSD', '5m').length, 0, 'the 5m period is still forming');
});

// =============================================================================================
// G — recovery compatibility
// =============================================================================================

test('G2 G — a same-period stale tick cannot touch an interrupted pair', () => {
  const manager = new CandleManager();

  manager.processTick(tick('EURUSD', 1.1, 100));
  manager.markDiscontinuity('EURUSD');
  manager.processTick(tick('EURUSD', 1.2, 700));

  const current = manager.getCurrentCandle('EURUSD', '1m')!;
  assert.equal(current.epoch, 660);

  // 665 is in the current forming period but older than the accepted 700.
  manager.processTick(tick('EURUSD', 9.9, 665));

  const after = manager.getCurrentCandle('EURUSD', '1m')!;
  assert.equal(after.epoch, 660);
  assert.equal(after.open, 1.2);
  assert.equal(after.high, 1.2);
  assert.equal(after.low, 1.2);
  assert.equal(after.close, 1.2, 'the forming candle keeps the accepted close');
  assert.equal(after.volume, 1);
  assert.equal(manager.getState('EURUSD')!.lastTickTime, 700);
  assert.equal(manager.getState('EURUSD')!.lastPrice, 1.2);
  assert.equal(
    manager.getTimeframeState('EURUSD', '1m')?.interruptedEpoch,
    60,
    'the interrupted candle is still marked'
  );
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), true, 'the pair stays blocked');
});
