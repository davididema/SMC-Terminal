/**
 * STALE -> LIVE recovery resumption.
 *
 * A feed going stale is a discontinuity: the pair is blocked until its history
 * has been recovered. When the feed becomes live again WITHOUT a reconnect,
 * nothing else re-issues the recovery request, so the pair would stay blocked
 * indefinitely. This module decides whether the EXISTING recovery path must be
 * resumed for a pair that just became live again.
 *
 * It never introduces a recovery mechanism of its own: the caller supplies the
 * existing request function. The caller must not re-mark the discontinuity (the
 * original gap anchor has to survive) and must not reset the retry budget (only
 * a verified recovery may do that). The gate is idempotent: while a request is
 * in flight, a chunked cycle is running, or a bounded retry is already
 * scheduled, a repeated LIVE notification does nothing.
 */

export interface StaleRecoveryResumeDeps {
  /** True while the pair still owes a recovery (its gap is still open). */
  isRecoveryRequired(): boolean;
  /** True while a history request for the pair is already in flight. */
  isRequestPending(): boolean;
  /** True while a bounded retry for the pair is already scheduled. */
  isRetryScheduled(): boolean;
  /** True while a bounded chunked recovery cycle is running for the pair. */
  isChunkActive(): boolean;
  /** False when the pair has spent its bounded retry budget. */
  hasRetryBudget(): boolean;
  /** Resume recovery through the existing request path. */
  requestHistory(): void;
}

/**
 * Resume a pair's outstanding recovery after it became live again.
 *
 * Returns true only when a request was actually issued. A pair with no open gap
 * is left alone, and a pair whose recovery is already running (in flight,
 * chunked, or retry-scheduled) is not given a second job. An exhausted budget
 * stays exhausted: becoming live never restores it.
 */
export function resumeStaleRecovery(deps: StaleRecoveryResumeDeps): boolean {
  if (!deps.isRecoveryRequired()) return false;
  if (deps.isRequestPending()) return false;
  if (deps.isRetryScheduled()) return false;
  if (deps.isChunkActive()) return false;
  if (!deps.hasRetryBudget()) return false;
  deps.requestHistory();
  return true;
}
