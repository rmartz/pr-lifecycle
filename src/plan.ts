import type { PullRequestFacts, ReconcilePolicy } from './facts.js';
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

export type AutoMergeAction = 'arm' | 'disarm' | 'none';

export interface ReconcilePlan {
  state: LifecycleState;
  addLabels: string[];
  removeLabels: string[];
  autoMerge: AutoMergeAction;
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

export function planReconcile(facts: PullRequestFacts, policy: ReconcilePolicy): ReconcilePlan {
  const state = computeState(facts, policy);
  if (state === 'closed') {
    return { state, addLabels: [], removeLabels: [], autoMerge: 'none' };
  }
  const arming = policy.armAutoMerge === true;
  const shouldArm = arming && state === 'approved';

  const owned: string[] = [...LIFECYCLE_LABELS];
  const desired = new Set<string>(lifecycleLabels(state));
  if (arming) {
    owned.push(AUTO_MERGE_LABEL);
    if (shouldArm) {
      desired.add(AUTO_MERGE_LABEL);
    }
  }

  const present = new Set(facts.labels);
  let autoMerge: AutoMergeAction = 'none';
  if (arming && shouldArm !== facts.autoMergeEnabled) {
    autoMerge = shouldArm ? 'arm' : 'disarm';
  }
  return {
    state,
    addLabels: [...desired].filter((name) => !present.has(name)),
    removeLabels: owned.filter((name) => present.has(name) && !desired.has(name)),
    autoMerge,
  };
}
