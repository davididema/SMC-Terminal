import test from 'node:test';
import assert from 'node:assert/strict';
import type { SignalOutput } from '../lib/signals/signal-engine';
import {
  signalPairKey,
  isGeneratedSignal,
  recordGeneratedSignal,
  getGeneratedSignal,
} from '../lib/signals/signal-history';

function generated(
  decision: 'LONG' | 'SHORT',
  overrides: Partial<SignalOutput> = {}
): SignalOutput {
  return {
    decision,
    confidence: 70,
    setup: decision === 'LONG' ? 'SWEEP_REVERSAL' : 'TREND_CONTINUATION',
    entry: decision === 'LONG' ? 1.1 : 1.2,
    stopLoss: decision === 'LONG' ? 1.09 : 1.21,
    takeProfit: decision === 'LONG' ? 1.13 : 1.16,
    riskReward: 3,
    reason: `${decision} signal`,
    timestamp: 1750000100,
    signalEpoch: 1750000100,
    ...overrides,
  };
}

function noTrade(
  codes: SignalOutput['rejectionReasons'],
  overrides: Partial<SignalOutput> = {}
): SignalOutput {
  return {
    decision: 'NO_TRADE',
    confidence: null,
    setup: 'NONE',
    entry: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    reason: 'Signal rejected',
    timestamp: 1750000200,
    rejectionReasons: codes,
    ...overrides,
  };
}

test('SIGNAL-HISTORY — isGeneratedSignal accepts only genuine LONG/SHORT', () => {
  assert.equal(isGeneratedSignal(generated('LONG')), true);
  assert.equal(isGeneratedSignal(generated('SHORT')), true);
  assert.equal(isGeneratedSignal(noTrade(['DUPLICATE'])), false);
  assert.equal(isGeneratedSignal(noTrade(['ZONE_MISALIGNED'])), false);
  assert.equal(isGeneratedSignal(null), false);
  assert.equal(isGeneratedSignal(undefined), false);
});

test('SIGNAL-HISTORY — LONG is retained when the next evaluation is NO_TRADE/DUPLICATE', () => {
  const key = signalPairKey('EURUSD', '1m');
  const long = generated('LONG', { signalEpoch: 1750000100, timestamp: 1750000100 });

  const afterLong = recordGeneratedSignal(new Map(), key, long);
  assert.equal(getGeneratedSignal(afterLong, key)?.decision, 'LONG');

  // The engine re-evaluates the identical, already-consumed setup: NO_TRADE/DUPLICATE.
  const afterNoTrade = recordGeneratedSignal(afterLong, key, noTrade(['DUPLICATE']));

  const retained = getGeneratedSignal(afterNoTrade, key);
  assert.equal(afterNoTrade, afterLong, 'a NO_TRADE must not mutate the retained store');
  assert.equal(retained?.decision, 'LONG');
  assert.equal(retained?.entry, long.entry);
  assert.equal(retained?.stopLoss, long.stopLoss);
  assert.equal(retained?.takeProfit, long.takeProfit);
  assert.equal(retained?.riskReward, long.riskReward);
  assert.equal(retained?.signalEpoch, long.signalEpoch);
  assert.equal(retained?.timestamp, long.timestamp);
});

test('SIGNAL-HISTORY — SHORT is retained when the next evaluation is NO_TRADE/DUPLICATE', () => {
  const key = signalPairKey('XAUUSD', '5m');
  const short = generated('SHORT');
  let store = recordGeneratedSignal(new Map(), key, short);
  store = recordGeneratedSignal(store, key, noTrade(['DUPLICATE']));
  const retained = getGeneratedSignal(store, key);
  assert.equal(retained?.decision, 'SHORT');
  assert.equal(retained?.entry, short.entry);
  assert.equal(retained?.signalEpoch, short.signalEpoch);
});

test('SIGNAL-HISTORY — a different NO_TRADE rejection still does not overwrite the LONG', () => {
  const key = signalPairKey('EURUSD', '1m');
  const long = generated('LONG');
  let store = recordGeneratedSignal(new Map(), key, long);
  store = recordGeneratedSignal(store, key, noTrade(['ZONE_MISALIGNED', 'NO_FRESH_SWEEP']));
  store = recordGeneratedSignal(store, key, noTrade(['RR_BELOW_MIN']));
  const retained = getGeneratedSignal(store, key);
  assert.equal(retained?.decision, 'LONG');
  assert.equal(retained?.entry, long.entry);
});

