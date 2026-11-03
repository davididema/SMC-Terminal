import test from 'node:test';
import assert from 'node:assert/strict';
import { FVGAnalyzer } from '../lib/analysis/fvg';
import { Candle } from '../lib/deriv/candles';

function createCandle(
  epoch: number,
  open: number,
  high: number,
  low: number,
  close: number,
  isClosed = true
): Candle {
  return { epoch, open, high, low, close, volume: 10, isClosed };
}

const TOL = 0.0001;

test('FVG 1 — Bullish detection sets boundaries and epoch', () => {
  const analyzer = new FVGAnalyzer({ customTolerance: TOL });
  const candles: Candle[] = [
    createCandle(1, 1.098, 1.1, 1.0975, 1.0985),
    createCandle(2, 1.0985, 1.1015, 1.0995, 1.101),
    createCandle(3, 1.101, 1.1025, 1.1005, 1.102),
  ];
  const state = analyzer.analyze('EURUSD', '1m', candles);
  assert.equal(state.status, 'ACTIVE');
  assert.equal(state.bullishFVGs.length, 1);
  assert.equal(state.bearishFVGs.length, 0);
  const fvg = state.bullishFVGs[0];
  assert.equal(fvg.bottomPrice, 1.1);
  assert.equal(fvg.topPrice, 1.1005);
  assert.equal(fvg.epoch, 3);
  assert.equal(fvg.mitigated, false);
  assert.equal(fvg.id, 'EURUSD:1m:FVG:BULLISH:3');
  assert.equal(state.unmitigatedCount, 1);
});

test('FVG 2 — Bearish detection sets boundaries and epoch', () => {
  const analyzer = new FVGAnalyzer({ customTolerance: TOL });
  const candles: Candle[] = [
    createCandle(1, 1.102, 1.1025, 1.1015, 1.1015),
    createCandle(2, 1.1015, 1.1018, 1.099, 1.0995),
    createCandle(3, 1.0995, 1.1008, 1.0985, 1.099),
  ];
  const state = analyzer.analyze('EURUSD', '1m', candles);
  assert.equal(state.bearishFVGs.length, 1);
  assert.equal(state.bullishFVGs.length, 0);
  const fvg = state.bearishFVGs[0];
  assert.equal(fvg.topPrice, 1.1015);
  assert.equal(fvg.bottomPrice, 1.1008);
  assert.equal(fvg.epoch, 3);
  assert.equal(fvg.id, 'EURUSD:1m:FVG:BEARISH:3');
});

test('FVG 3 — Gaps at or below tolerance are filtered out', () => {
  const analyzer = new FVGAnalyzer({ customTolerance: TOL });
  const candles: Candle[] = [
    createCandle(1, 1.098, 1.1, 1.0975, 1.0985),
    createCandle(2, 1.0995, 1.1005, 1.099, 1.1002),
    createCandle(3, 1.1002, 1.101, 1.10005, 1.1008),
  ];
  const state = analyzer.analyze('EURUSD', '1m', candles);
  assert.equal(state.bullishFVGs.length, 0);
  assert.equal(state.bearishFVGs.length, 0);
  assert.equal(state.unmitigatedCount, 0);
  assert.equal(state.status, 'ACTIVE');
});

test('FVG 4 — Creation candle cannot mitigate its own FVG', () => {
  const analyzer = new FVGAnalyzer({ customTolerance: TOL });
  const candles: Candle[] = [
    createCandle(1, 1.098, 1.1, 1.0975, 1.0985),
    createCandle(2, 1.0985, 1.1015, 1.099, 1.101),
    createCandle(3, 1.101, 1.1025, 1.1005, 1.102),
  ];
  const state = analyzer.analyze('EURUSD', '1m', candles);
  assert.equal(state.bullishFVGs.length, 1);
  assert.equal(state.bullishFVGs[0].mitigated, false);
  assert.equal(state.bullishFVGs[0].mitigationEpoch, undefined);
});

