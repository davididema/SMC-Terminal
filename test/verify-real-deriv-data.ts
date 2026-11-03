import { DerivWebSocketClient, ConnectionStatus } from '../lib/deriv/websocket';
import { CandleManager, Candle, Timeframe, TickData, TIMEFRAMES, TIMEFRAME_SECONDS } from '../lib/deriv/candles';
import { getSymbolConfig, InstrumentCategory } from '../lib/deriv/symbols';
import { SMCEngine } from '../lib/analysis/smc';
import { SignalEngine } from '../lib/signals/signal-engine';
import { evaluateSignalForPair } from '../lib/signals/signal-eval';
import { StructureBreakDetector } from '../lib/analysis/structure-breaks';
import type { HistoryCandleData } from '../lib/deriv/history-requests';
import WebSocket from 'ws';

import {
  CheckOutcome,
  CheckStatus,
  checkCandleIntegrity,
  checkMarketStructure,
  checkStructureBreaks,
  checkLiquidity,
  checkFvg,
  checkOrderBlocks,
  checkPremiumDiscount,
  checkSignalEvaluation,
  minimumSwingConfirmationBars,
  MIN_ANALYSIS_HISTORY,
} from './verification-lib';

// Ensure global WebSocket is available in Node for DerivWebSocketClient.
if (typeof (globalThis as any).WebSocket === 'undefined') {
  (globalThis as any).WebSocket = WebSocket;
}

// --- Configuration -------------------------------------------------------

const TEST_SYMBOLS = [
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'AUDUSD',
  'XAUUSD',
  'V75',
  'V10',
  'BOOM1000',
  'CRASH1000',
];

// Stage 5: the full supported timeframe matrix, including 30m.
const TEST_TIMEFRAMES: Timeframe[] = TIMEFRAMES;

const HISTORY_COUNT = 200;
const HISTORY_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 15000;

// Bounded live checks.
const LIVE_SYMBOL = 'V75';
const LIVE_TIMEFRAME: Timeframe = '1m';
const LIVE_BUDGET_MS = 75000; // cover at least one 1m rollover
const LIVE_MIN_TICKS = 5;
const RECONNECT_TIMEOUT_MS = 20000;
const POST_RECONNECT_TICK_TIMEOUT_MS = 20000;

const COMPONENT_NAMES = [
  'marketStructure',
  'structureBreaks',
  'liquidity',
  'fvg',
  'orderBlocks',
  'premiumDiscount',
  'signalEvaluation',
] as const;
type ComponentName = (typeof COMPONENT_NAMES)[number];

// --- Small helpers -------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForStatus(
  client: DerivWebSocketClient,
  target: ConnectionStatus,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    if (client.getStatus() === target) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      unsub();
      resolve(false);
    }, timeoutMs);
    const unsub = client.onStatusChange((status) => {
      if (status === target) {
        clearTimeout(timer);
        unsub();
        resolve(true);
      }
    });
  });
}

function fetchHistory(
  client: DerivWebSocketClient,
  symbol: string,
  timeframe: Timeframe,
  count: number
): Promise<{ candles: HistoryCandleData[]; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ candles: [], timedOut: true });
    }, HISTORY_TIMEOUT_MS);

    client.fetchCandlesHistory(symbol, timeframe, count, (_symbol, _timeframe, candles) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ candles, timedOut: false });
    });
  });
}

function rawToCandles(raw: HistoryCandleData[]): Candle[] {
  // Raw Deriv history has no close flag. The lib tolerates a single leading
  // partial candle and treats the remainder as period-aligned.
  return raw.map((c) => ({
    epoch: c.epoch,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: 0,
    isClosed: true,
  }));
}

// --- Result aggregation types -------------------------------------------

interface ComponentTally {
  pass: number;
  skipped: number;
  fail: number;
}

interface PairResult {
  symbol: string;
  timeframe: Timeframe;
  status: CheckStatus;
  rawCount: number;
  closedCount: number;
  swings: number;
  breaks: number;
  bias: string;
  exercised: ComponentName[];
  failures: string[];
  notes: string[];
}

const componentTally: Record<ComponentName, ComponentTally> = Object.fromEntries(
  COMPONENT_NAMES.map((name) => [name, { pass: 0, skipped: 0, fail: 0 }])
) as Record<ComponentName, ComponentTally>;

