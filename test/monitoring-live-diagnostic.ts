/**
 * Phase 2B Stage 2D — bounded, explicitly-invoked live diagnostic runner.
 *
 * This is NOT a test and is NOT run by `npm run test:all`, `next build`, or the
 * dashboard. It is run manually (`npm run monitor:live`) to observe the
 * read-only acquisition adapter against the REAL Deriv public WebSocket and to
 * print structured, honest evidence: connection/subscription acceptance is
 * reported separately from genuinely-received ticks and closed candles, and
 * nothing is ever fabricated.
 *
 * It places no orders, performs no account authorization, and delivers no
 * notifications. By default it writes nothing to disk. Opt-in fixture
 * recording (Stage 3) is development-only and off unless
 * `SMC_RECORD_SIGNAL_FIXTURE=1` (never enabled in production): when enabled,
 * each accepted genuine signal also writes one fixture under
 * `test/fixtures/genuine/` containing that evaluation's exact candle input.
 */

import { DerivWebSocketClient } from '../lib/deriv/websocket';
import { CandleManager, Timeframe, TIMEFRAME_SECONDS } from '../lib/deriv/candles';
import { MonitoringCore, PairEvaluationReport } from '../lib/monitoring/headless-core';
import {
  createSignalRecorderFromEnv,
  describeFixtureRecording,
} from '../lib/monitoring/signal-recorder-file';
import {
  LiveAcquisitionAdapter,
  MonitoringEvaluationTarget,
  MonitoringObservation,
} from '../lib/monitoring/live-acquisition';
import {
  collectZones,
  getTriggerKind,
  isTriggerFresh,
  opposingLiquidityLevels,
  resolveDirectionalContext,
  selectLatestActionableBreak,
  SignalEngine,
  type RiskRewardObserver,
} from '../lib/signals/signal-engine';
import {
  describeZoneSweep,
  unavailableZoneSweep,
  type ZoneSweepDiagnostic,
} from '../lib/monitoring/zone-sweep-diagnostic';
import type { BreakType } from '../lib/analysis/structure-breaks';
import WebSocket from 'ws';

// The adapter relies on the client, which resolves a WebSocket constructor from
// the global scope. Provide one from `ws` under Node when absent.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
}

// --- Bounded configuration (override duration via env) ---------------------

const PAIRS: Array<{ symbolId: string; timeframe: Timeframe }> = [
  { symbolId: 'V75', timeframe: '1m' },
];
const HISTORY_COUNT = 100;
// Long enough to cover a 1m period rollover, short enough to be bounded.
const DURATION_MS = Number(process.env.MONITOR_DURATION_MS ?? 90_000);

function line(tag: string, message: string): void {
  console.log(`${tag.padEnd(13)} ${message}`);
}

function describe(o: MonitoringObservation): { tag: string; message: string } {
  const at = o.at.toISOString();
  switch (o.type) {
    case 'connection':
      return { tag: '[connection]', message: `${at} status=${o.status}` };
    case 'feed':
      return {
        tag: '[feed]',
        message: `${at} ${o.symbolId} state=${o.state}${
          o.errorCode ? ` code=${o.errorCode}` : ''
        }${o.errorMessage ? ` msg="${o.errorMessage}"` : ''}`,
      };
    case 'history':
      return {
        tag: '[history]',
        message: `${at} ${o.pairKey} outcome=${o.outcome} candles=${o.candleCount}`,
      };
    case 'candle-close':
      return {
        tag: '[close]',
        message: `${at} ${o.pairKey} epoch=${o.epoch} close=${o.close} (GENUINE closed candle)`,
      };
    case 'evaluation':
      return {
        tag: '[eval]',
        message: `${at} ${o.pairKey} epoch=${o.epoch} decision=${o.decision}${
          o.signalId ? ` signalId=${o.signalId}` : ''
        }${o.rejectionReasons?.length ? ` reasons=[${o.rejectionReasons.join(',')}]` : ''}`,
      };
    case 'candidate':
      return {
        tag: '[candidate]',
        message: `${at} ${o.pairKey} epoch=${o.epoch} signalId=${o.signalId}`,
      };
    case 'error':
      return {
        tag: '[error]',
        message: `${at} pair=${o.pairKey ?? '-'} stage=${o.stage} ${o.message}`,
      };
  }
}

