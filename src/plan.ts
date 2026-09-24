import type { BranchUpdater, PullRequestFacts, ReconcilePolicy } from './facts.js';
import type { LifecycleState } from './state.js';
import { computeState } from './state.js';

/**
 * The reconcile plan: the minimal label and auto-merge changes that converge a PR
 * to its computed lifecycle state. Labels are output only — the core owns the
 * lifecycle labels (plus `auto-merge enabled` in arming mode) and never touches
 * any other label. See docs/reconciler-design.md §Plan.
 */

export const LIFECYCLE_LABELS = [
  'approved',
  'changes requested',
  'escalation needed',
  'fix required',
  'ci failing',
  'review requested',
] as const;
export type LifecycleLabel = (typeof LIFECYCLE_LABELS)[number];

export const AUTO_MERGE_LABEL = 'auto-merge enabled';

/** merge-safety's label for a PR whose base moved in a way that matters. Read, never written. */
export const UPDATE_REQUIRED_LABEL = 'update required';

/**
 * `merge` is arming's twin for a PR GitHub would already merge: auto-merge can't
 * be armed then, so it is merged directly (see `immediatelyMergeable`).
 */
export type AutoMergeAction = 'arm' | 'disarm' | 'merge' | 'none';

/**
 * How an approved PR flagged `update required` is brought up to date. A Dependabot
 * PR is never updated directly — a foreign commit on its branch permanently breaks
 * its own rebasing — so it is only ever asked to rebase itself.
 */
export type UpdateAction = 'dependabot-rebase' | 'none' | 'update-branch';

export interface ReconcilePlan {
  state: LifecycleState;
  addLabels: string[];
  removeLabels: string[];
  autoMerge: AutoMergeAction;
  update: UpdateAction;
}

/** The lifecycle labels a state shows: the state label, plus a reason label for CI. */
function lifecycleLabels(state: LifecycleState): readonly LifecycleLabel[] {
  switch (state) {
    case 'approved':
      return ['approved'];
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
    case 'awaiting-ci':
    case 'awaiting-copilot':
    case 'blocked-base-red':
    case 'closed':
    case 'draft':
      return [];
  }
}

function updateFor(updater: BranchUpdater, rebasePending: boolean): UpdateAction {
  switch (updater) {
    case 'dependabot':
      return rebasePending ? 'none' : 'dependabot-rebase';
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
  return updateFor(facts.updater, facts.rebasePending);
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

  const owned: string[] = [...LIFECYCLE_LABELS];
  const desired = new Set<string>(lifecycleLabels(state));
  if (arming) {
    owned.push(AUTO_MERGE_LABEL);
    // A direct merge arms nothing, so it doesn't claim the label.
    if (shouldArm && autoMerge !== 'merge') {
      desired.add(AUTO_MERGE_LABEL);
    }
  }

  const present = new Set(facts.labels);
  return {
    state,
    addLabels: [...desired].filter((name) => !present.has(name)),
    removeLabels: owned.filter((name) => present.has(name) && !desired.has(name)),
    autoMerge,
    update: planUpdate(facts, policy, state, autoMerge),
  };
}

/**
 * The plan with arming, merging, and updating taken out, for when no real-actor
 * token is available to perform them (docs/cli.md §Release token). Disarming
 * stays: it is safety, and any token may do it. Pure, like the planner.
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
