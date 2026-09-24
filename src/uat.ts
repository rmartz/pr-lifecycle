import type { PullRequestFacts, ReconcilePolicy, ReviewAuthor } from './facts.js';
import { isTrustedAuthor, latestCountingVerdict } from './verdict.js';

export type { UatRequirement } from './verdict.js';

/**
 * The UAT gate: does this PR still need a person to test it (or waive testing)
 * before it merges? Pure — the requirement comes from the head-bound /review
 * verdict, never from labels, and the only labels read are the human overrides.
 * See docs/uat-gate.md.
 */

/** The check-run name consumer rulesets require. A fleet contract, like `merge-safety`. */
export const UAT_CHECK_NAME = 'uat';

/** Labels by which a person passes a required gate. Read, never written. */
export const UAT_OVERRIDE_LABELS = ['UAT passed', 'no UAT needed'] as const;
export type UatOverrideLabel = (typeof UAT_OVERRIDE_LABELS)[number];

/**
 * Every label name that means an override, mapped to the override it means.
 * `tested` is `UAT passed`'s name until rmartz/dotfiles#1572 finishes the rename.
 */
const OVERRIDE_NAMES: ReadonlyMap<string, UatOverrideLabel> = new Map([
  ['UAT passed', 'UAT passed'],
  ['tested', 'UAT passed'],
  ['no UAT needed', 'no UAT needed'],
]);

/** The override a label name means, or undefined when it isn't one. */
export function overrideForLabel(name: string): UatOverrideLabel | undefined {
  return OVERRIDE_NAMES.get(name);
}

/** An override label on the PR, with who last applied it (undefined when unknown). */
export interface UatOverrideFact {
  label: UatOverrideLabel;
  appliedBy: ReviewAuthor | undefined;
}

/** Why the gate is in its state, for the check-run's text and `--json`. */
export type UatGateReason =
  | 'bot-eligible'
  | 'no-verdict'
  | 'override'
  | 'verdict-exempt'
  | 'verdict-required'
  | 'verdict-unspecified';

export interface UatGate {
  passes: boolean;
  required: boolean;
  reason: UatGateReason;
  /** The override that passed a required gate. */
  override: UatOverrideLabel | undefined;
}

/**
 * Where the requirement comes from, failing closed: only an explicit `exempt` on
 * the latest counting verdict, or bot eligibility with no verdict at all, makes
 * UAT not required.
 */
function requirementReason(facts: PullRequestFacts, policy: ReconcilePolicy): UatGateReason {
  const latest = latestCountingVerdict(facts, policy);
  if (latest === undefined) {
    return facts.botEligible ? 'bot-eligible' : 'no-verdict';
  }
  switch (latest.uat) {
    case 'exempt':
      return 'verdict-exempt';
    case 'required':
      return 'verdict-required';
    case undefined:
      return 'verdict-unspecified';
  }
}

export function computeUatGate(facts: PullRequestFacts, policy: ReconcilePolicy): UatGate {
  const reason = requirementReason(facts, policy);
  if (reason === 'verdict-exempt' || reason === 'bot-eligible') {
    return { passes: true, required: false, reason, override: undefined };
  }
  // An override counts only from someone who could merge the PR anyway: the same
  // trust rule as verdicts. Triage permission can label, but not pass the gate.
  const override = facts.uatOverrides.find(
    (fact) => fact.appliedBy !== undefined && isTrustedAuthor(fact.appliedBy, policy),
  );
  if (override !== undefined) {
    return { passes: true, required: true, reason: 'override', override: override.label };
  }
  return { passes: false, required: true, reason, override: undefined };
}
