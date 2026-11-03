/**
 * Phase 3A — D5: a recovery gap that is wider than the provider's limit.
 *
 * The confirmed defect: the provider delivers at most 5000 candles per
 * history request, and the recovery path issued exactly ONE request per gap.
 * A gap that spans more than 5000 periods can therefore never be bridged: the
 * oldest required period is never delivered, the completeness check (D3)
 * refuses the pair, and the pair stays blocked until its bounded budget is
 * spent. The project was left with an unrecoverable state rather than a
 * diagnosed one.
 *
 * These tests use synthetic epochs and an in-memory stand-in for the provider.
 * No socket, no network, and no fabricated market data: the candles are
 * deterministic fixtures whose only purpose is to describe periods.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CandleManager,
  MAX_RECOVERY_HISTORY_COUNT,
  findMissingRequiredPeriods,
  type RecoveryRequirement,
  type TickData,
  type Timeframe,
} from '../lib/deriv/candles';
import {
  MAX_RECOVERY_CHUNKS,
  RecoveryChunkCoordinator,
  planRecoveryChunks,
  type RecoveryCycleResult,
} from '../lib/deriv/history-chunks';
import { HistoryRecoveryController } from '../lib/deriv/history-recovery';
import {
  LiveAcquisitionAdapter,
  type MonitoringMarketSource,
} from '../lib/monitoring/live-acquisition';
import type { ConnectionStatus } from '../lib/deriv/websocket';
import type { FeedStatus } from '../lib/deriv/feed';
import type { HistoryRequestCallback } from '../lib/deriv/history-requests';
import type {
  HistoryCandleData,
  HistoryRequestOutcome,
} from '../lib/deriv/history-requests';

// --- The scenario --------------------------------------------------------------
// A tick inside the 1m period that starts at epoch 60 is observed, the
// connection then drops, and the first tick after the reconnect lands in the
// 1m period that starts at `ANCHOR + periods * 60`. The required periods are
// therefore ANCHOR .. liveEpoch - 60.
const PERIOD = 60;
const ANCHOR = 60;

function tick(symbol: string, price: number, epoch: number): TickData {
  return { symbol, derivSymbol: symbol, price, epoch };
}

function candle(epoch: number, close = 1.1): HistoryCandleData {
  return { epoch, open: close, high: close, low: close, close };
}

/** The live edge of a gap that spans `periods` 1m periods. */
function liveEpochOf(periods: number): number {
  return ANCHOR + periods * PERIOD;
}

/**
 * Open a gap of `periods` 1m periods for a pair: the pair observes the
 * anchor period, loses the connection, and resumes at the live edge.
 */
function interruptPair(
  manager: CandleManager,
  symbol: string,
  periods: number
): void {
  manager.processTick(tick(symbol, 1.1, ANCHOR + 30));
  manager.markDiscontinuity(symbol);
  manager.processTick(tick(symbol, 1.2, liveEpochOf(periods) + 30));
}

/** The requirement of a gap that spans `periods` 1m periods. */
function requirement(periods: number): RecoveryRequirement {
  return {
    recoveryEpoch: ANCHOR,
    interruptedEpoch: ANCHOR,
    liveEpoch: liveEpochOf(periods),
    periodSeconds: PERIOD,
    requiredCount: periods + 1,
  };
}

/**
 * How the provider interprets the end marker of a window.
 *
 * - `inclusive`: the window ends ON the requested epoch (the newest candle is
 *   the requested epoch).
 * - `exclusive`: the window ends BEFORE the requested epoch (the newest candle
 *   is the period before it).
 *
 * The recovery must not depend on either interpretation.
 */
type EndSemantics = 'inclusive' | 'exclusive';

interface ProviderRequest {
  symbol: string;
  timeframe: Timeframe;
  count: number;
  end: number | null;
}

