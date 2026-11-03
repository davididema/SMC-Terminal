/**
 * Phase 3A — reconnect-gap candle integrity regression tests.
 *
 * The confirmed defect: a tick formed a candle, the connection dropped, and the
 * first tick after the reconnect was in a much later period. The rollover
 * finalized the interrupted candle as if it were a valid close, and the pair
 * (already seeded before the drop) was never re-seeded, so the gap stayed
 * invisible.
 *
 * These tests use synthetic epochs and a controlled in-memory market source.
 * No socket, no network, and no fabricated market data: the candles are
 * deterministic fixtures whose only purpose is to describe periods.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Candle,
  CandleManager,
  Timeframe,
  TickData,
  isRecoveryCovered,
  MAX_RECOVERY_HISTORY_COUNT,
  type RecoveryRequirement,
} from '../lib/deriv/candles';
import {
  LiveAcquisitionAdapter,
  MonitoringMarketSource,
  MonitoringObservation,
} from '../lib/monitoring/live-acquisition';
import { MonitoringCore } from '../lib/monitoring/headless-core';
import type { ConnectionStatus } from '../lib/deriv/websocket';
import type { FeedStatus } from '../lib/deriv/feed';
import type {
  HistoryCandleData,
  HistoryRequestCallback,
  HistoryRequestOutcome,
} from '../lib/deriv/history-requests';
import { planHistoryLoad, createHistoryBookkeeping, markHistoryPending } from '../lib/deriv/history-init';

// --- The scenario -------------------------------------------------------------
// A tick at epoch 100 belongs to the 1m period starting at epoch 60. The
// connection then drops; the first tick after the reconnect is at epoch 400 and
// belongs to the 1m period starting at epoch 360.
const INTERRUPTED_PERIOD = 60;
const LIVE_PERIOD = 360;
const PERIOD = 60;

function tick(symbol: string, price: number, epoch: number): TickData {
  return { symbol, derivSymbol: symbol, price, epoch };
}

/** A deterministic closed candle for a 1m period. */
function candle(epoch: number, close = 1.1): Candle {
  return { epoch, open: close, high: close, low: close, close, volume: 1, isClosed: true };
}

/** The history a recovery would return: the interrupted period up to the live edge. */
function recoveryCandles(epochs: readonly number[]): HistoryCandleData[] {
  return epochs.map((epoch) => ({
    epoch,
    open: 1.1,
    high: 1.1,
    low: 1.1,
    close: 1.1,
  }));
}

// --- Controlled market source ------------------------------------------------

class FakeMarketSource implements MonitoringMarketSource {
  public readonly requests: Array<{
    symbolId: string;
    timeframe: Timeframe;
    count: number;
    callback: HistoryRequestCallback;
  }> = [];

  private status: ConnectionStatus = 'DISCONNECTED';
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private readonly tickListeners = new Set<(t: TickData) => void>();
  private readonly feedListeners = new Set<(s: FeedStatus) => void>();

  connect(): void {
    this.setStatus('CONNECTED');
  }