// --- Pair verification ---------------------------------------------------

function verifyPair(
  symbol: string,
  timeframe: Timeframe,
  raw: HistoryCandleData[],
  candleManager: CandleManager,
  smcEngine: SMCEngine,
  signalEngine: SignalEngine
): PairResult {
  const category: InstrumentCategory = getSymbolConfig(symbol)?.category ?? 'Forex';
  const periodSeconds = TIMEFRAME_SECONDS[timeframe];

  candleManager.seedHistory(symbol, timeframe, raw);
  const closed = candleManager.getHistory(symbol, timeframe);
  const analysis = smcEngine.analyze(symbol, timeframe, closed);

  const failures: string[] = [];
  const notes: string[] = [];
  const exercised: ComponentName[] = [];

  // Stage 2: candle integrity on both raw and processed history.
  const rawIntegrity = checkCandleIntegrity(rawToCandles(raw), {
    timeframe,
    periodSeconds,
    category,
    expectClosed: false,
  });
  const closedIntegrity = checkCandleIntegrity(closed, {
    timeframe,
    periodSeconds,
    category,
    expectClosed: true,
  });
  failures.push(...rawIntegrity.failures, ...closedIntegrity.failures);
  notes.push(...rawIntegrity.notes, ...closedIntegrity.notes);

  // Stage 3: component invariants.
  const componentOutcomes: Array<{ name: ComponentName; outcome: CheckOutcome }> = [
    {
      name: 'marketStructure',
      outcome: checkMarketStructure(symbol, timeframe, closed, analysis.marketStructure),
    },
    {
      name: 'structureBreaks',
      outcome: checkStructureBreaks(
        symbol,
        timeframe,
        closed,
        analysis.marketStructure.swings,
        analysis.marketStructure
      ),
    },
    {
      name: 'liquidity',
      outcome: checkLiquidity(symbol, timeframe, closed, analysis.marketStructure, analysis.liquidity),
    },
    { name: 'fvg', outcome: checkFvg(symbol, timeframe, closed, analysis.fvg) },
    {
      name: 'orderBlocks',
      outcome: checkOrderBlocks(symbol, timeframe, closed, analysis.orderBlocks),
    },
    {
      name: 'premiumDiscount',
      outcome: checkPremiumDiscount(analysis.marketStructure, closed, analysis.zone),
    },
    {
      name: 'signalEvaluation',
      outcome: checkSignalEvaluation(
        evaluateSignalForPair(candleManager, smcEngine, signalEngine, symbol, timeframe)
      ),
    },
  ];

  for (const { name, outcome } of componentOutcomes) {
    if (outcome.status === 'FAIL') {
      componentTally[name].fail += 1;
      failures.push(...outcome.failures.map((f) => `${name}: ${f}`));
    } else if (outcome.status === 'PASS') {
      componentTally[name].pass += 1;
      exercised.push(name);
    } else {
      componentTally[name].skipped += 1;
    }
    notes.push(...outcome.notes.map((n) => `${name}: ${n}`));
  }

  // Stage 1: hardened status. A pair is only PASS when history is sufficient,
  // integrity holds, no invariant failed, and at least one component was
  // actually exercised. Empty/insufficient/no-exercise pairs are SKIPPED, never PASS.
  let status: CheckStatus;
  if (failures.length > 0) {
    status = 'FAIL';
  } else if (closed.length === 0) {
    status = 'SKIPPED';
    notes.push('no closed candles returned');
  } else if (closed.length < MIN_ANALYSIS_HISTORY) {
    status = 'SKIPPED';
    notes.push(`insufficient closed history (${closed.length} < ${MIN_ANALYSIS_HISTORY})`);
  } else if (exercised.length === 0) {
    status = 'SKIPPED';
    notes.push('no SMC component produced an instance to validate');
  } else {
    status = 'PASS';
  }

  return {
    symbol,
    timeframe,
    status,
    rawCount: raw.length,
    closedCount: closed.length,
    swings: analysis.marketStructure.swings.length,
    breaks: analysis.marketStructure.breaks.length,
    bias: analysis.marketStructure.structuralBias,
    exercised,
    failures: Array.from(new Set(failures)),
    notes: Array.from(new Set(notes)),
  };
}