// --- NO_CONTEXT diagnostic ([context] line) -------------------------------
//
// Runner-only observation: it reads the analysis the evaluation ALREADY
// produced (it never re-reads candles, never re-analyzes, never initiates a
// market request) so it can distinguish the two causes of `NO_CONTEXT`:
// no actionable BOS/CHoCH at all, versus an actionable BOS whose structural
// bias is neutral/contradictory. It changes no strategy rule, threshold, or
// rejection reason, and a diagnostic failure can never alter the evaluation
// result it observes.

type ContextClassification =
  | 'NO_ACTIONABLE_BREAK'
  | 'INVALID_BOS_CONTEXT'
  | 'VALID_CONTEXT'
  | 'DIAGNOSTIC_UNAVAILABLE';

interface ContextDiagnostic {
  message: string;
  classification: ContextClassification;
}

/** Fixed presentation order for the break-type counts (unknown extra types follow, sorted). */
const BREAK_TYPE_ORDER: readonly BreakType[] = [
  'BULLISH_BOS',
  'BEARISH_BOS',
  'BULLISH_CHOCH',
  'BEARISH_CHOCH',
  'INITIAL_BULLISH_BREAK',
  'INITIAL_BEARISH_BREAK',
];

const contextCounts = { emitted: 0, unavailable: 0 };
const zoneSweepCounts = { emitted: 0, unavailable: 0 };

/**
 * Builds one `[context]` record from the report the core just produced, using
 * the existing exported pure selection/context/freshness functions. Any field
 * that cannot be computed reliably from that report is reported as `n/a`; the
 * record is classified `DIAGNOSTIC_UNAVAILABLE` rather than guessed.
 */
function describeContext(report: PairEvaluationReport): ContextDiagnostic {
  const head = `${report.pairKey} epoch=${report.confirmingCandleEpoch ?? 'none'}`;
  const unavailable = (reason: string): ContextDiagnostic => ({
    classification: 'DIAGNOSTIC_UNAVAILABLE',
    message:
      `${head} bias=n/a swings=n/a breaks=n/a latest=none ` +
      `ageBars=n/a fresh=n/a class=DIAGNOSTIC_UNAVAILABLE reason=${reason}`,
  });

  const evaluation = report.evaluation;
  if (
    evaluation === null ||
    evaluation === undefined ||
    evaluation.signal === null ||
    evaluation.closedCandleCount === 0
  ) {
    // Nothing was evaluated (no closed candles): no evaluation to diagnose.
    return unavailable('no-closed-candles');
  }

  const marketStructure = evaluation.analysis?.marketStructure;
  if (
    marketStructure === null ||
    marketStructure === undefined ||
    !Array.isArray(marketStructure.swings) ||
    !Array.isArray(marketStructure.breaks) ||
    (marketStructure.structuralBias !== 'BULLISH' &&
      marketStructure.structuralBias !== 'BEARISH' &&
      marketStructure.structuralBias !== 'NEUTRAL') ||
    !marketStructure.breaks.every(
      (b) =>
        b !== null &&
        b !== undefined &&
        typeof b.type === 'string' &&
        typeof b.direction === 'string' &&
        typeof b.confirmedAtEpoch === 'number' &&
        Number.isFinite(b.confirmedAtEpoch)
    )
  ) {
    return unavailable('analysis-unavailable');
  }

  const bias = marketStructure.structuralBias;
  const swingCount = marketStructure.swings.length;

  const counts = new Map<string, number>();
  for (const brk of marketStructure.breaks) {
    counts.set(brk.type, (counts.get(brk.type) ?? 0) + 1);
  }
  const orderedTypes = [
    ...BREAK_TYPE_ORDER.filter((t) => counts.has(t)),
    ...[...counts.keys()]
      .filter((t) => !(BREAK_TYPE_ORDER as readonly string[]).includes(t))
      .sort(),
  ];
  const breaksField =
    orderedTypes.length === 0
      ? '[]'
      : `[${orderedTypes.map((t) => `${t}:${counts.get(t) ?? 0}`).join(',')}]`;

  const latest = selectLatestActionableBreak(marketStructure.breaks);
  let latestField = 'none';
  let ageField = 'n/a';
  let freshField = 'n/a';
  let classification: ContextClassification;
  let reason: string | null = null;

  if (latest === null) {
    classification = 'NO_ACTIONABLE_BREAK';
  } else {
    latestField = `${latest.type}/${latest.direction}`;
    const context = resolveDirectionalContext(latest, bias);
    if (context.valid) {
      classification = 'VALID_CONTEXT';
    } else if (getTriggerKind(latest) === 'BOS') {
      // The only invalid-context case the current rules can produce: an
      // actionable BOS with neutral or contradicting structural bias.
      classification = 'INVALID_BOS_CONTEXT';
    } else {
      // Cannot occur with the current context rules (a CHoCH always yields a
      // valid context); report rather than mislabel.
      classification = 'DIAGNOSTIC_UNAVAILABLE';
      reason = 'context-logic-inconsistent';
    }

    // Freshness is only ever reported as the result of actually evaluating it.
    const signalEpoch = report.confirmingCandleEpoch;
    const secondsPerBar = TIMEFRAME_SECONDS[report.timeframe];
    if (
      signalEpoch !== null &&
      Number.isFinite(signalEpoch) &&
      Number.isFinite(secondsPerBar) &&
      secondsPerBar > 0
    ) {
      const ageBars = (signalEpoch - latest.confirmedAtEpoch) / secondsPerBar;
      if (Number.isFinite(ageBars)) {
        ageField = Number.isInteger(ageBars) ? String(ageBars) : ageBars.toFixed(2);
        freshField = String(isTriggerFresh(latest, signalEpoch, report.timeframe));
      }
    }
  }

  const parts = [
    head,
    `bias=${bias}`,
    `swings=${swingCount}`,
    `breaks=${breaksField}`,
    `latest=${latestField}`,
    `ageBars=${ageField}`,
    `fresh=${freshField}`,
    `class=${classification}`,
  ];
  if (reason !== null) parts.push(`reason=${reason}`);
  return { message: parts.join(' '), classification };
}

