import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HistoryRecoveryController,
  DEFAULT_HISTORY_RECOVERY_POLICY,
} from '../lib/deriv/history-recovery';

/**
 * Deterministic tests for the bounded history-recovery controller. Retries are
 * driven by real (but tiny) timers, matching the harness used by the request
 * registry tests. `onRetry` is a spy so no WebSocket is involved.
 */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the default policy bounds retries and spaces them out', () => {
  assert.equal(DEFAULT_HISTORY_RECOVERY_POLICY.maxAttempts, 3);
  assert.equal(DEFAULT_HISTORY_RECOVERY_POLICY.delayMs, 3000);
});

test('a success outcome resets the budget and schedules nothing', async () => {
  const retries: number[] = [];
  const controller = new HistoryRecoveryController({
    policy: { delayMs: 10 },
    canRetry: () => true,
    onRetry: () => retries.push(1),
  });

  controller.handleOutcome('EURUSD', '1m', 'failure');
  controller.handleOutcome('EURUSD', '1m', 'success');

  assert.equal(controller.attemptsFor('EURUSD', '1m'), 0, 'budget reset');
  assert.equal(controller.isScheduled('EURUSD', '1m'), false, 'pending retry cleared');

  await delay(30);
  assert.deepEqual(retries, [], 'a success never triggers a retry');
});

test('a failure schedules exactly one bounded retry', async () => {
  const retries: string[] = [];
  const controller = new HistoryRecoveryController({
    policy: { maxAttempts: 3, delayMs: 5 },
    canRetry: () => true,
    onRetry: (symbol, timeframe) => retries.push(`${symbol}:${timeframe}`),
  });

  controller.handleOutcome('EURUSD', '1m', 'failure');
  assert.equal(controller.isScheduled('EURUSD', '1m'), true, 'a retry is scheduled');
  assert.equal(controller.attemptsFor('EURUSD', '1m'), 1, 'one attempt consumed');

  await delay(25);
  assert.deepEqual(retries, ['EURUSD:1m'], 'the retry fires once for the pair');
  assert.equal(controller.isScheduled('EURUSD', '1m'), false, 'the timer is cleared');
});

test('an empty outcome is retryable like a failure', async () => {
  const retries: number[] = [];
  const controller = new HistoryRecoveryController({
    policy: { delayMs: 5 },
    canRetry: () => true,
    onRetry: () => retries.push(1),
  });

  controller.handleOutcome('EURUSD', '1m', 'empty');
  await delay(25);
  assert.deepEqual(retries, [1], 'a valid-but-empty response is retried');
});

test('a failed retry chain is bounded by maxAttempts', async () => {
  const retries: string[] = [];
  const controller = new HistoryRecoveryController({
    policy: { maxAttempts: 2, delayMs: 5 },
    canRetry: () => true,
    onRetry: (symbol, timeframe) => retries.push(`${symbol}:${timeframe}`),
  });

  controller.handleOutcome('EURUSD', '1m', 'failure');
  await delay(20);
  controller.handleOutcome('EURUSD', '1m', 'failure');
  await delay(20);
  controller.handleOutcome('EURUSD', '1m', 'failure');
  await delay(20);
  controller.handleOutcome('EURUSD', '1m', 'failure');
  await delay(20);

  assert.deepEqual(retries, ['EURUSD:1m', 'EURUSD:1m'], 'no more than maxAttempts retries');
  assert.equal(controller.attemptsFor('EURUSD', '1m'), 2, 'the budget is exhausted');
  assert.equal(controller.hasAttemptsLeft('EURUSD', '1m'), false);
});

test('a retry is not scheduled when the pair is not retryable', () => {
  const retries: number[] = [];
  const controller = new HistoryRecoveryController({
    policy: { delayMs: 5 },
    canRetry: () => false,
    onRetry: () => retries.push(1),
  });

  controller.handleOutcome('EURUSD', '1m', 'failure');
  assert.equal(controller.isScheduled('EURUSD', '1m'), false);
  assert.equal(controller.attemptsFor('EURUSD', '1m'), 0, 'no attempt is consumed');
});

test('a scheduled retry does not fire once the pair is no longer retryable', async () => {
  let allowed = true;
  const retries: number[] = [];
  const controller = new HistoryRecoveryController({
    policy: { delayMs: 20 },
    canRetry: () => allowed,
    onRetry: () => retries.push(1),
  });

  controller.handleOutcome('EURUSD', '1m', 'failure');
  assert.equal(controller.isScheduled('EURUSD', '1m'), true);

  allowed = false;
  await delay(50);
  assert.deepEqual(retries, [], 'the guard is re-checked immediately before firing');
});