/** An in-memory stand-in for the provider's bounded history window. */
class FakeProvider {
  public readonly requests: ProviderRequest[] = [];
  /** When true, a request is recorded but not answered. */
  public defer = false;
  /** The epoch the provider omits (a hole inside a delivered window). */
  public skip: number | null = null;
  /** The epoch the provider delivers with broken prices. */
  public broken: number | null = null;
  /** The outcome the provider delivers instead of candles. */
  public outcome: HistoryRequestOutcome = 'success';

  private readonly liveEpoch: number;
  private readonly semantics: EndSemantics;
  private readonly deferred: Array<() => void> = [];

  constructor(liveEpoch: number, semantics: EndSemantics = 'inclusive') {
    this.liveEpoch = liveEpoch;
    this.semantics = semantics;
  }

  public fetch(
    symbol: string,
    timeframe: Timeframe,
    count: number,
    end: number | null,
    callback: (candles: HistoryCandleData[], outcome: HistoryRequestOutcome) => void
  ): void {
    this.requests.push({ symbol, timeframe, count, end });
    if (this.defer) {
      this.deferred.push(() => this.deliver(symbol, timeframe, count, end, callback));
      return;
    }
    this.deliver(symbol, timeframe, count, end, callback);
  }

  /** Deliver every deferred response (late or superseded responses). */
  public flushDeferred(): void {
    const pending = [...this.deferred];
    this.deferred.length = 0;
    for (const deliver of pending) deliver();
  }

  /** Deliver only the oldest deferred response (late or superseded responses). */
  public flushNext(): void {
    const deliver = this.deferred.shift();
    if (!deliver) return;
    deliver();
  }

  /** The epochs the provider delivered for a request. */
  public epochsOf(request: ProviderRequest): number[] {
    const newest = request.end === null ? this.liveEpoch : request.end;
    const oldest =
      this.semantics === 'inclusive'
        ? newest - (request.count - 1) * PERIOD
        : newest - request.count * PERIOD;
    const last = this.semantics === 'inclusive' ? newest : newest - PERIOD;
    const epochs: number[] = [];
    for (let epoch = oldest; epoch <= last; epoch += PERIOD) {
      if (this.skip !== null && epoch === this.skip) continue;
      epochs.push(epoch);
    }
    return epochs;
  }

  private deliver(
    symbol: string,
    timeframe: Timeframe,
    count: number,
    end: number | null,
    callback: (candles: HistoryCandleData[], outcome: HistoryRequestOutcome) => void
  ): void {
    if (this.outcome !== 'success') {
      callback([], this.outcome);
      return;
    }
    const request: ProviderRequest = { symbol, timeframe, count, end };
    callback(
      this.epochsOf(request).map((epoch) =>
        epoch === this.broken
          ? { epoch, open: 1.2, high: 1.0, low: 1.1, close: 1.15 }
          : candle(epoch)
      ),
      'success'
    );
  }
}

interface Harness {
  manager: CandleManager;
  coordinator: RecoveryChunkCoordinator;
  controller: HistoryRecoveryController;
  provider: FakeProvider;
  results: RecoveryCycleResult[];
}