  disconnect(): void {
    this.setStatus('DISCONNECTED');
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getFeedStatus(): FeedStatus | undefined {
    return undefined;
  }

  getLastTickEpoch(): number | undefined {
    return undefined;
  }

  subscribeTicks(): void {
    // No subscription bookkeeping is needed by these tests.
  }

  fetchCandlesHistory(
    symbolId: string,
    timeframe: Timeframe,
    count: number,
    callback: HistoryRequestCallback
  ): void {
    this.requests.push({ symbolId, timeframe, count, callback });
  }

  onStatusChange(listener: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onTick(listener: (t: TickData) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  onFeedStatus(listener: (s: FeedStatus) => void): () => void {
    this.feedListeners.add(listener);
    return () => this.feedListeners.delete(listener);
  }

  // --- test controls ---

  setStatus(status: ConnectionStatus): void {
    // A dropped connection abandons its in-flight requests, exactly like the
    // real request registry does for the closed connection generation.
    if (status !== 'CONNECTED') {
      this.abandonPending();
    }
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }

  emitTick(t: TickData): void {
    for (const l of this.tickListeners) l(t);
  }

  pendingCount(): number {
    return this.requests.length;
  }

  completeHistory(
    symbolId: string,
    timeframe: Timeframe,
    candles: HistoryCandleData[],
    outcome: HistoryRequestOutcome
  ): void {
    const idx = this.requests.findIndex(
      (r) => r.symbolId === symbolId && r.timeframe === timeframe
    );
    if (idx < 0) throw new Error(`no pending history request for ${symbolId}:${timeframe}`);
    const [req] = this.requests.splice(idx, 1);
    req.callback(symbolId, timeframe, candles, outcome);
  }

  private abandonPending(): void {
    const pending = [...this.requests];
    this.requests.length = 0;
    for (const req of pending) {
      req.callback(req.symbolId, req.timeframe, [], 'abandoned');
    }
  }
}

function collect(adapter: LiveAcquisitionAdapter): MonitoringObservation[] {
  const out: MonitoringObservation[] = [];
  adapter.onObservation((o) => out.push(o));
  return out;
}

function ofType<T extends MonitoringObservation['type']>(
  obs: MonitoringObservation[],
  type: T
): Array<Extract<MonitoringObservation, { type: T }>> {
  return obs.filter((o): o is Extract<MonitoringObservation, { type: T }> => o.type === type);
}

// =============================================================================================
// The interrupted candle is never finalized as a valid close
// =============================================================================================

test('RCI 1 — a candle that spans a reconnect gap is never closed as valid', () => {
  const manager = new CandleManager();
  const closes: Candle[] = [];
  manager.onCandleClose((_symbol, _timeframe, closed) => closes.push(closed));

  // The tick forms the 1m candle of period 60.
  manager.processTick(tick('EURUSD', 1.1, 100));
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.epoch, INTERRUPTED_PERIOD);

  // The connection drops: the forming candle now spans a known discontinuity.
  manager.markDiscontinuity('EURUSD');
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), true);

  // The first tick after the reconnect must not finalize the interrupted candle.
  manager.processTick(tick('EURUSD', 1.2, 400));
  assert.equal(closes.length, 0, 'the interrupted candle is never closed');
  assert.equal(
    manager.getHistory('EURUSD', '1m').some((c) => c.epoch === INTERRUPTED_PERIOD),
    false,
    'the incomplete candle is not pushed into the closed history'
  );
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.epoch, LIVE_PERIOD);

  // The recovery re-derives the interrupted period and bridges the gap.
  const recovered = recoveryCandles([60, 120, 180, 240, 300]);
  assert.equal(manager.recoverFromHistory('EURUSD', '1m', recovered), true);
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), false);

  const history = manager.getHistory('EURUSD', '1m');
  assert.equal(history.length, 5, 'the recovered periods are available as closed candles');
  assert.equal(history[0].epoch, INTERRUPTED_PERIOD);
  assert.equal(history.every((c) => c.isClosed), true);
  assert.equal(closes.length, 0, 'a recovery never emits a close event');

  // The next rollover closes exactly one candle: the live one.
  manager.processTick(tick('EURUSD', 1.3, 420));
  assert.equal(closes.length, 1);
  assert.equal(closes[0].epoch, LIVE_PERIOD);
});

test('RCI 2 — the recovery requirement describes the gap and sizes the request', () => {
  const manager = new CandleManager();
  manager.processTick(tick('EURUSD', 1.1, 100));
  manager.markDiscontinuity('EURUSD');

  const requirement = manager.getRecoveryRequirement('EURUSD', '1m');
  assert.ok(requirement, 'a pending recovery has a requirement');
  assert.equal(requirement.recoveryEpoch, INTERRUPTED_PERIOD);
  assert.equal(requirement.liveEpoch, INTERRUPTED_PERIOD);

  // After the reconnect the live edge moves forward, so the request must span
  // the whole gap.
  manager.processTick(tick('EURUSD', 1.2, 400));
  const afterGap = manager.getRecoveryRequirement('EURUSD', '1m');
  assert.ok(afterGap);
  assert.equal(afterGap.recoveryEpoch, INTERRUPTED_PERIOD);
  assert.equal(afterGap.liveEpoch, LIVE_PERIOD);
  assert.equal(afterGap.requiredCount, 6, 'periods 60..360 inclusive');
  assert.equal(afterGap.periodSeconds, PERIOD);

  // The requested count is at least the ordinary backfill size and never
  // exceeds the provider maximum.
  assert.equal(manager.getRecoveryHistoryCount('EURUSD', '1m', 100), 100);
  assert.equal(manager.getRecoveryHistoryCount('EURUSD', '1m', 1), 6);
  assert.ok(manager.getRecoveryHistoryCount('EURUSD', '1m', 100000) <= MAX_RECOVERY_HISTORY_COUNT);
});

