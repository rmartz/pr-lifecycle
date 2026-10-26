import type { PullRequestFacts, ReconcilePolicy, UatSignOffLabel } from './facts.js';
import { carriedCommits } from './head-binding.js';
import { isRetitledSince, isSignOffCurrent } from './uat-binding.js';
import type { SignOffClassification, WaiverState } from './sign-off.js';
import { currentVerdict, isTrustedAuthor } from './verdict.js';

/**
 * The UAT classifier: which one of the four UAT labels a PR should carry, from
 * its facts. Pure, like the lifecycle state. See docs/uat.md.
 */

export const NO_UAT_NEEDED_LABEL = 'no UAT needed';
export const UAT_PENDING_LABEL = 'UAT pending';
export const UAT_READY_LABEL = 'UAT ready';
export const UAT_PASSED_LABEL = 'UAT passed';

export const UAT_LABELS = [
  NO_UAT_NEEDED_LABEL,
  UAT_PENDING_LABEL,
  UAT_READY_LABEL,
  UAT_PASSED_LABEL,
] as const;
export type UatLabel = (typeof UAT_LABELS)[number];

/**
 * Why the PR carries its UAT label, one per rule, in rule order:
 * `off`, the two exemptions, and `ci` (the CI sign-off instead of UAT) are this
 * package's own `no UAT needed`; `passed` and `waived` keep a trusted sign-off;
 * `ready` and `pending` are the default. Every outcome shows exactly one UAT
 * label, since every reader of the labels assumes one is there (docs/uat.md).
 */
export const UAT_OUTCOMES = [
  'off',
  'exempt-title',
  'exempt-paths',
  'ci',
  'passed',
  'waived',
  'ready',
  'pending',
] as const;
export type UatOutcome = (typeof UAT_OUTCOMES)[number];

/** The one UAT label an outcome shows. */
export function uatLabelFor(outcome: UatOutcome): UatLabel {
  switch (outcome) {
    case 'ci':
    case 'off':
    case 'exempt-title':
    case 'exempt-paths':
    case 'waived':
      return NO_UAT_NEEDED_LABEL;
    case 'passed':
      return UAT_PASSED_LABEL;
    case 'ready':
      return UAT_READY_LABEL;
    case 'pending':
      return UAT_PENDING_LABEL;
  }
}

/**
 * Whether the PR holds an approval for its head: a counting `approved` verdict,
 * or bot eligibility with no verdict over it. This is the approval itself, not
 * the `approved` state, so a CI failure or a red base (which hold the merge
 * anyway) doesn't erase a person's test sign-off.
 */
export function hasApproval(facts: PullRequestFacts, policy: ReconcilePolicy): boolean {
  const verdict = currentVerdict(facts, policy);
  return verdict === 'approved' || (verdict === undefined && facts.botEligible);
}

/**
 * Whether a trusted person's sign-off is on the PR and still current. A waiver
 * carries over the commits approval carry-over verified and is dropped by a
 * retitle (the title may have been what made the PR exempt); `UAT passed` binds
 * to the exact head and never carries over.
 */
function holdsSignOff(
  label: UatSignOffLabel,
  facts: PullRequestFacts,
  policy: ReconcilePolicy,
): boolean {
  if (!facts.labels.includes(label)) {
    return false;
  }
  const signOff = facts.uatSignOffs?.find((candidate) => candidate.label === label);
  if (signOff === undefined || !isTrustedAuthor(signOff.actor, policy)) {
    return false;
  }
  switch (label) {
    case 'UAT passed':
      return isSignOffCurrent(signOff, facts);
    case 'no UAT needed':
      return (
        isSignOffCurrent(signOff, facts, carriedCommits(facts)) && !isRetitledSince(signOff, facts)
      );
  }
}

/**
 * Whether a trusted `no UAT needed` counts for the head, as the sign-off status
 * reports it: `current`, `stale` (trusted but for an earlier head, or before a
 * retitle), or `absent` (none on the PR, or not from a trusted person).
 */
export function waiverState(facts: PullRequestFacts, policy: ReconcilePolicy): WaiverState {
  const label = 'no UAT needed';
  const signOff = facts.uatSignOffs?.find((candidate) => candidate.label === label);
  if (
    !facts.labels.includes(label) ||
    signOff === undefined ||
    !isTrustedAuthor(signOff.actor, policy)
  ) {
    return 'absent';
  }
  return holdsSignOff(label, facts, policy) ? 'current' : 'stale';
}

/** The UAT rules, in order (docs/uat.md §Rules), from the sign-off classification. */
export function classifyUat(
  facts: PullRequestFacts,
  policy: ReconcilePolicy,
  classification: SignOffClassification,
): UatOutcome {
  switch (classification.reason) {
    case 'uat-off':
      return 'off';
    case 'safe-title':
      return 'exempt-title';
    case 'trivial-paths':
    case 'tooling-paths':
      return 'exempt-paths';
    case 'ci-loosening':
    case 'ci-paths':
      return 'ci';
    case 'needs-uat':
      break;
  }
  const approved = hasApproval(facts, policy);
  if (approved && holdsSignOff('UAT passed', facts, policy)) {
    return 'passed';
  }
  if (holdsSignOff('no UAT needed', facts, policy)) {
    return 'waived';
  }
  return approved ? 'ready' : 'pending';
}