function createHarness(
  liveEpoch: number,
  options: {
    semantics?: EndSemantics;
    restartOnRetry?: boolean;
    maxAttempts?: number;
  } = {}
): Harness {
  const manager = new CandleManager(30000);
  const provider = new FakeProvider(liveEpoch, options.semantics ?? 'inclusive');
  const results: RecoveryCycleResult[] = [];
  const controller = new HistoryRecoveryController({
    policy: { maxAttempts: options.maxAttempts ?? 3, delayMs: 5 },
    canRetry: () => true,
    onRetry: (symbol, timeframe) => {
      if (options.restartOnRetry) coordinator.start(symbol, timeframe);
    },
  });
  const coordinator = new RecoveryChunkCoordinator({
    manager,
    controller,
    transport: {
      fetchHistoryWindow: (symbol, timeframe, count, end, callback) =>
        provider.fetch(symbol, timeframe, count, end, callback),
    },
    onCycleEnd: (result) => results.push(result),
  });
  return { manager, coordinator, controller, provider, results };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// =============================================================================================
// A — the gap is classified and every request stays inside the provider's limit
// =============================================================================================

test('D5 A1 — a gap is classified by its size, and the plan stays bounded', () => {
  const small = planRecoveryChunks(requirement(100));
  assert.equal(small.size, 'single-request', 'a narrow gap needs one request');
  assert.equal(small.requiredCount, 100, 'the number of required periods is exact');

  const chunked = planRecoveryChunks(requirement(8000));
  assert.equal(chunked.size, 'chunked', 'a wide gap needs several bounded requests');
  assert.equal(chunked.maxChunks, MAX_RECOVERY_CHUNKS, 'the number of requests is bounded');
  assert.equal(
    chunked.capacity,
    MAX_RECOVERY_CHUNKS * (MAX_RECOVERY_HISTORY_COUNT - 1),
    'the capacity matches the bounded budget'
  );

  const oversized = planRecoveryChunks(requirement(30000));
  assert.equal(
    oversized.size,
    'oversized',
    'a gap beyond the bounded budget is classified explicitly'
  );
  assert.equal(oversized.requiredCount, 30000, 'the required periods are reported');
});

test('D5 A2 — a gap that fits into one request is left to the ordinary path', () => {
  const harness = createHarness(liveEpochOf(100));
  interruptPair(harness.manager, 'EURUSD', 100);

  const start = harness.coordinator.start('EURUSD', '1m');
  assert.equal(start.kind, 'single-request', 'the ordinary path serves the gap');
  assert.equal(harness.provider.requests.length, 0, 'no chunked request is issued');
  assert.equal(harness.results.length, 0, 'no chunk cycle is reported');
});

test('D5 A3 — every chunked request stays inside the provider limit', () => {
  const harness = createHarness(liveEpochOf(8000));
  interruptPair(harness.manager, 'EURUSD', 8000);

  harness.coordinator.start('EURUSD', '1m');

  assert.ok(harness.provider.requests.length > 0, 'the gap is served by requests');
  assert.equal(
    harness.provider.requests.every((r) => r.count <= MAX_RECOVERY_HISTORY_COUNT),
    true,
    'no request asks for more than the provider delivers'
  );
  assert.equal(
    harness.provider.requests.every((r) => r.count >= 1),
    true,
    'no request asks for nothing'
  );
  assert.equal(
    harness.provider.requests.length <= MAX_RECOVERY_CHUNKS,
    true,
    'the number of requests is bounded'
  );
});

// =============================================================================================
// B — a gap that one request cannot bridge is bridged by bounded windows
// =============================================================================================

test('D5 B1 — a wide gap is bridged and the pair is released', () => {
  const harness = createHarness(liveEpochOf(8000));
  interruptPair(harness.manager, 'EURUSD', 8000);

  const start = harness.coordinator.start('EURUSD', '1m');
  assert.equal(start.kind, 'chunked', 'the gap is served by the chunked path');

  assert.equal(
    harness.manager.isRecoveryRequired('EURUSD', '1m'),
    false,
    'the pair is whole again'
  );
  assert.equal(harness.results.length, 1, 'exactly one cycle is reported');
  assert.equal(harness.results[0].recoveryComplete, true, 'the cycle completed the recovery');
  assert.equal(harness.results[0].outcome, 'success', 'the cycle is a success');
  assert.equal(harness.results[0].recoveryPending, false, 'the pair is no longer blocked');
  assert.ok(
    harness.results[0].requestCount <= MAX_RECOVERY_CHUNKS,
    'the cycle stayed inside its bounded request budget'
  );

  const history = harness.manager.getHistory('EURUSD', '1m');
  assert.equal(
    history.some((c) => c.epoch === ANCHOR),
    true,
    'the oldest required period was re-derived'
  );
  assert.equal(
    history.every((c) => c.isClosed),
    true,
    'every recovered period is a closed candle'
  );
  assert.equal(
    findMissingRequiredPeriods(
      harness.manager.getRecoveryRequirement('EURUSD', '1m') ?? requirement(8000),
      history.map((c) => c.epoch)
    ).length,
    0,
    'no required period is missing'
  );
});

test('D5 B2 — the windows overlap, so no required period can be skipped', () => {
  const harness = createHarness(liveEpochOf(8000));
  interruptPair(harness.manager, 'EURUSD', 8000);

  harness.coordinator.start('EURUSD', '1m');

  assert.equal(harness.provider.requests.length, 2, 'the gap needed two bounded windows');
  assert.equal(harness.provider.requests[0].end, null, 'the first window asks for the newest');

  const firstWindow = harness.provider.epochsOf(harness.provider.requests[0]);
  const oldestDelivered = firstWindow[0];
  assert.equal(
    harness.provider.requests[1].end,
    oldestDelivered,
    'the next window ends at the oldest period the previous one delivered'
  );

  const secondWindow = harness.provider.epochsOf(harness.provider.requests[1]);
  assert.equal(
    secondWindow[secondWindow.length - 1],
    oldestDelivered,
    'the windows overlap by exactly one period'
  );
});

test('D5 B3 — the chain does not depend on the provider end semantics', () => {
  for (const semantics of ['inclusive', 'exclusive'] as const) {
    const harness = createHarness(liveEpochOf(8000), { semantics });
    interruptPair(harness.manager, 'EURUSD', 8000);

    harness.coordinator.start('EURUSD', '1m');

    assert.equal(
      harness.manager.isRecoveryRequired('EURUSD', '1m'),
      false,
      `the pair is whole again with '${semantics}' end semantics`
    );
    assert.equal(
      harness.results[0]?.recoveryComplete,
      true,
      `the cycle completed the recovery with '${semantics}' end semantics`
    );
  }
});

// =============================================================================================
// C — a gap beyond the bounded budget fails closed, and it is diagnosed
// =============================================================================================

test('D5 C1 — an oversized gap issues no request and keeps the pair blocked', () => {
  const periods = 30000;
  const harness = createHarness(liveEpochOf(periods));
  interruptPair(harness.manager, 'EURUSD', periods);

  const start = harness.coordinator.start('EURUSD', '1m');
  assert.equal(start.kind, 'oversized', 'the gap is classified');
  assert.equal(
    harness.provider.requests.length,
    0,
    'the impossible window is never requested'
  );
  assert.equal(
    harness.manager.isRecoveryRequired('EURUSD', '1m'),
    true,
    'the pair stays blocked instead of running on a hole'
  );

  assert.equal(harness.results.length, 1, 'the oversized gap is reported');
  assert.equal(harness.results[0].oversized, true, 'the result is classified as oversized');
  assert.equal(harness.results[0].recoveryComplete, false, 'the gap is not bridged');
  assert.equal(harness.results[0].recoveryPending, true, 'the pair is still blocked');
  assert.equal(harness.results[0].requiredCount, periods, 'the size of the gap is reported');
  assert.equal(
    harness.controller.attemptsFor('EURUSD', '1m'),
    1,
    'the bounded budget is consumed instead of being reset'
  );
});

// =============================================================================================
// D — the D3 completeness rules apply to the COMBINED history
// =============================================================================================

test('D5 D1 — a hole inside the combined history keeps the pair blocked', () => {
  // A continuous synthetic index has no documented closure, so every absent
  // period is a genuine data gap.
  const harness = createHarness(liveEpochOf(8000));
  // The provider omits one period in the middle of its newest window.
  harness.provider.skip = liveEpochOf(8000) - 2500 * PERIOD;
  interruptPair(harness.manager, 'V75', 8000);

  harness.coordinator.start('V75', '1m');

  assert.equal(
    harness.manager.isRecoveryRequired('V75', '1m'),
    true,
    'a history with a hole is never released'
  );
  assert.equal(harness.results.length, 1, 'the cycle is reported');
  assert.equal(harness.results[0].recoveryComplete, false, 'the cycle did not complete');
  assert.equal(harness.results[0].outcome, 'failure', 'the cycle is a failure');
  assert.equal(
    harness.manager.getHistory('V75', '1m').some((c) => c.epoch === harness.provider.skip),
    false,
    'the skipped period is not admitted'
  );
});

test('D5 D2 — a hole beyond the capacity of a single response is still found', () => {
  const req = requirement(8000);
  const epochs: number[] = [];
  for (let i = 0; i < 8000; i++) epochs.push(ANCHOR + i * PERIOD);
  const hole = ANCHOR + 6000 * PERIOD;

  assert.equal(
    findMissingRequiredPeriods(req, epochs).length,
    0,
    'a complete sequence has no missing period'
  );
  assert.deepEqual(
    findMissingRequiredPeriods(
      req,
      epochs.filter((epoch) => epoch !== hole)
    ),
    [hole],
    'the hole is found even though it lies beyond a single response capacity'
  );
});

// =============================================================================================
// E — the D2 budget rules survive the chunked path
// =============================================================================================

test('D5 E1 — a failing chunk cycle consumes the bounded budget and never resets it', async () => {
  const harness = createHarness(liveEpochOf(8000), { restartOnRetry: true });
  harness.provider.outcome = 'failure';
  interruptPair(harness.manager, 'EURUSD', 8000);

  harness.coordinator.start('EURUSD', '1m');

  assert.equal(harness.results.length, 1, 'the cycle ended');
  assert.equal(harness.results[0].outcome, 'failure', 'the cycle failed');
  assert.equal(
    harness.manager.isRecoveryRequired('EURUSD', '1m'),
    true,
    'the pair stays blocked'
  );

  await delay(120);
  assert.equal(
    harness.controller.attemptsFor('EURUSD', '1m'),
    3,
    'the budget is spent instead of being reset'
  );
  assert.equal(
    harness.provider.requests.length,
    4,
    'the request chain is bounded (1 + maxAttempts)'
  );
  assert.equal(
    harness.manager.isRecoveryRequired('EURUSD', '1m'),
    true,
    'the pair stays blocked while the gap is open'
  );
});

// =============================================================================================
// F — a stale response of a superseded cycle is ignored
// =============================================================================================

test('D5 F1 — the late response of a superseded cycle is ignored', () => {
  const harness = createHarness(liveEpochOf(8000));
  harness.provider.defer = true;
  interruptPair(harness.manager, 'EURUSD', 8000);

  harness.coordinator.start('EURUSD', '1m');
  // The cycle is abandoned (a reconnect cancels it) and a fresh cycle takes
  // over the pair.
  harness.coordinator.cancel('EURUSD', '1m');
  harness.coordinator.start('EURUSD', '1m');
  assert.equal(harness.provider.requests.length, 2, 'both cycles issued their first window');

  // The response of the FIRST (superseded) cycle arrives late.
  harness.provider.flushNext();

  assert.equal(
    harness.results.length,
    0,
    'the stale response neither completes nor ends a cycle'
  );
  assert.equal(
    harness.manager.isRecoveryRequired('EURUSD', '1m'),
    true,
    'the pair is not released by a stale response'
  );
  assert.equal(
    harness.manager.getHistory('EURUSD', '1m').length,
    0,
    'a stale response never enters the trusted history'
  );

  // The live cycle still finishes normally.
  for (let i = 0; i < 5 && harness.results.length === 0; i++) {
    harness.provider.flushNext();
  }
  assert.equal(harness.results.length, 1, 'the live cycle reported its outcome');
  assert.equal(harness.results[0].recoveryComplete, true, 'the live cycle completed');
  assert.equal(
    harness.manager.isRecoveryRequired('EURUSD', '1m'),
    false,
    'the pair is whole again'
  );
});

// =============================================================================================
// G — the recovery of one pair never touches another pair
// =============================================================================================

test('D5 G1 — a chunk cycle never touches another pair', () => {
  const harness = createHarness(liveEpochOf(8000));
  interruptPair(harness.manager, 'EURUSD', 8000);
  interruptPair(harness.manager, 'GBPUSD', 8000);

  harness.coordinator.start('EURUSD', '1m');

  assert.equal(
    harness.manager.isRecoveryRequired('EURUSD', '1m'),
    false,
    'the requested pair is whole again'
  );
  assert.equal(
    harness.manager.isRecoveryRequired('GBPUSD', '1m'),
    true,
    'the other pair is untouched and still blocked'
  );
  assert.equal(
    harness.manager.getHistory('GBPUSD', '1m').length,
    0,
    'the other pair admitted nothing'
  );
  assert.equal(
    harness.provider.requests.every((r) => r.symbol === 'EURUSD'),
    true,
    'no request was issued for the other pair'
  );
});

// =============================================================================================
// H — the D4 validation and the ordinary recovery path are unchanged
// =============================================================================================

test('D5 H1 — an invalid entry can never stand in for a required period', () => {
  const harness = createHarness(liveEpochOf(8000));
  // One delivered entry breaks the candle invariants (the high is below the
  // close), so it must be rejected and must not satisfy a required period.
  harness.provider.broken = liveEpochOf(8000) - 2500 * PERIOD;
  interruptPair(harness.manager, 'V75', 8000);

  harness.coordinator.start('V75', '1m');

  assert.equal(
    harness.manager.isRecoveryRequired('V75', '1m'),
    true,
    'the invalid period is not admitted, so the gap stays open'
  );
  assert.equal(
    harness.results[0].rejectedCandleCount,
    1,
    'the invalid entry is reported as rejected'
  );
  assert.equal(
    harness.results[0].recoveryComplete,
    false,
    'the recovery is refused'
  );
});

test('D5 H2 — a pair without an open gap needs no chunk cycle', () => {
  const harness = createHarness(liveEpochOf(8000));

  const start = harness.coordinator.start('EURUSD', '1m');
  assert.equal(start.kind, 'no-recovery', 'there is nothing to recover');
  assert.equal(harness.provider.requests.length, 0, 'no request is issued');
});

// =============================================================================================
// K — a retry that arrives while a cycle is running does not start a second chain
// =============================================================================================

test('D5 K1 — a retry during a running cycle does not start a second chain', () => {
  const harness = createHarness(liveEpochOf(8000));
  harness.provider.defer = true;
  interruptPair(harness.manager, 'EURUSD', 8000);

  const first = harness.coordinator.start('EURUSD', '1m');
  assert.equal(first.kind, 'chunked', 'the cycle starts');
  assert.equal(harness.provider.requests.length, 1, 'one window is outstanding');

  const second = harness.coordinator.start('EURUSD', '1m');
  assert.equal(second.kind, 'chunked', 'the running cycle keeps the pair');
  assert.equal(
    harness.provider.requests.length,
    1,
    'the retry does not issue a second chain of requests'
  );

  harness.provider.defer = false;
  harness.provider.flushDeferred();

  assert.equal(harness.results.length, 1, 'exactly one cycle ended');
  assert.equal(harness.results[0].recoveryComplete, true, 'the cycle completed');
});

// =============================================================================================
// J — the headless monitoring path uses the chunked recovery too
// =============================================================================================

/** A market source that understands the bounded end marker of a window. */
class ChunkAwareSource implements MonitoringMarketSource {
  public readonly requests: ProviderRequest[] = [];
  private status: ConnectionStatus = 'DISCONNECTED';
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private readonly tickListeners = new Set<(t: TickData) => void>();
  private readonly feedListeners = new Set<(s: FeedStatus) => void>();

  constructor(private readonly liveEpoch: number) {}

  public connect(): void {
    this.status = 'CONNECTED';
    for (const listener of this.statusListeners) listener('CONNECTED');
  }

  public disconnect(): void {
    this.status = 'DISCONNECTED';
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getFeedStatus(): FeedStatus | undefined {
    return undefined;
  }

  public getLastTickEpoch(): number | undefined {
    return undefined;
  }

  public subscribeTicks(): void {}

  public fetchCandlesHistory(
    symbolId: string,
    timeframe: Timeframe,
    count: number,
    callback: HistoryRequestCallback,
    end: number | 'latest' = 'latest'
  ): void {
    const request: ProviderRequest = {
      symbol: symbolId,
      timeframe,
      count,
      end: end === 'latest' ? null : end,
    };
    this.requests.push(request);
    const newest = request.end ?? this.liveEpoch;
    const candles: HistoryCandleData[] = [];
    for (let i = 0; i < count; i++) candles.push(candle(newest - i * PERIOD));
    callback(symbolId, timeframe, candles, 'success');
  }

  public onStatusChange(listener: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  public onTick(listener: (t: TickData) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  public onFeedStatus(listener: (s: FeedStatus) => void): () => void {
    this.feedListeners.add(listener);
    return () => this.feedListeners.delete(listener);
  }
}

test('D5 J1 — the monitoring adapter recovers a wide gap through the chunked path', () => {
  const manager = new CandleManager(30000);
  const source = new ChunkAwareSource(liveEpochOf(8000));
  const adapter = new LiveAcquisitionAdapter(
    source,
    {
      candleManager: manager,
      evaluatePair: () => {
        throw new Error('no evaluation is expected in this test');
      },
    },
    { pairs: [{ symbolId: 'V75', timeframe: '1m' }] }
  );

  // The pair observes the anchor period, loses the connection, and resumes far
  // beyond the capacity of a single history request.
  interruptPair(manager, 'V75', 8000);

  adapter.start();

  assert.equal(
    manager.isRecoveryRequired('V75', '1m'),
    false,
    'the monitored pair is whole again'
  );
  assert.ok(source.requests.length > 0, 'the gap was served by requests');
  assert.equal(
    source.requests.every((r) => r.count <= MAX_RECOVERY_HISTORY_COUNT),
    true,
    'no request asks for more than the provider delivers'
  );
  assert.equal(
    source.requests.length <= MAX_RECOVERY_CHUNKS,
    true,
    'the request chain is bounded'
  );
  assert.equal(
    adapter.getPairState('V75', '1m')?.recoveryRequired,
    false,
    'the adapter reports the pair as recovered'
  );
});

// =============================================================================================
// I — the live edge may advance while the windows are being fetched
// =============================================================================================

test('D5 I1 — a live tick that advances the edge keeps the pair blocked', () => {
  const harness = createHarness(liveEpochOf(8000));
  harness.provider.defer = true;
  interruptPair(harness.manager, 'EURUSD', 8000);

  harness.coordinator.start('EURUSD', '1m');

  // The live edge moves far beyond the window that was requested.
  harness.manager.processTick(tick('EURUSD', 1.3, liveEpochOf(8000) + 6000 * PERIOD + 30));

  harness.provider.defer = false;
  harness.provider.flushDeferred();

  assert.equal(
    harness.manager.isRecoveryRequired('EURUSD', '1m'),
    true,
    'the pair is not released with an incomplete history'
  );
  assert.equal(harness.results.length, 1, 'the cycle ended');
  assert.equal(harness.results[0].recoveryComplete, false, 'the cycle did not complete');
});
