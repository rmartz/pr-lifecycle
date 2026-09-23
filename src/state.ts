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
  const verdict = currentVerdict(facts, policy);
  if (verdict !== undefined) {
    return verdict;
  }
  if (facts.botEligible) {
    return 'approved';
  }
  const copilotReviewedHead = facts.reviews.some(
    (review) =>
      review.author.login === COPILOT_REVIEWER_LOGIN && review.commitSha === facts.headSha,
  );
  return copilotReviewedHead ? 'review-requested' : 'awaiting-copilot';
}
