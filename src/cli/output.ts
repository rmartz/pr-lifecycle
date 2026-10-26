import type { ReconcileResult } from '../github/reconcile.js';
import { uatLabelFor } from '../uat.js';

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
  /** Approval carry-over across clean base updates and rebases; `null` when it didn't run. */
  carryOver: {
    cleanAncestors: string[];
    stoppedBecause: string;
    rebases: { source: string; carried: boolean; reason: string }[];
  } | null;
  /** An arm or merge the plan wanted but skipped; `null` when nothing was skipped. */
  autoMergeSkipped: { action: 'arm' | 'merge'; reason: 'token-missing' } | null;
  /** The branch update performed: `none` or `update-branch`. */
  update: string;
  /**
   * An arm or merge deferred because GitHub's merge state changed mid-run and its
   * fallback lost the same race; `null` otherwise. The next event converges.
   */
  autoMergeDeferred: { action: 'arm' | 'merge'; reason: 'merge-state-changed' } | null;
  /** A branch update the plan wanted but skipped; `null` when nothing was skipped. */
  updateSkipped: {
    action: 'update-branch';
    reason: 'token-missing';
  } | null;
  /**
   * The UAT classification: the label the PR carries and the rule that chose it
   * (docs/uat.md); `null` when UAT labels aren't reconciled or the PR is closed.
   * A PR that needs the CI sign-off instead reports `ci` with `no UAT needed`.
   */
  uat: { outcome: string; label: string } | null;
  /**
   * Which sign-off the head needs and the `pr-lifecycle/sign-off` status that
   * says so (docs/sign-off-status.md); `null` when not reconciled or closed.
   * `statusPosted` is whether the status was posted this run (on a dry run,
   * whether it would be); an unchanged status isn't reposted.
   */
  signOff: {
    requirement: string;
    reason: string;
    loosening: boolean;
    status: string;
    statusPosted: boolean;
  } | null;
  /** The status the plan wanted but skipped; `null` when nothing was skipped. */
  signOffStatusSkipped: { reason: 'token-missing' } | null;
}

export function toReconcileJson(target: ReconcileTarget, result: ReconcileResult): ReconcileJson {
  const { plan, botEligibility, lineage, skippedAutoMerge, skippedUpdate, deferredAutoMerge } =
    result;
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: `${target.owner}/${target.repo}`,
    pr: target.pr,
    dryRun: target.dryRun,
    state: plan.state,
    addLabels: plan.addLabels,
    removeLabels: plan.removeLabels,
    autoMerge: result.autoMerge,
    botEligibility: {
      eligible: botEligibility.eligible,
      reason: botEligibility.reason,
      prType: botEligibility.prType ?? null,
      updateType: botEligibility.updateType ?? null,
    },
    carryOver:
      lineage === undefined
        ? null
        : {
            cleanAncestors: lineage.cleanAncestors,
            stoppedBecause: lineage.stoppedBecause,
            rebases: lineage.rebases,
          },
    // The CLI makes release actions unavailable only for a missing token.
    autoMergeSkipped:
      skippedAutoMerge === undefined ? null : { action: skippedAutoMerge, reason: 'token-missing' },
    autoMergeDeferred:
      deferredAutoMerge === undefined
        ? null
        : { action: deferredAutoMerge, reason: 'merge-state-changed' },
    update: plan.update,
    updateSkipped:
      skippedUpdate === undefined ? null : { action: skippedUpdate, reason: 'token-missing' },
    uat: plan.uat === undefined ? null : { outcome: plan.uat, label: uatLabelFor(plan.uat) },
    signOff:
      plan.signOff === undefined || plan.signOffStatus === undefined
        ? null
        : {
            requirement: plan.signOff.requirement,
            reason: plan.signOff.reason,
            loosening: plan.signOff.loosening,
            status: plan.signOffStatus.description,
            statusPosted: plan.signOffStatus.post,
          },
    signOffStatusSkipped: result.skippedSignOffStatus ? { reason: 'token-missing' } : null,
  };
}

/** One human-readable line, e.g. `octo-org/app#7 → approved: +approved, auto-merge arm`. */
export function formatSummary(target: ReconcileTarget, result: ReconcileResult): string {
  const { plan, botEligibility } = result;
  const changes = [
    ...plan.addLabels.map((label) => `+${label}`),
    ...plan.removeLabels.map((label) => `-${label}`),
    ...(result.autoMerge === 'none' ? [] : [`auto-merge ${result.autoMerge}`]),
    ...(result.deferredAutoMerge === undefined
      ? []
      : [`auto-merge ${result.deferredAutoMerge} deferred (merge state changed)`]),
    ...(result.skippedAutoMerge === undefined
      ? []
      : [`auto-merge ${result.skippedAutoMerge} skipped (no release token)`]),
    ...(plan.update === 'none' ? [] : [`update ${plan.update}`]),
    ...(result.skippedUpdate === undefined
      ? []
      : [`update ${result.skippedUpdate} skipped (no release token)`]),
    ...(result.skippedSignOffStatus ? ['sign-off status skipped (no release token)'] : []),
  ];
  const prefix = target.dryRun ? '[dry-run] ' : '';
  const body = changes.length === 0 ? 'no changes' : changes.join(', ');
  return `${prefix}${target.owner}/${target.repo}#${target.pr} → ${plan.state}: ${body} (bot: ${botEligibility.reason})`;
}
