import type { PullRequestFacts, ReconcilePolicy, UatSignOffLabel } from './facts.js';
import { carriedCommits } from './head-binding.js';
import { isAppliedWhileHead, isSignOffCurrent } from './uat-binding.js';
import type { SignOffClassification, UatSignOff, WaiverState } from './sign-off.js';
import { currentUatVerdict, currentVerdict, isTrustedAuthor } from './verdict.js';

/**
 * The UAT resolver: which one of the four UAT labels a PR should carry, from
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
 * Why the PR carries its UAT label, one per rule, in rule order (docs/uat.md
 * §Rules): `off`, `ci` and `exempt-auto-approved` need no UAT; `passed` and
 * `passed-attested` keep a person's test sign-off; `waived` is a person's waiver
 * and `waived-by-review` the review agent's; `ready` and `pending` wait for one.
 * Every outcome shows exactly one UAT label, since every reader of the labels
 * assumes one is there.
 */
export const UAT_OUTCOMES = [
  'off',
  'ci',
  'exempt-auto-approved',
  'passed',
  'passed-attested',
  'waived',
  'waived-by-review',
  'ready',
  'pending',
] as const;
export type UatOutcome = (typeof UAT_OUTCOMES)[number];

/** The one UAT label an outcome shows. */
export function uatLabelFor(outcome: UatOutcome): UatLabel {
  switch (outcome) {
    case 'off':
    case 'ci':
    case 'exempt-auto-approved':
    case 'waived':
    case 'waived-by-review':
      return NO_UAT_NEEDED_LABEL;
    case 'passed':
    case 'passed-attested':
      return UAT_PASSED_LABEL;
    case 'ready':
      return UAT_READY_LABEL;
    case 'pending':
      return UAT_PENDING_LABEL;
  }
}

/**
 * The UAT sign-off an outcome reports in a `v2` status (docs/sign-off-status.md),
 * or undefined when the head needs no UAT sign-off at all.
 */
export function uatSignOffFor(outcome: UatOutcome): UatSignOff | undefined {
  switch (outcome) {
    case 'off':
    case 'ci':
    case 'exempt-auto-approved':
      return undefined;
    case 'passed':
    case 'passed-attested':
      return 'passed';
    case 'waived':
    case 'waived-by-review':
      return 'waived';
    case 'ready':
    case 'pending':
      return 'absent';
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
 * Whether a trusted person's sign-off is on the PR and current for the head or a
 * commit approval carry-over verified. `UAT passed` and `no UAT needed` carry
 * over the same verified clean base merges and rebases as an approval.
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
  return (
    signOff !== undefined &&
    isTrustedAuthor(signOff.actor, policy) &&
    isSignOffCurrent(signOff, facts, carriedCommits(facts))
  );
}

/**
 * Whether a trusted person applied `UAT passed` while `since` was the head, from
 * the label's whole history: the label itself may since have been removed as
 * stale, which is why the review agent attests that the pass still holds.
 */
function passedOn(since: string, facts: PullRequestFacts, policy: ReconcilePolicy): boolean {
  return (facts.uatPassedHistory ?? []).some(
    (application) =>
      isTrustedAuthor(application.actor, policy) && isAppliedWhileHead(application, since, facts),
  );
}

/**
 * Whether a trusted `no UAT needed` counts for the head, as a `v1` sign-off
 * status reports it: `current`, `stale` (trusted but for an earlier head), or
 * `absent` (none on the PR, or not from a trusted person).
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

/**
 * The UAT rules, in order (docs/uat.md §Rules), after the sign-off
 * classification. A person's sign-off outranks the review agent's decision, and
 * no decision yet is a hold.
 */
export function classifyUat(
  facts: PullRequestFacts,
  policy: ReconcilePolicy,
  classification: SignOffClassification,
): UatOutcome {
  switch (classification.reason) {
    case 'uat-off':
      return 'off';
    case 'ci-safe':
    case 'ci-loosening':
    case 'ci-paths':
      return 'ci';
    case 'needs-uat':
      break;
  }
  const verdict = currentVerdict(facts, policy);
  if (verdict === undefined && facts.botEligible) {
    return 'exempt-auto-approved';
  }
  const approved = verdict === 'approved';
  if (approved && holdsSignOff('UAT passed', facts, policy)) {
    return 'passed';
  }
  const uat = currentUatVerdict(facts, policy);
  if (approved && uat?.kind === 'unchanged' && passedOn(uat.since, facts, policy)) {
    return 'passed-attested';
  }
  if (holdsSignOff('no UAT needed', facts, policy)) {
    return 'waived';
  }
  if (uat?.kind === 'not-needed') {
    return 'waived-by-review';
  }
  return approved ? 'ready' : 'pending';
}