test('RCI 3 — coverage requires the interrupted period and the live edge', () => {
  const requirement: RecoveryRequirement = {
    recoveryEpoch: INTERRUPTED_PERIOD,
    interruptedEpoch: null,
    liveEpoch: LIVE_PERIOD,
    periodSeconds: PERIOD,
    requiredCount: 6,
  };

  assert.equal(
    isRecoveryCovered(requirement, [60, 120, 180, 240, 300]),
    true,
    'the interrupted period is re-derived and the live edge is reached'
  );
  assert.equal(
    isRecoveryCovered(requirement, [120, 180, 240, 300]),
    false,
    'a response that misses the interrupted period does not cover the gap'
  );
  assert.equal(
    isRecoveryCovered(requirement, [60, 120, 180, 240]),
    false,
    'a response that stops before the live edge does not cover the gap'
  );
  assert.equal(isRecoveryCovered(requirement, []), false, 'an empty response never covers');
});

test('RCI 4 — an insufficient recovery leaves the pair in the recovery state', () => {
  const manager = new CandleManager();
  manager.processTick(tick('EURUSD', 1.1, 100));
  manager.markDiscontinuity('EURUSD');
  manager.processTick(tick('EURUSD', 1.2, 400));

  // The response reaches the live edge but does not re-derive the interrupted
  // period: the gap is not bridged.
  const incomplete = manager.recoverFromHistory(
    'EURUSD',
    '1m',
    recoveryCandles([240, 300])
  );
  assert.equal(incomplete, false, 'the recovery is refused');
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), true, 'the pair stays blocked');
  assert.equal(
    manager.getHistory('EURUSD', '1m').some((c) => c.epoch === INTERRUPTED_PERIOD),
    false,
    'no incomplete data is admitted'
  );
  assert.equal(
    manager.getRecoveryHistoryCount('EURUSD', '1m', 100),
    200,
    'the next attempt asks for a wider window'
  );
});

// =============================================================================================
// The acquisition adapter blocks evaluation until the gap is bridged
// =============================================================================================

test('RCI 5 — the adapter re-requests a seeded pair after a gap and evaluates only after the recovery', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  const obs = collect(adapter);
  adapter.start();

  // The initial backfill succeeds; the pair is seeded.
  source.completeHistory('EURUSD', '1m', recoveryCandles([0]), 'success');
  assert.equal(adapter.getPairState('EURUSD', '1m')?.historyStatus, 'success');
  assert.equal(source.pendingCount(), 0);

  // A tick forms the 1m candle of period 60.
  source.emitTick(tick('EURUSD', 1.1, 100));
  assert.equal(core.candleManager.getCurrentCandle('EURUSD', '1m')?.epoch, INTERRUPTED_PERIOD);

  // The connection drops and comes back.
  source.setStatus('RECONNECTING');
  assert.equal(
    adapter.getPairState('EURUSD', '1m')?.recoveryRequired,
    true,
    'the pair is blocked until its history is recovered'
  );
  source.setStatus('CONNECTED');

  assert.equal(
    source.pendingCount(),
    1,
    'the seeded pair is re-requested: it has to recover the gap'
  );

  // The first tick after the reconnect must not close the interrupted candle.
  source.emitTick(tick('EURUSD', 1.2, 400));
  assert.equal(ofType(obs, 'candle-close').length, 0, 'no close is emitted for the gap');
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 0);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.candidateCount, 0);
  assert.equal(core.session.size(), 0, 'no notification state is created');

  // The recovery response bridges the gap.
  source.completeHistory(
    'EURUSD',
    '1m',
    recoveryCandles([60, 120, 180, 240, 300]),
    'success'
  );
  assert.equal(adapter.getPairState('EURUSD', '1m')?.recoveryRequired, false);
  assert.equal(ofType(obs, 'history').filter((o) => o.outcome === 'recovery-complete').length, 1);

  // The next rollover closes exactly one candle and evaluates it exactly once.
  source.emitTick(tick('EURUSD', 1.3, 420));
  const closes = ofType(obs, 'candle-close');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].epoch, LIVE_PERIOD);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 1);
  assert.equal(ofType(obs, 'evaluation').length, 1);
});

