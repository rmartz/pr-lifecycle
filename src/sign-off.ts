import { classifyWorkflowChanges } from './ci-change/classify.js';
import { isWorkflowPath } from './ci-change/workflow-paths.js';
import type { PullRequestFacts, SignOffStatusVersion, UatSetting } from './facts.js';
import { titleType } from './title-type.js';
import { trivialCategories } from './uat-paths.js';

/**
 * Which human sign-off a PR's head needs. pr-lifecycle decides it here and hands
 * it to pr-policy, the gate, as the `pr-lifecycle/sign-off` commit status
 * (docs/sign-off-status.md). Pure, like the lifecycle state.
 *
 * - `none`: UAT is off, or the PR is a statically safe CI change.
 * - `ci`: a CI change (a `ci:` title, or only CI and statically safe paths)
 *   that loosens a workflow or changes a path that isn't statically safe. It
 *   needs the CI sign-off (`CI change approved`), not UAT: CI isn't user-facing.
 * - `uat`: everything else. No title or path exempts a PR from UAT: the review
 *   agent's verdict decides (docs/uat.md), and the status reports `none` for a
 *   PR approved through bot eligibility.
 *
 * `ci` and `uat` are mutually exclusive: a person is asked for one sign-off.
 * A workflow loosening is reported on its own (`loosening`) whatever the
 * requirement, so the gate can still ask for the CI sign-off on a PR that
 * bundled one into another type.
 */

export const SIGN_OFF_REQUIREMENTS = ['ci', 'none', 'uat'] as const;
export type SignOffRequirement = (typeof SIGN_OFF_REQUIREMENTS)[number];

/** Why the requirement is what it is, one per rule. */
export const SIGN_OFF_REASONS = [
  'ci-safe',
  'ci-loosening',
  'ci-paths',
  'uat-off',
  'needs-uat',
] as const;
export type SignOffReason = (typeof SIGN_OFF_REASONS)[number];

export interface SignOffClassification {
  requirement: SignOffRequirement;
  reason: SignOffReason;
  /** A changed workflow loosens CI, or might (unread or unparseable counts). */
  loosening: boolean;
}

export function requirementFor(reason: SignOffReason): SignOffRequirement {
  switch (reason) {
    case 'ci-safe':
    case 'uat-off':
      return 'none';
    case 'ci-loosening':
    case 'ci-paths':
      return 'ci';
    case 'needs-uat':
      return 'uat';
  }
}

/**
 * Whether any changed workflow loosens CI. Fails closed: an unknown file list,
 * or a changed workflow whose text wasn't read, counts as a loosening.
 */
export function loosensCi(facts: PullRequestFacts): boolean {
  const paths = facts.changedPaths;
  if (paths === undefined) {
    return true;
  }
  const changes = facts.workflowChanges ?? [];
  const unread = paths.some(
    (path) => isWorkflowPath(path) && !changes.some((change) => change.path === path),
  );
  return unread || classifyWorkflowChanges(changes).verdict === 'loosening';
}

/**
 * Whether every non-workflow path is statically safe. In a CI change, a
 * workflow change that doesn't loosen CI is statically safe too. A composite
 * action isn't: the loosening rules don't read it.
 */
function onlySafePathsBesidesWorkflows(facts: PullRequestFacts): boolean {
  const paths = facts.changedPaths;
  if (paths === undefined) {
    return false;
  }
  const others = paths.filter((path) => !isWorkflowPath(path));
  const categories = trivialCategories(others, facts.manifestChanges);
  return categories !== undefined && !categories.includes('ci');
}

/** A CI change is statically safe, or it needs the CI sign-off. */
function ciReason(facts: PullRequestFacts, loosening: boolean): SignOffReason {
  if (loosening) {
    return 'ci-loosening';
  }
  return onlySafePathsBesidesWorkflows(facts) ? 'ci-safe' : 'ci-paths';
}

function reasonFor(
  facts: PullRequestFacts,
  setting: UatSetting,
  loosening: boolean,
): SignOffReason {
  if (titleType(facts.title) === 'ci') {
    return ciReason(facts, loosening);
  }
  const categories = trivialCategories(
    facts.changedPaths,
    facts.manifestChanges,
    facts.workflowChanges,
  );
  if (categories?.includes('ci') === true) {
    return ciReason(facts, loosening);
  }
  return setting === 'off' ? 'uat-off' : 'needs-uat';
}

/**
 * The rules, in order. A CI change is decided first: a `ci:` title, or paths
 * that are only CI and statically safe, whatever the title. It is statically
 * safe, or it needs the CI sign-off, whatever the UAT setting; it never needs
 * UAT. Then UAT off needs nothing; anything else needs UAT.
 */
export function classifySignOff(
  facts: PullRequestFacts,
  setting: UatSetting,
): SignOffClassification {
  const loosening = loosensCi(facts);
  const reason = reasonFor(facts, setting, loosening);
  return { requirement: requirementFor(reason), reason, loosening };
}

/** `v1`: whether a trusted person's `no UAT needed` counts for the head. */
export type WaiverState = 'absent' | 'current' | 'stale';

/** `v2`: the UAT sign-off the resolver found for the head (docs/uat.md). */
export type UatSignOff = 'absent' | 'passed' | 'waived';

/** What the status reports for a head, before it is written in a version's format. */
export interface SignOffStatusFields {
  requirement: SignOffRequirement;
  loosening: boolean;
  /** Read by `v1` with `requirement=uat`. */
  waiver: WaiverState;
  /** Read by `v2` with `requirement=uat`. */
  signoff: UatSignOff;
}

/**
 * The status description, a versioned contract with pr-policy
 * (docs/sign-off-status.md): `<version> requirement=<r>`, then the UAT sign-off
 * exactly when the requirement is `uat` (`waiver=<w>` in `v1`, `signoff=<s>` in
 * `v2`), then `loosening=yes` when there is one (omitted means `no`).
 */
export function signOffStatusDescription(
  version: SignOffStatusVersion,
  fields: SignOffStatusFields,
): string {
  const parts: string[] = [version, `requirement=${fields.requirement}`];
  if (fields.requirement === 'uat') {
    switch (version) {
      case 'v1':
        parts.push(`waiver=${fields.waiver}`);
        break;
      case 'v2':
        parts.push(`signoff=${fields.signoff}`);
        break;
    }
  }
  if (fields.loosening) {
    parts.push('loosening=yes');
  }
  return parts.join(' ');
}
