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

function lifecycleLabel(state: LifecycleState): LifecycleLabel | undefined {
  switch (state) {
    case 'approved':
      return 'approved';
    case 'changes-requested':
      return 'changes requested';
    case 'escalation-needed':
      return 'escalation needed';
    case 'fix-required':
      return 'fix required';
    case 'review-requested':
      return 'review requested';
    case 'awaiting-copilot':
    case 'closed':
    case 'draft':
      return undefined;
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
  const desired = new Set<string>();
  const label = lifecycleLabel(state);
  if (label !== undefined) {
    desired.add(label);
  }
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
