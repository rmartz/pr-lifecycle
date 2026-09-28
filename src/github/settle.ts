import type { ReconcilePolicy } from '../facts.js';
import type { LifecycleLabel } from '../plan.js';
import { computeState } from '../state.js';
import type { GitHubClient } from './client.js';
import type { GatheredPullRequest } from './gather.js';

/**
 * The settle wait: a PR that just became reviewable isn't moved to
 * `review-requested` until bot reviewers have had time to be requested. Copilot's
 * auto-review request lands a few seconds after the PR opens (observed: up to 5s),
 * so a run that reads the PR sooner would see no request and skip the wait. The
 * wait happens inside the run, never as "stay put and wait for the next event":
 * when no bot is coming, no further event may ever fire. See
 * docs/reconciler-design.md §Waiting for bot reviewers.
 */

/** Long enough to cover the observed request delay several times over. */
export const DEFAULT_SETTLE_MS = 30_000;

export interface SettleOptions {
  /** How long after a PR becomes reviewable to wait for bot requests. */
  settleMs?: number;
  /** Clock and timer, injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * How long to wait before trusting the gathered facts: nonzero only on the
 * transition into `review-requested` (the label isn't on yet) for a PR opened or
 * marked ready less than `settleMs` ago. Reads the ready time only in that case.
 */
export async function settleDelay(
  client: Pick<GitHubClient, 'getLastReadyForReviewAt'>,
  pr: number,
  gathered: GatheredPullRequest,
  policy: ReconcilePolicy,
  settleMs: number,
  now: number,
): Promise<number> {
  const { facts } = gathered;
  if (policy.skipCopilotReview === true || computeState(facts, policy) !== 'review-requested') {
    return 0;
  }
  if (facts.labels.includes('review requested' satisfies LifecycleLabel)) {
    return 0;
  }
  const readyAt = await client.getLastReadyForReviewAt(pr);
  const reviewableSince = Math.max(
    Date.parse(gathered.createdAt),
    readyAt === undefined ? 0 : Date.parse(readyAt),
  );
  const elapsed = now - reviewableSince;
  if (!Number.isFinite(elapsed)) {
    return settleMs; // an unparseable time: wait the full window rather than none
  }
  // A clock skewed behind GitHub's (negative elapsed) still waits at most settleMs.
  return Math.min(settleMs, Math.max(0, settleMs - elapsed));
}

/** Resolves the options to concrete values, defaulting to the real clock. */
export function resolveSettle(options: SettleOptions = {}) {
  return {
    settleMs: options.settleMs ?? DEFAULT_SETTLE_MS,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? realSleep,
  };
}