test('FVG 5 — Full-fill at the exact bottom boundary mitigates', () => {
  const analyzer = new FVGAnalyzer({ customTolerance: TOL });
  const candles: Candle[] = [
    createCandle(1, 1.098, 1.1, 1.0975, 1.0985),
    createCandle(2, 1.0985, 1.1015, 1.0995, 1.101),
    createCandle(3, 1.101, 1.1025, 1.1005, 1.102),
    createCandle(4, 1.102, 1.1021, 1.1, 1.1002),
  ];
  const state = analyzer.analyze('EURUSD', '1m', candles);
  const fvg = state.bullishFVGs[0];
  assert.equal(fvg.mitigated, true);
  assert.equal(fvg.mitigationEpoch, 4);
  assert.equal(state.unmitigatedCount, 0);
});

test('FVG 6 — Trading into the gap without reaching the bottom is not a fill', () => {
  const analyzer = new FVGAnalyzer({ customTolerance: TOL });
  const candles: Candle[] = [
    createCandle(1, 1.098, 1.1, 1.0975, 1.0985),
    createCandle(2, 1.0985, 1.1015, 1.0995, 1.101),
    createCandle(3, 1.101, 1.1025, 1.1005, 1.102),
    createCandle(4, 1.102, 1.1022, 1.1002, 1.1005),
  ];
  const state = analyzer.analyze('EURUSD', '1m', candles);
  const fvg = state.bullishFVGs[0];
  assert.equal(fvg.mitigated, false);
  assert.equal(state.unmitigatedCount, 1);
});

test('FVG 7 — Bearish full-fill at the exact top boundary mitigates', () => {
  const analyzer = new FVGAnalyzer({ customTolerance: TOL });
  const candles: Candle[] = [
    createCandle(1, 1.102, 1.1025, 1.1015, 1.1015),
    createCandle(2, 1.1015, 1.1018, 1.099, 1.0995),
    createCandle(3, 1.0995, 1.1008, 1.0985, 1.099),
    createCandle(4, 1.099, 1.1015, 1.0988, 1.1012),
  ];
  const state = analyzer.analyze('EURUSD', '1m', candles);
  const fvg = state.bearishFVGs[0];
  assert.equal(fvg.mitigated, true);
  assert.equal(fvg.mitigationEpoch, 4);
});

test('FVG 8 — Forming candle is ignored (closed-candle only)', () => {
  const analyzer = new FVGAnalyzer({ customTolerance: TOL });
  const candles: Candle[] = [
    createCandle(1, 1.098, 1.1, 1.0975, 1.0985),
    createCandle(2, 1.0985, 1.1015, 1.0995, 1.101),
    createCandle(3, 1.101, 1.1025, 1.1005, 1.102),
    createCandle(4, 1.102, 1.1021, 1.09, 1.09, false),
  ];
  const state = analyzer.analyze('EURUSD', '1m', candles);
  assert.equal(state.bullishFVGs.length, 1);
  assert.equal(state.bullishFVGs[0].mitigated, false);
});

test('FVG 9 — Symbol isolation (ids scoped per pair)', () => {
  const analyzer = new FVGAnalyzer({ customTolerance: TOL });
  const eur: Candle[] = [
    createCandle(1, 1.098, 1.1, 1.0975, 1.0985),
    createCandle(2, 1.0985, 1.1015, 1.0995, 1.101),
    createCandle(3, 1.101, 1.1025, 1.1005, 1.102),
  ];
  const gbp: Candle[] = [
    createCandle(1, 200, 210, 198, 205),
    createCandle(2, 205, 215, 209, 214),
    createCandle(3, 214, 220, 210.5, 219),
  ];
  const eurState = analyzer.analyze('EURUSD', '1m', eur);
  const gbpState = analyzer.analyze('GBPUSD', '1m', gbp);
  assert.equal(eurState.bullishFVGs[0].id.startsWith('EURUSD:1m:'), true);
  assert.equal(gbpState.bullishFVGs[0].id.startsWith('GBPUSD:1m:'), true);
  assert.equal(eurState.symbol, 'EURUSD');
  assert.equal(gbpState.timeframe, '1m');
});

test('FVG 10 — Insufficient candles yields WAITING FOR DATA', () => {
  const analyzer = new FVGAnalyzer({ customTolerance: TOL });
  const state = analyzer.analyze('EURUSD', '1m', [
    createCandle(1, 1.098, 1.1, 1.0975, 1.0985),
    createCandle(2, 1.0985, 1.1015, 1.0995, 1.101),
  ]);
  assert.equal(state.status, 'WAITING FOR DATA');
  assert.equal(state.bullishFVGs.length, 0);
});
