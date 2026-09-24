import type { LabelDefinition } from './client.js';
import { AUTO_MERGE_LABEL } from '../plan.js';
import type { LifecycleLabel } from '../plan.js';

/**
 * Canonical definitions for the labels the reconciler owns, mirroring the fleet
 * roster (rmartz/dotfiles claude/scripts/labels.yml). Used only to create a label
 * a consumer repo is missing; an existing label's color and description are never
 * changed.
 */
export const OWNED_LABEL_DEFINITIONS: Record<
  LifecycleLabel | typeof AUTO_MERGE_LABEL,
  LabelDefinition
> = {
  approved: {
    name: 'approved',
    color: '2DA44E',
    description: 'Code review passed — safe to merge pending UAT.',
  },
  'auto-merge enabled': {
    name: AUTO_MERGE_LABEL,
    color: '1F883D',
    description: 'Native auto-merge is armed on this PR; it merges once required checks pass.',
  },
  'changes requested': {
    name: 'changes requested',
    color: 'DA3633',
    description: 'Fix-review pass needed — reviewer flagged addressable issues.',
  },
  'escalation needed': {
    name: 'escalation needed',
    color: 'DB2777',
    description: 'Needs author input or judgment — not addressable by automated fix-review.',
  },
  // Placeholder colors until the fleet roster assigns them (rmartz/dotfiles#1573).
  'ci failing': {
    name: 'ci failing',
    color: 'B60205',
    description: "The PR's required CI (excluding gate checks) is failing on its head.",
  },
  'fix required': {
    name: 'fix required',
    color: 'D93F0B',
    description: 'A statically detected problem (merge conflict or failing CI) needs a fix.',
  },
  'review requested': {
    name: 'review requested',
    color: 'E3B341',
    description: 'Review pass needed on the current head.',
  },
};

export function labelDefinition(name: string): LabelDefinition {
  const known = Object.values(OWNED_LABEL_DEFINITIONS).find((label) => label.name === name);
  // The plan only ever adds owned labels (a tested core property), so the
  // fallback is defensive: create it plainly rather than fail the run.
  return known ?? { name, color: 'EDEDED', description: '' };
}
