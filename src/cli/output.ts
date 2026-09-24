import type { ReconcileResult } from '../github/reconcile.js';

/**
 * CLI output. `--json` is a versioned contract consumed by rmartz/pr-lifecycle-action
 * (as step outputs): exactly one object on stdout, every field always present
 * (absent values are `null`, never omitted). Renaming, removing, or retyping a field
 * is a breaking change that bumps SCHEMA_VERSION; adding a field is not. Pinned by
 * test/cli.test.ts and documented in docs/cli.md.
 */

export const SCHEMA_VERSION = 1;

export interface ReconcileTarget {
  owner: string;
  repo: string;
  pr: number;
  dryRun: boolean;
}

export interface ReconcileJson {
  schemaVersion: typeof SCHEMA_VERSION;
  repo: string;
  pr: number;
  dryRun: boolean;
  state: string;
  addLabels: string[];
  removeLabels: string[];
  autoMerge: string;
  botEligibility: {
    eligible: boolean;
    reason: string;
    prType: string | null;
    updateType: string | null;
  };
  /** Approval carry-over across clean base updates; `null` when it didn't run. */
  carryOver: { cleanAncestors: string[]; stoppedBecause: string } | null;
  /** An arm or merge the plan wanted but skipped; `null` when nothing was skipped. */
  autoMergeSkipped: { action: 'arm' | 'merge'; reason: 'token-missing' } | null;
  /** The branch update performed: `none`, `update-branch`, or `dependabot-rebase`. */
  update: string;
  /** A branch update the plan wanted but skipped; `null` when nothing was skipped. */
  updateSkipped: {
    action: 'dependabot-rebase' | 'update-branch';
    reason: 'token-missing';
  } | null;
  /** The UAT gate posted as the `uat` check-run; `null` when the gate is off or the PR is closed. */
  uatGate: {
    passes: boolean;
    required: boolean;
    reason: string;
    override: string | null;
  } | null;
}

export function toReconcileJson(target: ReconcileTarget, result: ReconcileResult): ReconcileJson {
  const { plan, botEligibility, lineage, skippedAutoMerge, skippedUpdate } = result;
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: `${target.owner}/${target.repo}`,
    pr: target.pr,
    dryRun: target.dryRun,
    state: plan.state,
    addLabels: plan.addLabels,
    removeLabels: plan.removeLabels,
    autoMerge: plan.autoMerge,
    botEligibility: {
      eligible: botEligibility.eligible,
      reason: botEligibility.reason,
      prType: botEligibility.prType ?? null,
      updateType: botEligibility.updateType ?? null,
    },
    carryOver:
      lineage === undefined
        ? null
        : { cleanAncestors: lineage.cleanAncestors, stoppedBecause: lineage.stoppedBecause },
    // The CLI makes release actions unavailable only for a missing token.
    autoMergeSkipped:
      skippedAutoMerge === undefined ? null : { action: skippedAutoMerge, reason: 'token-missing' },
    update: plan.update,
    updateSkipped:
      skippedUpdate === undefined ? null : { action: skippedUpdate, reason: 'token-missing' },
    uatGate:
      plan.uatGate === undefined
        ? null
        : {
            passes: plan.uatGate.passes,
            required: plan.uatGate.required,
            reason: plan.uatGate.reason,
            override: plan.uatGate.override ?? null,
          },
  };
}

/** One human-readable line, e.g. `rmartz/x#7 → approved: +approved, auto-merge arm`. */
export function formatSummary(target: ReconcileTarget, result: ReconcileResult): string {
  const { plan, botEligibility } = result;
  const changes = [
    ...plan.addLabels.map((label) => `+${label}`),
    ...plan.removeLabels.map((label) => `-${label}`),
    ...(plan.autoMerge === 'none' ? [] : [`auto-merge ${plan.autoMerge}`]),
    ...(result.skippedAutoMerge === undefined
      ? []
      : [`auto-merge ${result.skippedAutoMerge} skipped (no release token)`]),
    ...(plan.update === 'none' ? [] : [`update ${plan.update}`]),
    ...(result.skippedUpdate === undefined
      ? []
      : [`update ${result.skippedUpdate} skipped (no release token)`]),
    ...(plan.uatGate === undefined ? [] : [`uat ${plan.uatGate.passes ? 'pass' : 'hold'}`]),
  ];
  const prefix = target.dryRun ? '[dry-run] ' : '';
  const body = changes.length === 0 ? 'no changes' : changes.join(', ');
  return `${prefix}${target.owner}/${target.repo}#${target.pr} → ${plan.state}: ${body} (bot: ${botEligibility.reason})`;
}
