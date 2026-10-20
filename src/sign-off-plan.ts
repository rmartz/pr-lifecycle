import type { PullRequestFacts, ReconcilePolicy } from './facts.js';
import { CI_CHANGE_APPROVED_LABEL } from './facts.js';
import type { SignOffClassification } from './sign-off.js';
import { classifySignOff, signOffStatusDescription } from './sign-off.js';
import type { UatOutcome } from './uat.js';
import { classifyUat, waiverState } from './uat.js';
import { isTrustedAuthor } from './verdict.js';

/**
 * The sign-off part of a reconcile plan: the classification, the UAT outcome it
 * gives the labels, and the `pr-lifecycle/sign-off` status for the head
 * (docs/sign-off-status.md). Pure, like the planner.
 */

/** The label that shows a PR is waiting on the CI sign-off. Written only here. */
export const CI_APPROVAL_NEEDED_LABEL = 'CI approval needed';

/** The commit status context pr-policy reads. */
export const SIGN_OFF_STATUS_CONTEXT = 'pr-lifecycle/sign-off';

export interface SignOffStatusPlan {
  /** The versioned description (docs/sign-off-status.md). */
  description: string;
  /**
   * Whether to post it: false when the head already has the same description,
   * posted as `success` by a person (an unchanged status isn't reposted).
   */
  post: boolean;
}

export interface SignOffPlan {
  classification: SignOffClassification;
  uat: UatOutcome;
  status: SignOffStatusPlan;
  /** Whether `CI approval needed` belongs on the PR (see `wantsCiApprovalLabel`). */
  ciApprovalLabel: boolean;
}

/** Whether a trusted person applied the `CI change approved` that is on the PR. */
function isCiSignedOff(facts: PullRequestFacts, policy: ReconcilePolicy): boolean {
  const signOff = facts.uatSignOffs?.find(
    (candidate) => candidate.label === CI_CHANGE_APPROVED_LABEL,
  );
  return (
    facts.labels.includes(CI_CHANGE_APPROVED_LABEL) &&
    signOff !== undefined &&
    isTrustedAuthor(signOff.actor, policy)
  );
}

/**
 * `CI approval needed`, by pr-policy's policy (its decisions.md, "The CI
 * approval label and /review"): present while the head needs the CI sign-off
 * (`requirement=ci`, or a loosening bundled into another type), and removed when
 * a later push takes the need away, but **never** removed once a trusted person
 * has applied `CI change approved`: it then stays as the audit record.
 */
function wantsCiApprovalLabel(
  facts: PullRequestFacts,
  policy: ReconcilePolicy,
  classification: SignOffClassification,
): boolean {
  const needed = classification.requirement === 'ci' || classification.loosening;
  const kept = facts.labels.includes(CI_APPROVAL_NEEDED_LABEL) && isCiSignedOff(facts, policy);
  return needed || kept;
}

/** Whether the head's latest sign-off status already says `description`, from a person. */
function isPosted(facts: PullRequestFacts, description: string): boolean {
  const current = facts.signOffStatus;
  return (
    current !== undefined &&
    current.description === description &&
    current.state === 'success' &&
    current.creatorType === 'User'
  );
}

/** The sign-off plan, or undefined when sign-offs aren't reconciled (no `policy.uat`). */
export function planSignOff(
  facts: PullRequestFacts,
  policy: ReconcilePolicy,
): SignOffPlan | undefined {
  if (policy.uat === undefined) {
    return undefined;
  }
  const classification = classifySignOff(facts, policy.uat);
  const description = signOffStatusDescription(classification, waiverState(facts, policy));
  return {
    classification,
    uat: classifyUat(facts, policy, classification),
    status: { description, post: !isPosted(facts, description) },
    ciApprovalLabel: wantsCiApprovalLabel(facts, policy, classification),
  };
}
