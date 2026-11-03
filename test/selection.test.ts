import test from 'node:test';
import assert from 'node:assert/strict';
import { CandleManager, TickData, Timeframe } from '../lib/deriv/candles';
import { isSelectedPair } from '../lib/deriv/selection';

function tick(symbol: string, epoch: number, price: number): TickData {
  return { symbol, derivSymbol: 'test', price, epoch };
}

interface CloseEvent {
  symbol: string;
  timeframe: Timeframe;
}

// Regression for the candle-close listener defect: a close event from a
// non-selected timeframe previously overwrote the selected chart's analysis
// because only the symbol was checked. The listener now uses isSelectedPair,
// which requires BOTH symbol and timeframe to match the active selection.
test('a higher-timeframe selection ignores lower-timeframe close events', () => {
  const manager = new CandleManager(1000);
  const events: CloseEvent[] = [];
  manager.onCandleClose((symbol, timeframe) => {
    events.push({ symbol, timeframe });
  });

  // 1m periods roll on every minute tick; the 5m period rolls at epoch 300.
  for (const epoch of [0, 60, 120, 180, 240, 300, 360]) {
    manager.processTick(tick('EURUSD', epoch, 1.1));
  }

  const selectedSymbolId = 'EURUSD';
  const selectedTimeframe: Timeframe = '5m';

  const m1Closes = events.filter((e) => e.timeframe === '1m');
  const m5Closes = events.filter((e) => e.timeframe === '5m');

  assert.ok(m1Closes.length > 0, 'expected live 1m closes to be emitted');
  assert.ok(m5Closes.length > 0, 'expected a live 5m close to be emitted');

  // The defect: an M1 close must NOT pass the active-selection guard.
  for (const event of m1Closes) {
    assert.equal(
      isSelectedPair(event.symbol, event.timeframe, selectedSymbolId, selectedTimeframe),
      false,
      `1m close for ${event.symbol} must not update the selected 5m chart`
    );
  }

  // The selected 5m close MUST still pass the guard.
  assert.ok(
    m5Closes.some((event) =>
      isSelectedPair(event.symbol, event.timeframe, selectedSymbolId, selectedTimeframe)
    ),
    'the selected 5m close must update the chart'
  );
});

test('close events for a non-selected symbol are rejected', () => {
  const manager = new CandleManager(1000);
  const events: CloseEvent[] = [];
  manager.onCandleClose((symbol, timeframe) => {
    events.push({ symbol, timeframe });
  });

  for (const epoch of [0, 60, 120, 180, 240, 300]) {
    manager.processTick(tick('GBPUSD', epoch, 1.3));
  }

  const selectedSymbolId = 'EURUSD';
  const selectedTimeframe: Timeframe = '5m';
  const gbpEvents = events.filter((e) => e.symbol === 'GBPUSD');

  assert.ok(gbpEvents.length > 0, 'expected GBPUSD close events');
  for (const event of gbpEvents) {
    assert.equal(
      isSelectedPair(event.symbol, event.timeframe, selectedSymbolId, selectedTimeframe),
      false,
      `close for ${event.symbol} ${event.timeframe} must not update the EURUSD selection`
    );
  }
});

test('the selected symbol/timeframe pair passes the guard', () => {
  assert.equal(isSelectedPair('EURUSD', '5m', 'EURUSD', '5m'), true);
  assert.equal(isSelectedPair('EURUSD', '1H', 'EURUSD', '1H'), true);
});