test('RCI 6 — an incomplete recovery keeps the pair blocked and never evaluates', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  const obs = collect(adapter);
  adapter.start();

  source.completeHistory('EURUSD', '1m', recoveryCandles([0]), 'success');
  source.emitTick(tick('EURUSD', 1.1, 100));

  source.setStatus('RECONNECTING');
  source.setStatus('CONNECTED');
  assert.equal(source.pendingCount(), 1);

  source.emitTick(tick('EURUSD', 1.2, 400));
  assert.equal(ofType(obs, 'candle-close').length, 0);

  // The response does not re-derive the interrupted period.
  source.completeHistory('EURUSD', '1m', recoveryCandles([240, 300]), 'success');
  assert.equal(adapter.getPairState('EURUSD', '1m')?.recoveryRequired, true);
  assert.equal(ofType(obs, 'history').filter((o) => o.outcome === 'recovery-incomplete').length, 1);

  // A later close of a live candle is refused while the gap is still open.
  source.emitTick(tick('EURUSD', 1.3, 480));
  assert.equal(ofType(obs, 'candle-close').length, 1, 'the live candle still closes');
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 0, 'but it is not evaluated');
  assert.equal(ofType(obs, 'evaluation').length, 0);
  assert.ok(
    ofType(obs, 'error').some((o) => o.stage === 'recovery'),
    'the blocked evaluation is reported'
  );
  assert.equal(core.session.size(), 0);
});

// =============================================================================================
// A SECOND disconnect must not be recovered with a history that misses the
// candle it interrupted
// =============================================================================================