test('duplicate failure outcomes do not stack retries for the same pair', async () => {
  const retries: number[] = [];
  const controller = new HistoryRecoveryController({
    policy: { delayMs: 20 },
    canRetry: () => true,
    onRetry: () => retries.push(1),
  });

  controller.handleOutcome('EURUSD', '1m', 'failure');
  controller.handleOutcome('EURUSD', '1m', 'failure');
  controller.handleOutcome('EURUSD', '1m', 'failure');
  assert.equal(controller.attemptsFor('EURUSD', '1m'), 1, 'only one retry is scheduled');

  await delay(50);
  assert.deepEqual(retries, [1], 'exactly one retry fires');
});

test('an abandoned outcome clears a scheduled retry without firing it', async () => {
  const retries: number[] = [];
  const controller = new HistoryRecoveryController({
    policy: { delayMs: 20 },
    canRetry: () => true,
    onRetry: () => retries.push(1),
  });

  controller.handleOutcome('EURUSD', '1m', 'failure');
  assert.equal(controller.isScheduled('EURUSD', '1m'), true);

  controller.handleOutcome('EURUSD', '1m', 'abandoned');
  assert.equal(controller.isScheduled('EURUSD', '1m'), false);

  await delay(50);
  assert.deepEqual(retries, [], 'a dropped connection is recovered by reconnect, not here');
});

test('reset clears a scheduled retry and the retry budget', async () => {
  const retries: number[] = [];
  const controller = new HistoryRecoveryController({
    policy: { delayMs: 20 },
    canRetry: () => true,
    onRetry: () => retries.push(1),
  });

  controller.handleOutcome('EURUSD', '1m', 'failure');
  controller.reset('EURUSD', '1m');
  assert.equal(controller.isScheduled('EURUSD', '1m'), false);
  assert.equal(controller.attemptsFor('EURUSD', '1m'), 0);

  await delay(50);
  assert.deepEqual(retries, []);
});

test('cancelAll clears retries for every pair without discarding budgets', async () => {
  const retries: string[] = [];
  const controller = new HistoryRecoveryController({
    policy: { delayMs: 20 },
    canRetry: () => true,
    onRetry: (symbol, timeframe) => retries.push(`${symbol}:${timeframe}`),
  });

  controller.handleOutcome('EURUSD', '1m', 'failure');
  controller.handleOutcome('GBPUSD', '5m', 'failure');
  controller.cancelAll();

  assert.equal(controller.isScheduled('EURUSD', '1m'), false);
  assert.equal(controller.isScheduled('GBPUSD', '5m'), false);
  assert.equal(controller.attemptsFor('GBPUSD', '5m'), 1, 'budget preserved');

  await delay(50);
  assert.deepEqual(retries, []);
});

test('recovery state is isolated per symbol/timeframe pair', () => {
  const controller = new HistoryRecoveryController({
    policy: { delayMs: 1000 },
    canRetry: () => true,
    onRetry: () => {},
  });

  controller.handleOutcome('EURUSD', '1m', 'failure');
  controller.handleOutcome('GBPUSD', '5m', 'failure');
  assert.equal(controller.attemptsFor('EURUSD', '1m'), 1);
  assert.equal(controller.attemptsFor('GBPUSD', '5m'), 1);

  controller.handleOutcome('EURUSD', '1m', 'success');
  assert.equal(controller.attemptsFor('EURUSD', '1m'), 0);
  assert.equal(controller.attemptsFor('GBPUSD', '5m'), 1, 'the other pair is untouched');

  controller.cancelAll();
});

test('a success after a retry restores the pair for future recovery', async () => {
  const controller = new HistoryRecoveryController({
    policy: { maxAttempts: 1, delayMs: 5 },
    canRetry: () => true,
    onRetry: () => {},
  });

  controller.handleOutcome('EURUSD', '1m', 'failure');
  await delay(20);
  assert.equal(controller.hasAttemptsLeft('EURUSD', '1m'), false, 'budget spent');

  controller.handleOutcome('EURUSD', '1m', 'success');
  assert.equal(controller.hasAttemptsLeft('EURUSD', '1m'), true, 'budget restored');
});
