import type { PullRequestFacts, ReconcilePolicy } from './facts.js';
import { currentVerdict } from './verdict.js';

/**
 * Lifecycle state, computed from facts in a fixed priority order. See
 * docs/reconciler-design.md §State.
 */

export const LIFECYCLE_STATES = [
  'approved',
  'awaiting-copilot',
  'changes-requested',
  'closed',
  'draft',
  'escalation-needed',
  'fix-required',
  'review-requested',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const COPILOT_REVIEWER_LOGIN = 'copilot-pull-request-reviewer[bot]';

const WIP_PATTERN = /\[wip\]/i;

export function computeState(facts: PullRequestFacts, policy: ReconcilePolicy): LifecycleState {
  if (facts.status !== 'open') {
    return 'closed';
  }
  if (facts.isDraft || WIP_PATTERN.test(facts.title)) {
    return 'draft';
  }
  // A conflict needs a code change, so it outranks every verdict: the resolution
  // is a new commit that an approval couldn't survive anyway. Unknown (still
  // computing) is not a conflict; the next event re-evaluates.
  if (facts.mergeable === false) {
    return 'fix-required';
  }
  const verdict = currentVerdict(facts, policy);
  if (verdict !== undefined) {
    return verdict;
  }
  if (facts.botEligible) {
    return 'approved';
  }
  if (policy.skipCopilotReview === true) {
    return 'review-requested';
  }
  const copilotReviewedHead = facts.reviews.some(
    (review) =>
      review.author.login === COPILOT_REVIEWER_LOGIN && review.commitSha === facts.headSha,
  );
  return copilotReviewedHead ? 'review-requested' : 'awaiting-copilot';
}