// --- Stage 3 (cont.): real-data batch vs incremental break equivalence ---

function checkIncrementalBreaks(
  symbol: string,
  timeframe: Timeframe,
  closed: Candle[],
  swings: import('../lib/analysis/market-structure').SwingPoint[]
): { ok: boolean; detail: string } {
  const incremental = new StructureBreakDetector();
  let incState = incremental.analyze(symbol, timeframe, closed, swings, 'NEUTRAL');
  for (let i = 1; i <= closed.length; i++) {
    incState = incremental.analyze(symbol, timeframe, closed.slice(0, i), swings, 'NEUTRAL');
  }

  const batch = new StructureBreakDetector();
  const batchState = batch.analyze(symbol, timeframe, closed, swings, 'NEUTRAL');

  const ok =
    batchState.breaks.length === incState.breaks.length &&
    batchState.breaks.every((b, idx) => b.id === incState.breaks[idx]?.id);
  return {
    ok,
    detail: `batch=${batchState.breaks.length} incremental=${incState.breaks.length}`,
  };
}

// --- Stage 4: bounded live tick / rollover / reconnect -------------------

interface LiveResult {
  status: CheckStatus;
  failures: string[];
  notes: string[];
}

async function runLiveVerification(client: DerivWebSocketClient): Promise<LiveResult> {
  const failures: string[] = [];
  const notes: string[] = [];
  const candleManager = new CandleManager(500);

  const ticks: TickData[] = [];
  const closedCandles: Candle[] = [];

  const unsubTick = client.onTick((tick) => {
    if (tick.symbol !== LIVE_SYMBOL) return;
    ticks.push(tick);
    candleManager.processTick(tick);
  });
  const unsubClose = candleManager.onCandleClose((symbol, timeframe, candle) => {
    if (symbol === LIVE_SYMBOL && timeframe === LIVE_TIMEFRAME) {
      closedCandles.push(candle);
    }
  });

  client.subscribeTicks(LIVE_SYMBOL);

  // Collect ticks until we see at least one 1m rollover or the budget elapses.
  const startedAt = Date.now();
  while (Date.now() - startedAt < LIVE_BUDGET_MS && closedCandles.length === 0) {
    await sleep(250);
  }

  // Tick validity.
  if (ticks.length < LIVE_MIN_TICKS) {
    unsubTick();
    unsubClose();
    client.unsubscribeTicks(LIVE_SYMBOL);
    return {
      status: 'PENDING',
      failures,
      notes: [...notes, `only ${ticks.length} ticks received (need >= ${LIVE_MIN_TICKS})`],
    };
  }

  for (const tick of ticks) {
    if (!Number.isFinite(tick.price) || tick.price <= 0) {
      failures.push(`non-positive/non-finite live price ${tick.price}`);
      break;
    }
    if (!Number.isFinite(tick.epoch) || tick.epoch <= 0) {
      failures.push(`non-positive/non-finite tick epoch ${tick.epoch}`);
      break;
    }
    if (tick.symbol !== LIVE_SYMBOL) {
      failures.push(`tick symbol ${tick.symbol} != ${LIVE_SYMBOL}`);
      break;
    }
  }
  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i].epoch < ticks[i - 1].epoch) {
      failures.push(`tick epochs not monotonic at index ${i}`);
      break;
    }
  }

  // Feed health must reach LIVE for a symbol that is actually ticking.
  const feed = client.getFeedStatus(LIVE_SYMBOL);
  if (feed?.state !== 'LIVE') {
    failures.push(`feed state is ${feed?.state ?? 'undefined'}, expected LIVE`);
  }

  // Forming candle must be internally consistent.
  const forming = candleManager.getCurrentCandle(LIVE_SYMBOL, LIVE_TIMEFRAME);
  if (forming) {
    const integrity = checkCandleIntegrity([forming], {
      timeframe: LIVE_TIMEFRAME,
      periodSeconds: TIMEFRAME_SECONDS[LIVE_TIMEFRAME],
      category: getSymbolConfig(LIVE_SYMBOL)?.category ?? 'Synthetics',
      expectClosed: false,
    });
    failures.push(...integrity.failures);
    if (forming.volume < 1) failures.push(`forming candle volume ${forming.volume} < 1`);
  } else {
    notes.push('no forming candle observed in the live window');
  }

  // Tick-to-candle rollover.
  if (closedCandles.length === 0) {
    notes.push('no 1m candle close observed within the live budget');
  } else {
    const rolloverIntegrity = checkCandleIntegrity(closedCandles, {
      timeframe: LIVE_TIMEFRAME,
      periodSeconds: TIMEFRAME_SECONDS[LIVE_TIMEFRAME],
      category: getSymbolConfig(LIVE_SYMBOL)?.category ?? 'Synthetics',
      expectClosed: true,
    });
    failures.push(...rolloverIntegrity.failures);
    notes.push(`observed ${closedCandles.length} closed 1m candle(s) via rollover`);
  }

  // Reconnect: force a socket cycle and require the feed to come back with ticks.
  const preReconnectTicks = ticks.length;
  client.disconnect();
  const wentDown = await waitForStatus(client, 'DISCONNECTED', RECONNECT_TIMEOUT_MS);
  if (!wentDown) failures.push('client did not reach DISCONNECTED after disconnect()');

  client.connect();
  const cameUp = await waitForStatus(client, 'CONNECTED', RECONNECT_TIMEOUT_MS);
  if (!cameUp) {
    failures.push('client did not reconnect to CONNECTED');
  } else {
    // desiredSubscriptions persists, so the socket resubscribes automatically.
    const deadline = Date.now() + POST_RECONNECT_TICK_TIMEOUT_MS;
    while (Date.now() < deadline && ticks.length === preReconnectTicks) {
      await sleep(250);
    }
    if (ticks.length === preReconnectTicks) {
      failures.push('no ticks resumed after reconnect');
    } else {
      notes.push(`ticks resumed after reconnect (+${ticks.length - preReconnectTicks})`);
    }
  }

  // Cleanup.
  unsubTick();
  unsubClose();
  client.unsubscribeTicks(LIVE_SYMBOL);

  const status: CheckStatus =
    failures.length > 0 ? 'FAIL' : closedCandles.length === 0 ? 'PENDING' : 'PASS';
  return { status, failures, notes };
}

