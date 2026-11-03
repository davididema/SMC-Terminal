'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  DerivSymbolConfig,
  SUPPORTED_SYMBOLS,
  getSymbolConfig,
} from '@/lib/deriv/symbols';
import {
  DerivWebSocketClient,
  ConnectionStatus,
  DerivLogEntry,
} from '@/lib/deriv/websocket';
import { FeedStatus } from '@/lib/deriv/feed';
import {
  CandleManager,
  Candle,
  Timeframe,
  TickData,
  describeHistoryRejections,
} from '@/lib/deriv/candles';
import { SMCEngine } from '@/lib/analysis/smc';
import { SignalEngine } from '@/lib/signals/signal-engine';
import { evaluateSignalForPair } from '@/lib/signals/signal-eval';
import { SignalDiagnostics } from '@/lib/signals/signal-diagnostics';
import {
  applyEvaluation,
  clearDecision,
  collectAffectedPairs,
  createDecisionState,
  getRetainedSignal,
  invalidateDecisionsForDiscontinuity,
  type DecisionState,
} from '@/lib/signals/decision-state';
import {
  planHistoryLoad,
  createHistoryBookkeeping,
  markHistoryPending,
  applyHistoryOutcome,
  historyKey,
  type HistoryBookkeeping,
} from '@/lib/deriv/history-init';
import { HistoryRecoveryController, applyHistoryResponse } from '@/lib/deriv/history-recovery';
import { RecoveryChunkCoordinator } from '@/lib/deriv/history-chunks';
import { resumeStaleRecovery } from '@/lib/deriv/recovery-resume';
import { isSelectedPair } from '@/lib/deriv/selection';
import { useSignalNotifications } from '@/hooks/useSignalNotifications';
import { isNotificationTestEnabled } from '@/lib/notifications/test-signal';

// UI Components
import { Header } from '@/components/Header';
import { NotificationCenter } from '@/components/NotificationCenter';
import { Watchlist } from '@/components/Watchlist';
import { CandleChart } from '@/components/CandleChart';
import { MarketStructurePanel } from '@/components/MarketStructurePanel';
import { SMCAnalysisPanel } from '@/components/SMCAnalysisPanel';
import { SignalPanel } from '@/components/SignalPanel';
import { MarketDataPanel } from '@/components/MarketDataPanel';
import { RiskPanel } from '@/components/RiskPanel';
import { EventLogPanel } from '@/components/EventLogPanel';