test('RCI 8 — a second disconnect keeps the newly interrupted candle unrecovered', () => {
  const manager = new CandleManager();
  const closes: Candle[] = [];
  manager.onCandleClose((_symbol, _timeframe, closed) => closes.push(closed));

  // 1. A tick forms the 1m candle of period 60.
  manager.processTick(tick('EURUSD', 1.1, 100));
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.epoch, INTERRUPTED_PERIOD);

  // 2. First disconnect: the forming candle spans the discontinuity.
  manager.markDiscontinuity('EURUSD');
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), true);
  assert.equal(
    manager.getTimeframeState('EURUSD', '1m')?.interruptedEpoch,
    INTERRUPTED_PERIOD
  );

  // 3. The first tick after the reconnect drops the interrupted candle and
  //    forms the candle of period 360.
  manager.processTick(tick('EURUSD', 1.2, 400));
  assert.equal(closes.length, 0, 'the interrupted candle is never closed');
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.epoch, LIVE_PERIOD);

  // 4. A second disconnect happens before the recovery completed: the candle
  //    of period 360 is now the interrupted one.
  manager.markDiscontinuity('EURUSD');

  // 5. The requirement still uses the OLDEST gap anchor, but it also names the
  //    candle that is currently interrupted.
  const requirement = manager.getRecoveryRequirement('EURUSD', '1m');
  assert.ok(requirement, 'a pending recovery has a requirement');
  assert.equal(requirement.recoveryEpoch, INTERRUPTED_PERIOD, 'the oldest anchor is kept');
  assert.equal(
    requirement.interruptedEpoch,
    LIVE_PERIOD,
    'the candle interrupted by the second disconnect is named'
  );
  assert.equal(
    isRecoveryCovered(
      { ...requirement, interruptedEpoch: LIVE_PERIOD },
      [60, 120, 180, 240, 300]
    ),
    false,
    'a history that omits the currently interrupted candle does not cover the gap'
  );

  // 6./7. The history bridges the oldest gap but omits the candle that the
  //       second disconnect interrupted: the recovery is refused and the
  //       requirement stays in place.
  const refused = manager.recoverFromHistory(
    'EURUSD',
    '1m',
    recoveryCandles([60, 120, 180, 240, 300])
  );
  assert.equal(refused, false, 'the recovery is refused');
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), true, 'the recovery is still required');
  assert.equal(
    manager.getTimeframeState('EURUSD', '1m')?.interruptedEpoch,
    LIVE_PERIOD,
    'the interrupted candle is still marked'
  );
  assert.equal(
    manager.getRecoveryRequirement('EURUSD', '1m') !== null,
    true,
    'the pair is still waiting for a recovery'
  );
  assert.equal(
    manager.getHistory('EURUSD', '1m').some((c) => c.epoch === LIVE_PERIOD),
    false,
    'the interrupted candle does not enter the trusted closed history'
  );

  // 8. The next rollover must NOT finalize the interrupted candle.
  manager.processTick(tick('EURUSD', 1.25, 700));
  assert.equal(closes.length, 0, 'the interrupted candle is never closed');
  assert.equal(
    closes.some((c) => c.epoch === LIVE_PERIOD),
    false,
    'the interrupted candle is not emitted as a valid close'
  );
  assert.equal(
    manager.getHistory('EURUSD', '1m').some((c) => c.epoch === LIVE_PERIOD),
    false,
    'the interrupted candle is not pushed into the closed history'
  );
  assert.equal(manager.getCurrentCandle('EURUSD', '1m')?.epoch, 660);

  // A recovery that re-derives the interrupted candle completes the recovery.
  const covered = manager.recoverFromHistory(
    'EURUSD',
    '1m',
    recoveryCandles([60, 120, 180, 240, 300, 360, 420, 480, 540, 600])
  );
  assert.equal(covered, true, 'the recovery that re-derives the candle succeeds');
  assert.equal(manager.isRecoveryRequired('EURUSD', '1m'), false);
  assert.equal(manager.getTimeframeState('EURUSD', '1m')?.interruptedEpoch, null);

  const history = manager.getHistory('EURUSD', '1m');
  const recovered = history.find((c) => c.epoch === LIVE_PERIOD);
  assert.ok(recovered, 'the re-derived candle is authoritative closed history');
  assert.equal(recovered.isClosed, true);

  // Normal operation resumes: exactly one close, for the live candle only.
  manager.processTick(tick('EURUSD', 1.3, 720));
  assert.equal(closes.length, 1, 'exactly one close');
  assert.equal(closes[0].epoch, 660);
});