// --- Reporting -----------------------------------------------------------

function statusTag(status: CheckStatus): string {
  switch (status) {
    case 'PASS':
      return '[PASS]';
    case 'FAIL':
      return '[FAIL]';
    case 'SKIPPED':
      return '[SKIP]';
    default:
      return '[PEND]';
  }
}

async function run(): Promise<void> {
  console.log('================================================================');
  console.log('REAL DERIV DATA VERIFICATION — HARDENED (STAGES 1-5)');
  console.log('================================================================');
  console.log(`Swing confirmation bars (+1): ${minimumSwingConfirmationBars({ leftBars: 2, rightBars: 2 })}`);
  console.log(`Minimum analysis history: ${MIN_ANALYSIS_HISTORY} closed candles`);
  console.log(`Matrix: ${TEST_SYMBOLS.length} symbols x ${TEST_TIMEFRAMES.length} timeframes = ${TEST_SYMBOLS.length * TEST_TIMEFRAMES.length} pairs`);
  console.log(`Timeframes: ${TEST_TIMEFRAMES.join(', ')}\n`);

  const client = new DerivWebSocketClient();
  const candleManager = new CandleManager(500);
  const smcEngine = new SMCEngine();
  const signalEngine = new SignalEngine();

  client.connect();
  const connected = await waitForStatus(client, 'CONNECTED', CONNECT_TIMEOUT_MS);
  if (!connected) {
    console.error('Fatal: could not connect to Deriv WebSocket.');
    client.disconnect();
    process.exit(1);
  }
  console.log('Connected to Deriv WebSocket. Fetching real candles...\n');

  const results: PairResult[] = [];
  let bestPair: { symbol: string; timeframe: Timeframe; closed: Candle[]; swings: import('../lib/analysis/market-structure').SwingPoint[] } | null = null;
  let bestBreaks = -1;

  for (const symbol of TEST_SYMBOLS) {
    for (const timeframe of TEST_TIMEFRAMES) {
      const { candles, timedOut } = await fetchHistory(client, symbol, timeframe, HISTORY_COUNT);

      if (timedOut) {
        results.push({
          symbol,
          timeframe,
          status: 'PENDING',
          rawCount: 0,
          closedCount: 0,
          swings: 0,
          breaks: 0,
          bias: 'TIMEOUT',
          exercised: [],
          failures: [],
          notes: ['history request timed out'],
        });
        console.log(`${statusTag('PENDING')} ${symbol.padEnd(9)} [${timeframe.padEnd(3)}] history request timed out`);
        continue;
      }

      const result = verifyPair(symbol, timeframe, candles, candleManager, smcEngine, signalEngine);
      results.push(result);

      const counts =
        `raw=${String(result.rawCount).padStart(3)} closed=${String(result.closedCount).padStart(3)} ` +
        `swings=${String(result.swings).padStart(2)} breaks=${String(result.breaks).padStart(2)} ` +
        `bias=${result.bias.padEnd(8)}`;
      console.log(
        `${statusTag(result.status)} ${symbol.padEnd(9)} [${timeframe.padEnd(3)}] ${counts} ` +
          `components=[${result.exercised.join(',') || 'none'}]`
      );
      for (const failure of result.failures) {
        console.log(`         FAIL: ${failure}`);
      }

      if (result.closedCount >= MIN_ANALYSIS_HISTORY && result.breaks > bestBreaks) {
        const closed = candleManager.getHistory(symbol, timeframe);
        bestPair = {
          symbol,
          timeframe,
          closed,
          swings: smcEngine.analyze(symbol, timeframe, closed).marketStructure.swings,
        };
        bestBreaks = result.breaks;
      }
    }
  }

  // Incremental break equivalence on the richest break pair.
  let incrementalResult: { ok: boolean; detail: string } | null = null;
  if (bestPair) {
    incrementalResult = checkIncrementalBreaks(
      bestPair.symbol,
      bestPair.timeframe,
      bestPair.closed,
      bestPair.swings
    );
    console.log(
      `\nIncremental BOS/CHoCH equivalence on ${bestPair.symbol}[${bestPair.timeframe}]: ` +
        `${incrementalResult.ok ? 'OK' : 'MISMATCH'} (${incrementalResult.detail})`
    );
  }

  // Live verification (bounded).
  console.log('\n--- Live tick / rollover / reconnect verification ---');
  const live = await runLiveVerification(client);
  console.log(`${statusTag(live.status)} live ${LIVE_SYMBOL}[${LIVE_TIMEFRAME}]`);
  for (const note of live.notes) console.log(`         note: ${note}`);
  for (const failure of live.failures) console.log(`         FAIL: ${failure}`);

  client.disconnect();

  // Summary.
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIPPED').length;
  const pending = results.filter((r) => r.status === 'PENDING').length;

  console.log('\n================================================================');
  console.log('COMPONENT COVERAGE (over evaluated pairs)');
  console.log('================================================================');
  for (const name of COMPONENT_NAMES) {
    const t = componentTally[name];
    console.log(`  ${name.padEnd(16)} PASS=${String(t.pass).padStart(3)} SKIPPED=${String(t.skipped).padStart(3)} FAIL=${t.fail}`);
  }

  console.log('\n================================================================');
  console.log('SUMMARY');
  console.log('================================================================');
  console.log(`  Matrix pairs: ${results.length}  |  PASS=${pass}  FAIL=${fail}  SKIPPED=${skipped}  PENDING=${pending}`);
  if (incrementalResult) {
    console.log(`  Incremental break equivalence: ${incrementalResult.ok ? 'OK' : 'MISMATCH'}`);
  }
  console.log(`  Live verification: ${live.status}`);

  const skippedOrPending = skipped + pending;
  if (skippedOrPending > 0) {
    console.log(`\n  Note: ${skippedOrPending} pair(s) SKIPPED/PENDING (insufficient history, no component exercised, timeout, or no live rollover).`);
    console.log('  These are reported honestly and are NOT counted as PASS.');
  }

  const hadFailure =
    fail > 0 ||
    live.status === 'FAIL' ||
    (incrementalResult !== null && !incrementalResult.ok);

  console.log('================================================================');
  if (!hadFailure) {
    console.log('VERIFICATION COMPLETE: no failures detected.');
  } else {
    console.log('VERIFICATION FAILED: one or more checks failed.');
  }
  console.log('================================================================');

  process.exit(hadFailure ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