export default function DashboardPage() {
  // Active selected symbol (defaults to EURUSD)
  const [selectedSymbol, setSelectedSymbol] = useState<DerivSymbolConfig>(
    SUPPORTED_SYMBOLS[0]
  );
  const [timeframe, setTimeframe] = useState<Timeframe>('1m');

  // Stable references to prevent stale closures in event listener callbacks
  const selectedSymbolRef = useRef<DerivSymbolConfig>(SUPPORTED_SYMBOLS[0]);
  const selectedTimeframeRef = useRef<Timeframe>('1m');

  // WebSocket & Market State
  const [status, setStatus] = useState<ConnectionStatus>('DISCONNECTED');
  const [prices, setPrices] = useState<Map<string, number>>(new Map());
  const [lastTickEpochs, setLastTickEpochs] = useState<Map<string, number>>(new Map());
  const [feedStatuses, setFeedStatuses] = useState<Map<string, FeedStatus>>(new Map());
  const [totalTicks, setTotalTicks] = useState(0);

  // Active Candles State for the Currently Selected Symbol & Timeframe
  const [chartCandles, setChartCandles] = useState<Candle[]>([]);
  const [currentCandle, setCurrentCandle] = useState<Candle | null>(null);

  // Analysis & Signals
  //
  // The displayed decision (the analysis, the latest evaluation's signal, its
  // intended direction and the evaluation time) and the genuine signals
  // retained per pair are ONE state value: a market-data discontinuity
  // invalidates both together, so they must never be cleared apart. See
  // `lib/signals/decision-state.ts`.
  const [decision, setDecision] = useState<DecisionState>(() => createDecisionState());

  // Event Logs
  const [logs, setLogs] = useState<DerivLogEntry[]>([]);

  // Refs to persistent singletons across renders
  const wsClientRef = useRef<DerivWebSocketClient | null>(null);
  const candleManagerRef = useRef<CandleManager>(new CandleManager(1000));
  const smcEngineRef = useRef<SMCEngine>(new SMCEngine());
  const signalEngineRef = useRef<SignalEngine>(new SignalEngine());
  const diagnosticsRef = useRef<SignalDiagnostics>(new SignalDiagnostics(32));

  // Historical backfill bookkeeping, keyed by `${symbolId}:${timeframe}`.
  // `seeded` marks pairs whose history request completed AND seeded successfully.
  // `pending` deduplicates concurrent requests so a pair is not requested twice.
  const historyBookRef = useRef<HistoryBookkeeping>(createHistoryBookkeeping());

  // Bounded auto-recovery for failed/empty history requests while connected.
  // Created in the connection effect so its retry actions share the live client.
  const historyRecoveryRef = useRef<HistoryRecoveryController | null>(null);

  // Bounded chunked recovery for gaps that are wider than a single history
  // request (the provider delivers at most 5000 candles per request). Created
  // in the connection effect so it shares the live client and the retry budget.
  const historyChunksRef = useRef<RecoveryChunkCoordinator | null>(null);

  // Phase 1 notifications. Detection fires only from the active pair's candle-close
  // event (see the candle-close listener below); it is never driven by render.
  const {
    notifications,
    desktopState,
    preferences,
    storageAvailable,
    handleCandleClose,
    sendTestNotification,
    dismiss: dismissNotification,
    clear: clearNotifications,
    enableDesktop,
    setSoundEnabled,
  } = useSignalNotifications();

  // Development-only notification delivery test control. `process.env.NODE_ENV`
  // is statically replaced by Next.js, so this is false in production builds and
  // the control is never rendered there.
  const notificationTestEnabled = isNotificationTestEnabled();

  // Add Log Helper
  const addLog = useCallback((entry: DerivLogEntry) => {
    setLogs((prev) => [...prev.slice(-150), entry]);
  }, []);

  // Update chart state for currently active symbol + timeframe
  const refreshActiveCandles = useCallback(() => {
    const symId = selectedSymbolRef.current.id;
    const tf = selectedTimeframeRef.current;
    const history = candleManagerRef.current.getHistory(symId, tf);
    const curr = candleManagerRef.current.getCurrentCandle(symId, tf);
    setChartCandles(history);
    setCurrentCandle(curr);
  }, []);

  // Single evaluation path for the Trade Signal panel. Recomputes analysis +
  // signal for the given (symbol, timeframe) from the pair's closed-candle
  // history, and clears the signal when the pair has no closed candles yet so a
  // previous selection's result can never linger on screen.
  //
  // A pair whose history still has a known gap (a connection discontinuity left
  // the pair with a candle that spans the gap) is never evaluated: the closed
  // candles may be based on data that was never observed. The panel is cleared
  // instead, and null is returned to the caller.
  const evaluateSignalForSelection = useCallback((symId: string, tf: Timeframe) => {
    if (candleManagerRef.current.isRecoveryRequired(symId, tf)) {
      setDecision((prev) => clearDecision(prev));
      return null;
    }

    const result = evaluateSignalForPair(
      candleManagerRef.current,
      smcEngineRef.current,
      signalEngineRef.current,
      symId,
      tf,
      diagnosticsRef.current
    );
    // The displayed decision becomes the result, and a genuine LONG/SHORT is
    // retained for this exact pair. A NO_TRADE result (including DUPLICATE)
    // leaves the retained record untouched.
    setDecision((prev) =>
      applyEvaluation(prev, { symbolId: symId, timeframe: tf }, result)
    );
    // Expose the actual evaluation result to the caller (used only by the
    // candle-close notification path). Does not change evaluation ordering.
    return result;
  }, []);

  // Issue a historical backfill request for the pair if it still needs one.
  // This is the path a recovery retry uses, so it deliberately does NOT reset
  // the pair's recovery budget (only an explicit load does).
  //
  // A pair whose history must be recovered (after a connection discontinuity)
  // is always re-requested, even when it was seeded before the gap: only a
  // response that actually bridges the gap may clear the recovery state.
  const requestHistory = useCallback(
    (symId: string, tf: Timeframe) => {
      const client = wsClientRef.current;
      const bookkeeping = historyBookRef.current;
      const recoveryRequired = candleManagerRef.current.isRecoveryRequired(symId, tf);
      const plan = planHistoryLoad(
        symId,
        tf,
        bookkeeping.seeded,
        bookkeeping.pending,
        !!client,
        recoveryRequired
      );
      if (plan !== 'request' || !client) return;

      markHistoryPending(bookkeeping, symId, tf);

      // A gap that is wider than a single history request can never be
      // bridged by one response (the provider delivers at most 5000 candles per
      // request). Such a gap is served by a BOUNDED number of bounded requests
      // instead: the coordinator owns them and reports the cycle's outcome when
      // it ends. A gap that is wider than the bounded budget is classified and
      // the pair stays blocked - no request is issued for it.
      const chunkStart = historyChunksRef.current?.start(symId, tf);
      if (chunkStart && (chunkStart.kind === 'chunked' || chunkStart.kind === 'oversized')) {
        return;
      }

      // A recovery must span the whole gap, so it may need more candles than
      // the ordinary backfill.
      const count = candleManagerRef.current.getRecoveryHistoryCount(symId, tf, 100);

      client.fetchCandlesHistory(symId, tf, count, (s, requestedTf, history, outcome) => {
        // Apply the response to the candle manager and drive the pair's bounded
        // retry budget from it. A response that carries candles but does not
        // bridge the pair's open gap is NOT a successful recovery: it consumes
        // the budget instead of resetting it, so the pair cannot be re-requested
        // without end. The same holds for a response whose candles were all
        // rejected as invalid: it delivers no usable history.
        const applied = applyHistoryResponse({
          manager: candleManagerRef.current,
          controller: historyRecoveryRef.current,
          symbol: s,
          timeframe: requestedTf,
          candles: history ?? [],
          requestOutcome: outcome,
        });

        // Clear pending regardless of outcome so failures (including a request
        // abandoned by a dropped connection) can be retried. Only a response
        // that actually delivered usable history marks the pair seeded: a
        // response whose candles were all rejected as invalid leaves the pair
        // retryable instead of silently empty.
        applyHistoryOutcome(bookkeeping, s, requestedTf, applied.admittedCandleCount);

        // Refresh only if this pair is still the active selection, so a late
        // response cannot overwrite the chart with another pair's data.
        if (s === selectedSymbolRef.current.id && requestedTf === selectedTimeframeRef.current) {
          refreshActiveCandles();
          evaluateSignalForSelection(s, requestedTf);
        }

        if (applied.rejectedCandleCount > 0) {
          addLog({
            id: Math.random().toString(36).substring(2, 9),
            timestamp: new Date(),
            level: 'warn',
            message: `[${s}] ${requestedTf} history response rejected ${applied.rejectedCandleCount} invalid candle(s): ${describeHistoryRejections(applied.rejectedCandles)}`,
          });
        }

        if (applied.recoveryIncomplete) {
          addLog({
            id: Math.random().toString(36).substring(2, 9),
            timestamp: new Date(),
            level: 'warn',
            message: `[${s}] ${requestedTf} history recovery incomplete: the response did not cover the gap completely`,
          });
        }

        if (applied.retriesExhausted) {
          addLog({
            id: Math.random().toString(36).substring(2, 9),
            timestamp: new Date(),
            level: 'warn',
            message: `[${s}] ${requestedTf} history recovery retries exhausted: the pair stays blocked until its history is reloaded`,
          });
        }
      });
    },
    [refreshActiveCandles, evaluateSignalForSelection, addLog]
  );

  // Ensure the selected (symbol, timeframe) pair has received its historical
  // backfill. Readiness is tracked explicitly per pair, so live candles that
  // accumulated via tick aggregation no longer suppress the history request.
  // An explicit load resets the pair's recovery budget for a fresh attempt.
  const ensureHistoryLoaded = useCallback(
    (symId: string, tf: Timeframe) => {
      historyRecoveryRef.current?.reset(symId, tf);
      requestHistory(symId, tf);
    },
    [requestHistory]
  );

  // Initialize WebSocket and Listeners on Mount
  useEffect(() => {
    const client = new DerivWebSocketClient();
    wsClientRef.current = client;

    // Bounded auto-recovery for failed/empty history requests. A retry is only
    // permitted while the pair is still selected, the socket is connected, and
    // the symbol's market is neither closed nor unavailable.
    const recovery = new HistoryRecoveryController({
      canRetry: (symId, tf) => {
        if (client.getStatus() !== 'CONNECTED') return false;
        if (
          !isSelectedPair(
            symId,
            tf,
            selectedSymbolRef.current.id,
            selectedTimeframeRef.current
          )
        ) {
          return false;
        }
        const feed = client.getFeedStatus(symId)?.state;
        return feed !== 'CLOSED' && feed !== 'UNAVAILABLE';
      },
      onRetry: (symId, tf) => requestHistory(symId, tf),
    });
    historyRecoveryRef.current = recovery;

    // Bounded chunked recovery for gaps that are wider than a single history
    // request. Every window it requests stays inside the provider's limit, the
    // windows overlap by one period so no required period can be skipped, and
    // nothing is admitted before the whole cycle is complete. The cycle ends
    // with the pair released (or still blocked), never with partial data.
    const chunks = new RecoveryChunkCoordinator({
      manager: candleManagerRef.current,
      controller: recovery,
      transport: {
        fetchHistoryWindow: (symbolId, timeframe, count, end, callback) => {
          client.fetchCandlesHistory(
            symbolId,
            timeframe,
            count,
            (_s, _tf, candles, outcome) => {
              callback(
                candles ?? [],
                outcome ?? (candles && candles.length > 0 ? 'success' : 'failure')
              );
            },
            end ?? 'latest'
          );
        },
      },
      onCycleEnd: (result) => {
        // Clear the pending marker so a failed cycle stays retryable, and mark
        // the pair seeded only when the cycle actually delivered usable data.
        applyHistoryOutcome(
          historyBookRef.current,
          result.symbol,
          result.timeframe,
          result.admittedCandleCount
        );

        if (
          result.symbol === selectedSymbolRef.current.id &&
          result.timeframe === selectedTimeframeRef.current
        ) {
          refreshActiveCandles();
          evaluateSignalForSelection(result.symbol, result.timeframe);
        }

        if (result.oversized) {
          addLog({
            id: Math.random().toString(36).substring(2, 9),
            timestamp: new Date(),
            level: 'warn',
            message: `[${result.symbol}] ${result.timeframe} history gap needs ${result.requiredCount} candles, which exceeds the bounded recovery budget of ${result.maxChunks} request(s): the pair stays blocked until its history is reloaded`,
          });
          return;
        }

        if (result.recoveryComplete) {
          addLog({
            id: Math.random().toString(36).substring(2, 9),
            timestamp: new Date(),
            level: 'success',
            message: `[${result.symbol}] ${result.timeframe} history recovery completed with ${result.requestCount} bounded request(s) and ${result.admittedCandleCount} candle(s)`,
          });
          return;
        }

        addLog({
          id: Math.random().toString(36).substring(2, 9),
          timestamp: new Date(),
          level: 'warn',
          message: `[${result.symbol}] ${result.timeframe} history recovery incomplete after ${result.requestCount} bounded request(s): the pair stays blocked until its history is reloaded`,
        });
      },
    });
    historyChunksRef.current = chunks;

    // A discontinuity invalidates the decision that was derived from the
    // interrupted data. It is invalidated HERE - immediately - instead of
    // waiting for the next evaluation: until the affected pair's history has
    // been recovered, the previous decision is not a current trading
    // opportunity. The retained signal of an affected pair is dropped as well,
    // because it would otherwise repopulate the panel with the
    // pre-discontinuity decision. A pair that was not affected keeps its
    // decision.
    const invalidateAffectedDecisions = () => {
      const affectedPairs = collectAffectedPairs(candleManagerRef.current);
      if (affectedPairs.length > 0) {
        const displayed = {
          symbolId: selectedSymbolRef.current.id,
          timeframe: selectedTimeframeRef.current,
        };
        setDecision((prev) =>
          invalidateDecisionsForDiscontinuity(prev, affectedPairs, displayed)
        );
      }
    };

    // Status Listener
    const unsubStatus = client.onStatusChange((newStatus) => {
      setStatus(newStatus);
      if (newStatus === 'CONNECTED') {
        // Retry the active pair's backfill after a reconnection; a request
        // abandoned by the previous connection was failed and its pending
        // marker cleared, so this is permitted rather than skipped. An explicit
        // load also resets the pair's recovery budget for the new connection.
        ensureHistoryLoaded(selectedSymbolRef.current.id, selectedTimeframeRef.current);
      } else {
        // A non-connected status means the ticks of an unknown stretch of time
        // were never observed. Every tracked symbol is marked as interrupted so
        // the candle that spans the gap is never finalized as a valid close and
        // the affected pair must recover its history before it is evaluated
        // again.
        for (const symbolId of candleManagerRef.current.getTrackedSymbols()) {
          candleManagerRef.current.markDiscontinuity(symbolId);
        }
        invalidateAffectedDecisions();
        // Any non-connected state invalidates scheduled retries.
        recovery.cancelAll();
      }
    });

    // Log Listener
    const unsubLog = client.onLog((entry) => {
      addLog(entry);
    });

    // A symbol that became live again WITHOUT a reconnect still owes the
    // recovery its stale episode required. Resume it through the existing
    // bounded request path. The discontinuity is not re-marked (the original
    // anchor survives), the consumed retry budget is untouched, and repeated
    // notifications cannot create duplicate work.
    const resumeRecoveryAfterLive = (symbol: string) => {
      if (symbol !== selectedSymbolRef.current.id) return;
      const tf = selectedTimeframeRef.current;
      const bookkeeping = historyBookRef.current;
      const recoveryController = historyRecoveryRef.current;
      const chunks = historyChunksRef.current;
      resumeStaleRecovery({
        isRecoveryRequired: () => candleManagerRef.current.isRecoveryRequired(symbol, tf),
        isRequestPending: () => bookkeeping.pending.has(historyKey(symbol, tf)),
        isRetryScheduled: () => recoveryController?.isScheduled(symbol, tf) ?? false,
        isChunkActive: () => chunks?.isActive(symbol, tf) ?? false,
        hasRetryBudget: () => recoveryController?.hasAttemptsLeft(symbol, tf) ?? true,
        requestHistory: () => requestHistory(symbol, tf),
      });
    };

    // Stale Tick Listener - a stale feed is a discontinuity: the ticks of an
    // unknown stretch of time were not observed, so the candle spanning the gap
    // must never be finalized as a valid close. The stale symbol is marked as
    // interrupted through the SAME lifecycle as a non-connected status, so a
    // late tick cannot bypass the required history recovery, and the decision
    // derived from the interrupted data is invalidated immediately. The client
    // emits this only on a real transition (staleness is idempotent), so a
    // repeated callback cannot duplicate the cycle; a new episode emits again.
    const unsubStale = client.onStale((symbol, isStale, seconds) => {
      if (!isStale) {
        // STALE -> LIVE without a reconnect: resume the outstanding recovery.
        resumeRecoveryAfterLive(symbol);
        return;
      }
      addLog({
        id: Math.random().toString(36).substring(2, 9),
        timestamp: new Date(),
        level: 'warn',
        message: `Symbol ${symbol} stopped receiving ticks (${seconds}s since last tick)`,
      });
      candleManagerRef.current.markDiscontinuity(symbol);
      invalidateAffectedDecisions();
      // Only the affected pair's scheduled retry is invalidated; another
      // symbol going stale must not cancel the selected pair's recovery.
      recovery.cancel(symbol, selectedTimeframeRef.current);
    });

    // Feed Status Listener - per-symbol live/stale/pending/closed/unavailable.
    const unsubFeed = client.onFeedStatus((status) => {
      setFeedStatuses((prev) => {
        const next = new Map(prev);
        next.set(status.symbol, status);
        return next;
      });
      if (status.state === 'CLOSED' || status.state === 'UNAVAILABLE') {
        addLog({
          id: Math.random().toString(36).substring(2, 9),
          timestamp: new Date(),
          level: 'warn',
          message: `[${status.symbol}] Feed ${status.state.toLowerCase()}${
            status.errorMessage ? `: ${status.errorMessage}` : ''
          }`,
        });
      }
    });

    // Tick Listener - processes ticks across all symbols & timeframes
    const unsubTick = client.onTick((tick: TickData) => {
      // The candle manager owns the ordering of the market events: it tracks
      // the event time of the newest ACCEPTED event. A tick that is older than
      // that is out of order, so it must not move the displayed live edge (or
      // the displayed price) backwards.
      const knownEpoch =
        candleManagerRef.current.getState(tick.symbol)?.lastTickTime ?? null;
      const accepted = knownEpoch === null || tick.epoch >= knownEpoch;

      // 1. Process tick through candle manager (updates all timeframes for tick.symbol)
      candleManagerRef.current.processTick(tick);

      // 2. Update reactive price maps
      if (accepted) {
        setPrices((prev) => {
          const next = new Map(prev);
          next.set(tick.symbol, tick.price);
          return next;
        });

        setLastTickEpochs((prev) => {
          const next = new Map(prev);
          next.set(tick.symbol, tick.epoch);
          return next;
        });
      }

      setTotalTicks(client.getTickCount());

      // 3. If tick is for currently active symbol, update local active candle state
      if (tick.symbol === selectedSymbolRef.current.id) {
        refreshActiveCandles();
      }
    });

    // Candle Close Listener
    const unsubCandleClose = candleManagerRef.current.onCandleClose(
      (sym, tf, closedCandle) => {
        addLog({
          id: Math.random().toString(36).substring(2, 9),
          timestamp: new Date(),
          level: 'info',
          message: `[${sym}] ${tf.toUpperCase()} candle closed @ ${closedCandle.close} (H:${closedCandle.high} L:${closedCandle.low})`,
        });

        // If closed candle matches the currently active view, refresh chart
        if (sym === selectedSymbolRef.current.id && tf === selectedTimeframeRef.current) {
          refreshActiveCandles();
        }

        // Trigger analysis run on closed candle only when the event belongs to
        // the currently selected symbol AND timeframe, so a non-selected
        // timeframe's close cannot overwrite the active chart's analysis.
        if (isSelectedPair(sym, tf, selectedSymbolRef.current.id, selectedTimeframeRef.current)) {
          const evaluation = evaluateSignalForSelection(sym, tf);
          // Phase 1: a notification may only be raised for a signal confirmed by
          // this just-closed candle of the active pair. Backfill, selection, and
          // reconnect re-evaluations never reach this path. A pair whose history
          // recovery is still pending is not evaluated at all (null), so it can
          // never raise a notification.
          if (evaluation) {
            handleCandleClose({
              signal: evaluation.signal,
              symbolId: sym,
              timeframe: tf,
              confirmingCandleEpoch: closedCandle.epoch,
            });
          }
        }
      }
    );

    // Candle Update Listener
    const unsubCandleUpdate = candleManagerRef.current.onCandleUpdate(
      (sym, tf, formingCandle) => {
        if (sym === selectedSymbolRef.current.id && tf === selectedTimeframeRef.current) {
          setCurrentCandle({ ...formingCandle });
        }
      }
    );

    // Connect to Deriv WebSocket
    client.connect();

    // Subscribe to all 8 supported symbols so watchlist has real-time live prices
    SUPPORTED_SYMBOLS.forEach((sym) => {
      client.subscribeTicks(sym.id);
    });

    // Initial historical candle backfill for the default symbol & timeframe
    ensureHistoryLoaded(selectedSymbolRef.current.id, selectedTimeframeRef.current);

    // Cleanup on unmount
    return () => {
      recovery.cancelAll();
      historyRecoveryRef.current = null;
      chunks.cancelAll();
      historyChunksRef.current = null;
      unsubStatus();
      unsubLog();
      unsubStale();
      unsubFeed();
      unsubTick();
      unsubCandleClose();
      unsubCandleUpdate();
      client.disconnect();
    };
  }, [addLog, refreshActiveCandles, ensureHistoryLoaded, evaluateSignalForSelection, requestHistory, handleCandleClose]);

  // Handle Switching Active Symbol
  const handleSelectSymbol = useCallback((sym: DerivSymbolConfig) => {
    setSelectedSymbol(sym);
    selectedSymbolRef.current = sym;

    const currentTf = selectedTimeframeRef.current;

    // Refresh immediately with any existing cached data, then evaluate the
    // pair's signal (clearing a previous selection's stale result), then
    // guarantee a historical backfill for this pair. Scheduled retries for the
    // previous selection are dropped.
    refreshActiveCandles();
    evaluateSignalForSelection(sym.id, currentTf);
    historyRecoveryRef.current?.cancelAll();
    ensureHistoryLoaded(sym.id, currentTf);

    addLog({
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date(),
      level: 'info',
      message: `Active symbol switched to ${sym.id} (${sym.displayName})`,
    });
  }, [addLog, refreshActiveCandles, ensureHistoryLoaded, evaluateSignalForSelection]);

  // Handle Switching Active Timeframe
  const handleSelectTimeframe = useCallback((tf: Timeframe) => {
    setTimeframe(tf);
    selectedTimeframeRef.current = tf;

    const sym = selectedSymbolRef.current;

    // Refresh immediately with any existing cached data, then evaluate the
    // pair's signal (clearing any stale result for the previous timeframe),
    // then guarantee a historical backfill for this pair. Scheduled retries for
    // the previous selection are dropped.
    refreshActiveCandles();
    evaluateSignalForSelection(sym.id, tf);
    historyRecoveryRef.current?.cancelAll();
    ensureHistoryLoaded(sym.id, tf);

    addLog({
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date(),
      level: 'info',
      message: `Timeframe changed to ${tf.toUpperCase()} for ${sym.id}`,
    });
  }, [addLog, refreshActiveCandles, ensureHistoryLoaded, evaluateSignalForSelection]);

  const handleReconnect = () => {
    if (wsClientRef.current) {
      addLog({
        id: Math.random().toString(36).substring(2, 9),
        timestamp: new Date(),
        level: 'warn',
        message: 'Manual reconnect triggered by operator',
      });
      wsClientRef.current.disconnect();
      wsClientRef.current.connect();
    }
  };

  const handleClearLogs = () => {
    setLogs([]);
  };

  const currentPrice = prices.get(selectedSymbol.id) ?? null;
  const lastTickEpoch = lastTickEpochs.get(selectedSymbol.id) ?? null;
  const isWsActive = status === 'CONNECTED';
  const currentFeed = feedStatuses.get(selectedSymbol.id);
  const currentFeedState = currentFeed?.state ?? 'IDLE';

  // Reference price baseline for the SMC panel: the close of the most recent
  // closed candle. `chartCandles` is exactly the closed-candle history passed to
  // `SMCEngine.analyze`, so its last entry matches the engine's premium/discount
  // analysis price (no forming candle, no invented price). Derived inline to avoid
  // introducing an extra state update / render.
  const referencePrice =
    chartCandles.length > 0 ? chartCandles[chartCandles.length - 1].close : null;

  // Epoch of the most recent completed candle, used by the signal panel to
  // disclose how old the evaluated data is independently of wall-clock time.
  const lastClosedCandleEpoch =
    chartCandles.length > 0 ? chartCandles[chartCandles.length - 1].epoch : null;

  // Retained signal for the currently selected pair only. The lookup key is the
  // live selection, so an old EURUSD signal is never retrieved for XAUUSD, and a
  // signal from one timeframe is never shown for another.
  const lastGeneratedSignal = getRetainedSignal(decision, {
    symbolId: selectedSymbol.id,
    timeframe,
  });

  return (
    <div className="terminal-container">
      {/* 1. TOP HEADER */}
      <Header
        status={status}
        selectedSymbol={selectedSymbol}
        currentPrice={currentPrice}
        lastTickEpoch={lastTickEpoch}
        feedState={currentFeedState}
        onReconnect={handleReconnect}
      />

      {/* DASHBOARD WORKSPACE GRID */}
      <main className="dashboard-grid">
        {/* 2. SYMBOL WATCHLIST (LEFT) */}
        <Watchlist
          selectedSymbolId={selectedSymbol.id}
          onSelectSymbol={handleSelectSymbol}
          prices={prices}
          feedStatuses={feedStatuses}
        />

        {/* 3. MAIN CANDLESTICK CHART AREA (CENTER) */}
        <CandleChart
          symbolId={selectedSymbol.id}
          candles={chartCandles}
          currentCandle={currentCandle}
          timeframe={timeframe}
          onTimeframeChange={handleSelectTimeframe}
          pipSize={selectedSymbol.pipSize}
          lastPrice={currentPrice}
          swings={decision.analysis?.marketStructure?.swings ?? []}
          breaks={decision.analysis?.marketStructure?.breaks ?? []}
        />

        {/* RIGHT COLUMN: SMC ANALYSIS & MARKET STRUCTURE */}
        <div className="side-panel">
          {/* 4. MARKET STRUCTURE PANEL */}
          <MarketStructurePanel data={decision.analysis?.marketStructure} />

          {/* 5. SMC ANALYSIS PANEL */}
          <SMCAnalysisPanel data={decision.analysis} referencePrice={referencePrice} />
        </div>

        {/* BOTTOM METRICS ROW: SIGNAL, MARKET DATA, RISK */}
        <div className="bottom-panels-row">
          {/* 6. SIGNAL PANEL */}
          <SignalPanel
            signal={decision.signal}
            lastGeneratedSignal={lastGeneratedSignal}
            symbolId={selectedSymbol.id}
            displayName={selectedSymbol.displayName}
            timeframe={timeframe}
            marketBias={decision.analysis?.marketStructure?.structuralBias ?? null}
            region={decision.analysis?.zone ?? null}
            direction={decision.direction}
            evaluatedAt={decision.evaluatedAt}
            hasClosedCandles={chartCandles.length > 0}
            feedState={currentFeedState}
            lastClosedCandleEpoch={lastClosedCandleEpoch}
          />

          {/* 7. MARKET DATA PANEL */}
          <MarketDataPanel
            status={status}
            isWsActive={isWsActive}
            totalTicks={totalTicks}
            lastTickEpoch={lastTickEpoch}
            activeTimeframe={timeframe}
            activeCandlesCount={chartCandles.length}
            candles1mCount={candleManagerRef.current.getHistory(selectedSymbol.id, '1m').length}
            feedState={currentFeedState}
            feedMessage={currentFeed?.errorMessage}
            selectedSymbolId={selectedSymbol.id}
          />

          {/* 9. RISK PANEL (FUTURE READY / SAFEGUARDED) */}
          <RiskPanel />
        </div>

        {/* 8. LIVE EVENT LOG (FULL WIDTH BOTTOM) */}
        <EventLogPanel logs={logs} onClearLogs={handleClearLogs} />
      </main>

      {/* PHASE 1: NEW-SIGNAL NOTIFICATIONS (fixed overlay, preserves layout) */}
      <NotificationCenter
        notifications={notifications}
        onDismiss={dismissNotification}
        onClear={clearNotifications}
        desktopState={desktopState}
        desktopPreferenceEnabled={preferences.desktop}
        onEnableDesktop={enableDesktop}
        soundEnabled={preferences.sound}
        onToggleSound={setSoundEnabled}
        storageAvailable={storageAvailable}
        onSendTestNotification={notificationTestEnabled ? sendTestNotification : undefined}
      />
    </div>
  );
}