/**
 * Emits exactly one `[context]` record per evaluation. Any failure inside the
 * diagnostic itself is contained here: the original report is still returned
 * to the caller unchanged.
 */
function emitContextDiagnostic(report: PairEvaluationReport, fallbackPair: string): void {
  contextCounts.emitted += 1;
  try {
    const { message, classification } = describeContext(report);
    if (classification === 'DIAGNOSTIC_UNAVAILABLE') contextCounts.unavailable += 1;
    line('[context]', message);
  } catch (err) {
    contextCounts.unavailable += 1;
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    try {
      line(
        '[context]',
        `${fallbackPair} bias=n/a swings=n/a breaks=n/a latest=none ` +
          `ageBars=n/a fresh=n/a class=DIAGNOSTIC_UNAVAILABLE reason=diagnostic-error:${reason}`
      );
    } catch {
      // Output failure inside the diagnostic must never propagate into the
      // evaluation; the original report is returned regardless.
    }
  }
}

// --- Zone / liquidity-sweep diagnostic ([zone] line) -----------------------
//
// Runner-only observation: like the [context] line above, it reads the analysis
// the evaluation ALREADY produced. It never re-reads candles, never re-analyzes,
// never initiates a market request, never changes an order of execution, a
// rejection reason, or a decision. It only exposes the premium/discount zone and
// opposing-liquidity sweep state behind the Tier 2 rejections. Any failure is
// contained below and can never change the report the caller receives.

function describeZoneSweepForReport(report: PairEvaluationReport): ZoneSweepDiagnostic {
  const signalEpoch = report.confirmingCandleEpoch;
  const evaluation = report.evaluation;
  if (
    evaluation === null ||
    evaluation === undefined ||
    evaluation.signal === null ||
    evaluation.closedCandleCount === 0
  ) {
    return unavailableZoneSweep(report.pairKey, signalEpoch, 'no-closed-candles');
  }

  const analysis = evaluation.analysis;
  if (
    analysis === null ||
    analysis === undefined ||
    analysis.marketStructure === null ||
    analysis.marketStructure === undefined ||
    !Array.isArray(analysis.marketStructure.breaks) ||
    !Array.isArray(analysis.marketStructure.swings) ||
    (analysis.marketStructure.structuralBias !== 'BULLISH' &&
      analysis.marketStructure.structuralBias !== 'BEARISH' &&
      analysis.marketStructure.structuralBias !== 'NEUTRAL') ||
    typeof analysis.zone !== 'string' ||
    analysis.liquidity === null ||
    analysis.liquidity === undefined ||
    analysis.fvg === null ||
    analysis.fvg === undefined ||
    analysis.orderBlocks === null ||
    analysis.orderBlocks === undefined
  ) {
    return unavailableZoneSweep(report.pairKey, signalEpoch, 'analysis-unavailable');
  }

  const direction = evaluation.direction;
  const zones = collectZones(analysis.fvg, analysis.orderBlocks);
  const opposingLevels = direction !== null ? opposingLiquidityLevels(analysis, direction) : [];

  return describeZoneSweep({
    pairKey: report.pairKey,
    signalEpoch,
    timeframe: report.timeframe,
    zone: analysis.zone,
    structuralBias: analysis.marketStructure.structuralBias,
    breaks: analysis.marketStructure.breaks,
    direction,
    zones,
    opposingLevels,
    rejectionReasons: evaluation.signal.rejectionReasons,
  });
}