test('SIGNAL-HISTORY — a new SHORT after an earlier LONG updates the retained signal', () => {
  const key = signalPairKey('EURUSD', '1m');
  const long = generated('LONG', { signalEpoch: 1750000100 });
  const short = generated('SHORT', { signalEpoch: 1750000400 });

  let store = recordGeneratedSignal(new Map(), key, long);
  store = recordGeneratedSignal(store, key, noTrade(['DUPLICATE']));
  assert.equal(getGeneratedSignal(store, key)?.signalEpoch, long.signalEpoch);

  store = recordGeneratedSignal(store, key, short);
  const retained = getGeneratedSignal(store, key);
  assert.equal(retained?.decision, 'SHORT');
  assert.equal(retained?.signalEpoch, short.signalEpoch);
});

test('SIGNAL-HISTORY — no generated signal yields the empty state', () => {
  assert.equal(getGeneratedSignal(new Map(), signalPairKey('EURUSD', '1m')), null);
  const onlyNoTrade = recordGeneratedSignal(
    new Map(),
    signalPairKey('EURUSD', '1m'),
    noTrade(['NO_CONTEXT'])
  );
  assert.equal(getGeneratedSignal(onlyNoTrade, signalPairKey('EURUSD', '1m')), null);
});

test('SIGNAL-HISTORY — an EURUSD signal never appears for XAUUSD', () => {
  const eurKey = signalPairKey('EURUSD', '1m');
  const xauKey = signalPairKey('XAUUSD', '1m');
  const eurLong = generated('LONG', { entry: 1.1 });

  let store = recordGeneratedSignal(new Map(), eurKey, eurLong);
  assert.equal(getGeneratedSignal(store, xauKey), null);

  const xauShort = generated('SHORT', { entry: 2000 });
  store = recordGeneratedSignal(store, xauKey, xauShort);

  assert.equal(getGeneratedSignal(store, eurKey)?.decision, 'LONG');
  assert.equal(getGeneratedSignal(store, eurKey)?.entry, 1.1);
  assert.equal(getGeneratedSignal(store, xauKey)?.decision, 'SHORT');
  assert.equal(getGeneratedSignal(store, xauKey)?.entry, 2000);
});

test('SIGNAL-HISTORY — a 1m signal never appears as the 5m signal', () => {
  const oneMin = signalPairKey('EURUSD', '1m');
  const fiveMin = signalPairKey('EURUSD', '5m');
  const oneMinLong = generated('LONG', { signalEpoch: 1750000100 });

  let store = recordGeneratedSignal(new Map(), oneMin, oneMinLong);
  assert.equal(getGeneratedSignal(store, fiveMin), null);

  const fiveMinShort = generated('SHORT', { signalEpoch: 1750000600 });
  store = recordGeneratedSignal(store, fiveMin, fiveMinShort);

  assert.equal(getGeneratedSignal(store, oneMin)?.signalEpoch, oneMinLong.signalEpoch);
  assert.equal(getGeneratedSignal(store, fiveMin)?.signalEpoch, fiveMinShort.signalEpoch);
});

test('SIGNAL-HISTORY — a late evaluation for another pair cannot overwrite the current pair', () => {
  const currentKey = signalPairKey('EURUSD', '1m');
  const otherKey = signalPairKey('GBPUSD', '1m');
  const eurLong = generated('LONG', { signalEpoch: 1750000100 });

  let store = recordGeneratedSignal(new Map(), currentKey, eurLong);
  // An out-of-order/late result belonging to a non-selected pair.
  store = recordGeneratedSignal(store, otherKey, generated('SHORT', { signalEpoch: 1750000800 }));

  assert.equal(getGeneratedSignal(store, currentKey)?.decision, 'LONG');
  assert.equal(getGeneratedSignal(store, currentKey)?.signalEpoch, eurLong.signalEpoch);
  assert.equal(getGeneratedSignal(store, otherKey)?.decision, 'SHORT');
});
