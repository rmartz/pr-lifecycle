import type { BranchUpdater, PullRequestFacts, ReconcilePolicy } from './facts.js';
import type { LifecycleState } from './state.js';
import { computeState } from './state.js';
import type { UatOutcome } from './uat.js';
import { classifyUat, UAT_LABELS, uatLabelFor } from './uat.js';

/**
 * The reconcile plan: the minimal label and auto-merge changes that converge a PR
 * to its computed lifecycle state. The core owns the lifecycle labels and
 * `dependabot rebasing` (plus `auto-merge enabled` in arming mode, and the four
 * UAT labels when UAT is reconciled) and never touches any other label. See
 * docs/reconciler-design.md §Plan.
 */

export const LIFECYCLE_LABELS = [
  'approved',
  'blocked',
  'changes requested',
  'escalation needed',
  'fix required',
  'ci failing',
  'review requested',
] as const;
export type LifecycleLabel = (typeof LIFECYCLE_LABELS)[number];

export const AUTO_MERGE_LABEL = 'auto-merge enabled';

/**
 * Shown while Dependabot rebases or recreates its PR, so workflows can hold off
 * until the branch settles. Owned like the lifecycle labels, but independent of
 * the state.
 */
export const DEPENDABOT_REBASING_LABEL = 'dependabot rebasing';

/** merge-safety's label for a PR whose base moved in a way that matters. Read, never written. */
export const UPDATE_REQUIRED_LABEL = 'update required';

/**
 * `merge` is arming's twin for a PR GitHub would already merge: auto-merge can't
 * be armed then, so it is merged directly (see `immediatelyMergeable`).
 */
export type AutoMergeAction = 'arm' | 'disarm' | 'merge' | 'none';

/**
 * How an approved PR flagged `update required` is brought up to date. A Dependabot
 * PR is never updated: a foreign commit on its branch permanently breaks its own
 * rebasing, and Dependabot refuses `@dependabot rebase` from a GitHub App ("only
 * users with push access"), so a person or Dependabot itself rebases it.
 */
export type UpdateAction = 'none' | 'update-branch';

export interface ReconcilePlan {
  state: LifecycleState;
  addLabels: string[];
  removeLabels: string[];
  autoMerge: AutoMergeAction;
  update: UpdateAction;
  /**
   * Why the PR carries its UAT label (docs/uat.md); undefined when UAT labels
   * aren't reconciled (no `policy.uat`) or the PR is closed. The label changes
   * themselves are in `addLabels` / `removeLabels`.
   */
  uat?: UatOutcome | undefined;
}

/** The lifecycle labels a state shows: the state label, plus a reason label for CI. */
function lifecycleLabels(state: LifecycleState): readonly LifecycleLabel[] {
  switch (state) {
    case 'approved':
      return ['approved'];
    case 'blocked':
      return ['blocked'];
    case 'changes-requested':
      return ['changes requested'];
    case 'escalation-needed':
      return ['escalation needed'];
    case 'fix-required':
      return ['fix required'];
    case 'ci-failing':
      return ['fix required', 'ci failing'];
    case 'review-requested':
      return ['review requested'];
    case 'awaiting-bot-review':
    case 'awaiting-ci':
    case 'blocked-base-red':
    case 'closed':
    case 'draft':
      return [];
  }
}

function updateFor(updater: BranchUpdater): UpdateAction {
  switch (updater) {
    case 'dependabot':
      return 'none';
    case 'github':
      return 'update-branch';
  }
}

function planUpdate(
  facts: PullRequestFacts,
  policy: ReconcilePolicy,
  state: LifecycleState,
  autoMerge: AutoMergeAction,
): UpdateAction {
  // A PR merged in this pass needs no update; only an approved PR earns one.
  if (policy.autoUpdate !== true || state !== 'approved' || autoMerge === 'merge') {
    return 'none';
  }
  if (!facts.labels.includes(UPDATE_REQUIRED_LABEL)) {
    return 'none';
  }
  return updateFor(facts.updater);
}

export function planReconcile(facts: PullRequestFacts, policy: ReconcilePolicy): ReconcilePlan {
  const state = computeState(facts, policy);
  if (state === 'closed') {
    return { state, addLabels: [], removeLabels: [], autoMerge: 'none', update: 'none' };
  }
  const arming = policy.armAutoMerge === true;
  const shouldArm = arming && state === 'approved';

  let autoMerge: AutoMergeAction = 'none';
  if (arming && shouldArm !== facts.autoMergeEnabled) {
    if (!shouldArm) {
      autoMerge = 'disarm';
    } else {
      autoMerge = facts.immediatelyMergeable ? 'merge' : 'arm';
    }
  }

  const owned: string[] = [...LIFECYCLE_LABELS, DEPENDABOT_REBASING_LABEL];
  const desired = new Set<string>(lifecycleLabels(state));
  if (facts.updater === 'dependabot' && facts.dependabotRebasing) {
    desired.add(DEPENDABOT_REBASING_LABEL);
  }
  if (arming) {
    owned.push(AUTO_MERGE_LABEL);
    // A direct merge arms nothing, so it doesn't claim the label.
    if (shouldArm && autoMerge !== 'merge') {
      desired.add(AUTO_MERGE_LABEL);
    }
  }
  // Exactly one UAT label: the classifier's. The sign-off labels are inputs too.
  const uat = policy.uat === undefined ? undefined : classifyUat(facts, policy, policy.uat);
  if (uat !== undefined) {
    owned.push(...UAT_LABELS);
    desired.add(uatLabelFor(uat));
  }

  const present = new Set(facts.labels);
  return {
    state,
    addLabels: [...desired].filter((name) => !present.has(name)),
    removeLabels: owned.filter((name) => present.has(name) && !desired.has(name)),
    autoMerge,
    update: planUpdate(facts, policy, state, autoMerge),
    uat,
  };
}

/**
 * The plan with arming, merging, and updating taken out, for when no real-actor
 * token is available to perform them (docs/cli.md §Release token). Disarming
 * stays: it is safety, so it is attempted with the workflow token instead. Pure,
 * like the planner.
 */
export function withoutReleaseActions(plan: ReconcilePlan): ReconcilePlan {
  const arming = plan.autoMerge === 'arm' || plan.autoMerge === 'merge';
  return {
    ...plan,
    addLabels: arming ? plan.addLabels.filter((name) => name !== AUTO_MERGE_LABEL) : plan.addLabels,
    autoMerge: arming ? 'none' : plan.autoMerge,
    update: 'none',
  };
}
