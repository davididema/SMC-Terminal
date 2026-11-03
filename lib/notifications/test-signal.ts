/**
 * Manual notification delivery test (development-only).
 *
 * This exists solely so a developer can confirm in-app delivery and sound
 * without waiting for a genuine trading signal. It is intentionally ISOLATED
 * from real signal processing:
 *
 * - it never calls the signal engine, the detector, or the SMC pipeline;
 * - it never writes to the retained signal history (`lastGeneratedSignals`) or
 *   the engine's duplicate-suppression state;
 * - its event is never a LONG/SHORT (`decision: 'NO_TRADE'`, no prices) and is
 *   rendered with a distinct "NOTIFICATION TEST" label.
 *
 * It reuses only the existing delivery layer (`dispatchNotification`).
 */

import type { GeneratedSignalEvent } from './types';

export const NOTIFICATION_TEST_SIGNAL_ID_PREFIX = '__notification-test__';

export const TEST_NOTIFICATION_TITLE = 'Notification test';

export const TEST_NOTIFICATION_BODY =
  'In-app delivery reached this point. This is not a trading signal.';

/**
 * True unless the build is a production build. `process.env.NODE_ENV` is
 * statically replaced by Next.js at build time, so this is `false` in
 * production and the dev-only control is never enabled there.
 */
export function isNotificationTestEnabled(
  nodeEnv: string | undefined = process.env.NODE_ENV
): boolean {
  return nodeEnv !== 'production';
}

/**
 * Builds a clearly-labelled, non-trading delivery test event. `nonce` makes each
 * invocation's identity unique (so repeated tests never collide as notification
 * keys); it is a caller-provided value purely for determinism in tests.
 */
export function buildTestNotificationEvent(nonce: string): GeneratedSignalEvent {
  return {
    signalId: `${NOTIFICATION_TEST_SIGNAL_ID_PREFIX}:${nonce}`,
    pairKey: 'TEST:TEST',
    symbolId: 'TEST',
    timeframe: 'TEST',
    isTest: true,
    signal: {
      decision: 'NO_TRADE',
      confidence: null,
      setup: 'NONE',
      entry: null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      reason: 'Manual notification delivery test. Not a trading signal.',
      timestamp: 0,
    },
  };
}