/**
 * Emits exactly one `[zone]` record per evaluation. Any failure inside the
 * diagnostic itself is contained here: the original report is still returned to
 * the caller unchanged.
 */
function emitZoneSweepDiagnostic(report: PairEvaluationReport, fallbackPair: string): void {
  zoneSweepCounts.emitted += 1;
  try {
    const { message, classification } = describeZoneSweepForReport(report);
    if (classification === 'DIAGNOSTIC_UNAVAILABLE') zoneSweepCounts.unavailable += 1;
    line('[zone]', message);
  } catch (err) {
    zoneSweepCounts.unavailable += 1;
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    try {
      line('[zone]', unavailableZoneSweep(fallbackPair, null, `diagnostic-error:${reason}`).message);
    } catch {
      // Output failure inside the diagnostic must never propagate into the
      // evaluation; the original report is returned regardless.
    }
  }
}

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('LIVE READ-ONLY ACQUISITION DIAGNOSTIC (Phase 2B Stage 2D)');
  console.log('================================================================');
  console.log(`Endpoint:    ${process.env.NEXT_PUBLIC_DERIV_WS_URL ?? '(default public endpoint)'}`);
  console.log(`Pairs:       ${PAIRS.map((p) => `${p.symbolId}[${p.timeframe}]`).join(', ')}`);
  console.log(`History:     ${HISTORY_COUNT} candles per pair`);
  console.log(`Duration:    ${DURATION_MS} ms`);
  console.log('');
  console.log('NOTE: a connection or subscription being ACCEPTED is not proof of');
  console.log('usable data. Genuine data is reported only as received ticks /');
  console.log('closed candles. Nothing here is fabricated.');
  console.log('----------------------------------------------------------------');

  // Stage 3 opt-in fixture recording (development-only, off by default).
  const fixtureCounts = { recorded: 0, refused: 0 };
  const recorder = createSignalRecorderFromEnv(process.env, {
    onAttempt: (attempt) => {
      if (attempt.recorded) fixtureCounts.recorded += 1;
      else fixtureCounts.refused += 1;
    },
  });
  console.log(`Fixture recording: ${describeFixtureRecording(process.env)}`);
  console.log('----------------------------------------------------------------');

  const client = new DerivWebSocketClient();

  // Observational only: receives the exact R:R values the existing target-selection loop already
  // computed for each candidate, plus the configured minimum. It never feeds back into a decision.
  // Absent in ordinary application operation; injected only by this manual runner.
  const rrCounts = { candidates: 0, metMinimum: 0, selected: 0 };
  const riskRewardObserver: RiskRewardObserver = (o) => {
    rrCounts.candidates += 1;
    if (o.meetsMinimum) rrCounts.metMinimum += 1;
    if (o.selected) rrCounts.selected += 1;
    const rr = o.riskReward === null ? 'n/a' : String(o.riskReward);
    line(
      '[rr]',
      `${o.symbol}:${o.timeframe} dir=${o.direction} entry=${o.entry} sl=${o.stopLoss} ` +
        `tp=${o.target} rr=${rr} min=${o.minimum} meets=${o.meetsMinimum} ` +
        `selected=${o.selected} rejection=${o.rejection ?? 'none'}`
    );
  };

  const core = new MonitoringCore({
    candleManager: new CandleManager(500),
    signalEngine: new SignalEngine({ riskRewardObserver }),
    recorder: recorder ?? undefined,
  });

  // Runner-only injection point: the adapter takes the existing
  // `MonitoringEvaluationTarget` shape, so a thin wrapper can observe each
  // evaluation report the core already produced (for the `[context]` line)
  // and return it untouched. The wrapper exposes the SAME `CandleManager`
  // instance the core owns, so seeding, candle-close handling, dedup,
  // detection, notifications, and fixture recording are unchanged.
  const diagnosticTarget: MonitoringEvaluationTarget = {
    candleManager: core.candleManager,
    evaluatePair: (symbolId: string, timeframe: Timeframe): PairEvaluationReport => {
      const report = core.evaluatePair(symbolId, timeframe);
      emitContextDiagnostic(report, `${symbolId}:${timeframe}`);
      emitZoneSweepDiagnostic(report, `${symbolId}:${timeframe}`);
      return report;
    },
  };

  const adapter = new LiveAcquisitionAdapter(client, diagnosticTarget, {
    pairs: PAIRS,
    historyCount: HISTORY_COUNT,
  });

  const counts = {
    connection: 0,
    feed: 0,
    history: 0,
    close: 0,
    evaluation: 0,
    candidate: 0,
    error: 0,
  };

  adapter.onObservation((o) => {
    const { tag, message } = describe(o);
    if (o.type === 'candle-close') counts.close += 1;
    else if (o.type in counts) counts[o.type as keyof typeof counts] += 1;
    line(tag, message);
  });

  adapter.start();

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));

  const states = adapter.getState();
  const connectionStatus = adapter.getConnectionStatus();

  console.log('----------------------------------------------------------------');
  console.log('FINAL PER-PAIR STATE');
  console.log('----------------------------------------------------------------');
  for (const st of states) {
    console.log(`  ${st.pairKey}`);
    console.log(`    connectionStatus : ${st.connectionStatus}`);
    console.log(`    feedState        : ${st.feedState}${st.feedErrorCode ? ` (${st.feedErrorCode})` : ''}`);
    console.log(`    lastTickEpoch    : ${st.lastTickEpoch ?? 'none'}`);
    console.log(`    history          : ${st.historyStatus} (${st.historyCandleCount} candles)`);
    console.log(`    lastClosedCandle : ${st.lastClosedCandleEpoch ?? 'none'} @ ${st.lastClosedCandleAt?.toISOString() ?? '-'}`);
    console.log(`    evaluations      : ${st.evaluationCount}`);
    console.log(`    lastSignal       : ${st.lastSignal?.decision ?? 'none'}`);
    console.log(`    candidates       : ${st.candidateCount}`);
  }

  // Clean shutdown (read-only).
  adapter.stop();

  const genuineData =
    counts.close > 0 || states.some((s) => s.lastTickEpoch !== null);
  const historySeeded = states.some((s) => s.historyStatus === 'success');

  console.log('----------------------------------------------------------------');
  console.log('SUMMARY (honest)');
  console.log('----------------------------------------------------------------');
  console.log(`  final connection status   : ${connectionStatus}`);
  console.log(`  history seeded            : ${historySeeded ? 'yes' : 'no'}`);
  console.log(`  genuine closed candles    : ${counts.close}`);
  console.log(`  evaluations               : ${counts.evaluation}`);
  console.log(
    `  context diagnostics        : ${contextCounts.emitted} emitted, ${contextCounts.unavailable} unavailable`
  );
  console.log(
    `  zone/sweep diagnostics     : ${zoneSweepCounts.emitted} emitted, ${zoneSweepCounts.unavailable} unavailable`
  );
  console.log(
    `  risk/reward observations   : ${rrCounts.candidates} candidates, ${rrCounts.metMinimum} at/above minimum, ${rrCounts.selected} selected`
  );
  console.log(`  notification candidates   : ${counts.candidate}`);
  console.log(
    `  fixture recordings        : ${fixtureCounts.recorded} written, ${fixtureCounts.refused} refused`
  );
  console.log(`  observations: connection=${counts.connection} feed=${counts.feed} history=${counts.history} close=${counts.close} eval=${counts.evaluation} candidate=${counts.candidate} error=${counts.error}`);
  console.log(
    `  genuine market data        : ${
      genuineData ? 'received' : 'NONE observed within the window'
    }`
  );
  console.log('================================================================');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error during live diagnostic:', err);
  process.exit(1);
});
