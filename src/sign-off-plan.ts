import type { PullRequestFacts, ReconcilePolicy } from './facts.js';
import type { SignOffClassification } from './sign-off.js';
import { classifySignOff, signOffStatusDescription } from './sign-off.js';
import type { UatOutcome } from './uat.js';
import { classifyUat, waiverState } from './uat.js';

/**
 * The sign-off part of a reconcile plan: the classification, the UAT outcome it
 * gives the labels, and the `pr-lifecycle/sign-off` status for the head
 * (docs/sign-off-status.md). Pure, like the planner.
 */

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
  };
}
