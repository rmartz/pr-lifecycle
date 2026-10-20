import type { PullRequestFacts, ReconcilePolicy, UatSignOffLabel } from './facts.js';
import { carriedCommits } from './head-binding.js';
import { isRetitledSince, isSignOffCurrent } from './uat-binding.js';
import { trivialCategories } from './uat-paths.js';
import { isUatExemptTitle } from './uat-title.js';
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
 * `off` and the two exemptions are this package's own waiver; `passed` and
 * `waived` keep a trusted sign-off; `ready` and `pending` are the default.
 */
export const UAT_OUTCOMES = [
  'off',
  'exempt-title',
  'exempt-paths',
  'passed',
  'waived',
  'ready',
  'pending',
] as const;
export type UatOutcome = (typeof UAT_OUTCOMES)[number];

export function uatLabelFor(outcome: UatOutcome): UatLabel {
  switch (outcome) {
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

/** Whether the PR can't be user-facing: its title type, or failing that its paths. */
export function exemptionOf(facts: PullRequestFacts): 'exempt-paths' | 'exempt-title' | undefined {
  if (isUatExemptTitle(facts.title)) {
    return 'exempt-title';
  }
  return trivialCategories(facts.changedPaths, facts.manifestChanges) === undefined
    ? undefined
    : 'exempt-paths';
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

/** The UAT rules, in order (docs/uat.md §Rules). */
export function classifyUat(
  facts: PullRequestFacts,
  policy: ReconcilePolicy,
  setting: 'off' | 'on',
): UatOutcome {
  if (setting === 'off') {
    return 'off';
  }
  const exemption = exemptionOf(facts);
  if (exemption !== undefined) {
    return exemption;
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