test('RCI 9 — the adapter never evaluates a candle interrupted by a second disconnect', () => {
  const core = new MonitoringCore();
  const source = new FakeMarketSource();
  const adapter = new LiveAcquisitionAdapter(source, core, {
    pairs: [{ symbolId: 'EURUSD', timeframe: '1m' }],
  });
  const obs = collect(adapter);
  adapter.start();

  // The initial backfill succeeds; the pair is seeded.
  source.completeHistory('EURUSD', '1m', recoveryCandles([0]), 'success');

  // A tick forms the 1m candle of period 60.
  source.emitTick(tick('EURUSD', 1.1, 100));
  assert.equal(core.candleManager.getCurrentCandle('EURUSD', '1m')?.epoch, INTERRUPTED_PERIOD);

  // First disconnect and reconnect.
  source.setStatus('RECONNECTING');
  assert.equal(adapter.getPairState('EURUSD', '1m')?.recoveryRequired, true);
  source.setStatus('CONNECTED');
  assert.equal(source.pendingCount(), 1, 'the pair is re-requested for the recovery');

  // The first tick after the reconnect drops the interrupted candle and forms
  // the candle of period 360.
  source.emitTick(tick('EURUSD', 1.2, 400));
  assert.equal(ofType(obs, 'candle-close').length, 0, 'no close is emitted for the gap');

  // Second disconnect before the recovery completed.
  source.setStatus('RECONNECTING');
  assert.equal(adapter.getPairState('EURUSD', '1m')?.recoveryRequired, true);
  source.setStatus('CONNECTED');
  assert.equal(source.pendingCount(), 1, 'the blocked pair is re-requested');

  // The response bridges the oldest gap but omits the candle that the second
  // disconnect interrupted: the recovery stays incomplete.
  source.completeHistory(
    'EURUSD',
    '1m',
    recoveryCandles([60, 120, 180, 240, 300]),
    'success'
  );
  assert.equal(
    adapter.getPairState('EURUSD', '1m')?.recoveryRequired,
    true,
    'the recovery is still required'
  );
  assert.equal(
    ofType(obs, 'history').filter((o) => o.outcome === 'recovery-incomplete').length,
    1,
    'the incomplete recovery is reported'
  );
  assert.equal(
    core.candleManager
      .getHistory('EURUSD', '1m')
      .some((c) => c.epoch === LIVE_PERIOD),
    false,
    'the interrupted candle does not enter the trusted closed history'
  );

  // The next rollover must not close (and never evaluate) the interrupted
  // candle.
  source.emitTick(tick('EURUSD', 1.25, 700));
  assert.equal(
    ofType(obs, 'candle-close').some((o) => o.epoch === LIVE_PERIOD),
    false,
    'the interrupted candle is not emitted as a valid close'
  );
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 0, 'it is not evaluated');
  assert.equal(ofType(obs, 'evaluation').length, 0);
  assert.equal(core.session.size(), 0, 'no notification state is created');

  // A CONNECTED notification re-requests the still-blocked pair (no new
  // discontinuity: the transport did not lose the connection in between).
  source.setStatus('CONNECTED');
  assert.equal(source.pendingCount(), 1, 'the blocked pair is re-requested');

  // The response re-derives the interrupted candle: the recovery completes.
  source.completeHistory(
    'EURUSD',
    '1m',
    recoveryCandles([60, 120, 180, 240, 300, 360, 420, 480, 540, 600]),
    'success'
  );
  assert.equal(adapter.getPairState('EURUSD', '1m')?.recoveryRequired, false);
  assert.equal(ofType(obs, 'history').filter((o) => o.outcome === 'recovery-complete').length, 1);

  // Normal operation resumes: exactly one close and one evaluation.
  source.emitTick(tick('EURUSD', 1.3, 720));
  const closes = ofType(obs, 'candle-close');
  assert.equal(closes.length, 1, 'exactly one close');
  assert.equal(closes[0].epoch, 660);
  assert.equal(adapter.getPairState('EURUSD', '1m')?.evaluationCount, 1, 'evaluated exactly once');
  assert.equal(ofType(obs, 'evaluation').length, 1);
});

// =============================================================================================
// Backfill planning
// =============================================================================================

test('RCI 7 — a pair that must recover is re-requested even when it was seeded', () => {
  const bookkeeping = createHistoryBookkeeping();
  markHistoryPending(bookkeeping, 'EURUSD', '1m');
  // The pair was seeded before the gap.
  bookkeeping.seeded.add('EURUSD:1m');
  bookkeeping.pending.delete('EURUSD:1m');

  assert.equal(
    planHistoryLoad('EURUSD', '1m', bookkeeping.seeded, bookkeeping.pending, true),
    'skip-seeded',
    'without a recovery the seeded pair is not requested again'
  );
  assert.equal(
    planHistoryLoad('EURUSD', '1m', bookkeeping.seeded, bookkeeping.pending, true, true),
    'request',
    'with a pending recovery the seeded pair must be requested again'
  );

  markHistoryPending(bookkeeping, 'EURUSD', '1m');
  assert.equal(
    planHistoryLoad('EURUSD', '1m', bookkeeping.seeded, bookkeeping.pending, true, true),
    'skip-pending',
    'an in-flight request is still deduplicated'
  );

  bookkeeping.pending.delete('EURUSD:1m');
  assert.equal(
    planHistoryLoad('EURUSD', '1m', bookkeeping.seeded, bookkeeping.pending, false, true),
    'no-client',
    'a missing client still blocks the recovery request'
  );
});
