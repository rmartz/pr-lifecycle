import type { PullRequestFacts, ReconcilePolicy } from './facts.js';
import { currentVerdict } from './verdict.js';

/**
 * Lifecycle state, computed from facts in a fixed priority order. See
 * docs/reconciler-design.md §State.
 */

export const LIFECYCLE_STATES = [
  'approved',
  'awaiting-bot-review',
  'awaiting-ci',
  'blocked',
  'blocked-base-red',
  'changes-requested',
  'ci-failing',
  'closed',
  'draft',
  'escalation-needed',
  'fix-required',
  'review-requested',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

const WIP_PATTERN = /\[wip\]/i;

/**
 * The `escalation needed` lifecycle label. Its presence is itself an escalation:
 * whoever applied it (a /review or /merge verdict, or a person by hand), the PR
 * needs a human, so the reconciler keeps it and never removes it.
 */
export const ESCALATION_LABEL = 'escalation needed';

export function computeState(facts: PullRequestFacts, policy: ReconcilePolicy): LifecycleState {
  if (facts.status !== 'open') {
    return 'closed';
  }
  // A sticky escalation outranks everything else on an open PR: no verdict,
  // green CI, or bot eligibility may approve (and arm) a PR someone escalated.
  // Only a person or a new /review verdict clears it, by removing the label.
  if (facts.labels.includes(ESCALATION_LABEL)) {
    return 'escalation-needed';
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
  // Failing CI outranks verdicts too: it needs a fix (a new commit). A PR failing
  // because its base is red is held instead — the fix isn't in the PR.
  if (facts.ciStatus === 'failing') {
    return facts.baseCiFailing ? 'blocked-base-red' : 'ci-failing';
  }
  const verdict = currentVerdict(facts, policy);
  if (verdict !== undefined) {
    return verdict;
  }
  if (facts.botEligible) {
    return 'approved';
  }
  // Pending CI only gates the no-verdict path: review is requested once CI is
  // green. An approved PR stays approved (GitHub's auto-merge itself waits on
  // required checks), and a PR whose approval went stale lands here and is
  // disarmed like any other unapproved PR.
  if (facts.ciStatus === 'pending') {
    return 'awaiting-ci';
  }
  // Let requested bot reviewers (Copilot) finish first, so their comments are in
  // before the review is requested. A bot that won't review (out of quota, not
  // enabled, or a Dependabot PR) is never requested, so there is nothing to wait
  // for; a submitted review clears its request. People are never waited on.
  if (facts.pendingBotReviewers.length > 0 && policy.skipCopilotReview !== true) {
    return 'awaiting-bot-review';
  }
  return 'review-requested';
}
