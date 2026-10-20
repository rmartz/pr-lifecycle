import type { AutoMergeAction, ReconcilePlan } from '../plan.js';
import { UAT_LABELS } from '../uat.js';
import type { GitHubClient, ReleaseActions, UatLabelWrites } from './client.js';
import { GitHubApiError, isApiStatus } from './client.js';
import { labelDefinition } from './label-roster.js';

/**
 * Executes a reconcile plan against GitHub. Writes happen in a fail-safe order —
 * disarm, remove labels, add labels, arm, update — so a run that dies midway never
 * leaves auto-merge armed on a PR that is not approved, and an update (which moves
 * the head) comes last. Disarming, arming, merging, and updating go through
 * `release` (a real-actor token); arming and merging are bound to the planned
 * head. UAT label writes go through `uatWrites`, the same real actor when one is
 * configured (docs/uat.md). See docs/github-edge-layer.md.
 */

export interface PlanTarget {
  pr: number;
  nodeId: string;
  /** The head the plan was computed for; a merge or arm is rejected if it moved. */
  headSha: string;
}

/**
 * What the executor actually did about auto-merge. `autoMerge` can differ from the
 * plan's when GitHub's merge state changed between the read and the write (see
 * `armOrMerge`). `deferred` is set when both an arm and a merge lost that race:
 * nothing was armed or merged, and the next event converges.
 */
export interface ExecuteOutcome {
  autoMerge: AutoMergeAction;
  deferred: 'arm' | 'merge' | undefined;
}

/**
 * GitHub's refusal to arm a PR that is already mergeable ("clean status"). The PR
 * became mergeable between the read and the arm, so it is merged instead.
 */
function isCleanStatusError(error: unknown): boolean {
  return error instanceof GitHubApiError && /clean status/i.test(error.message);
}

/**
 * GitHub's refusal to merge a PR whose required checks haven't finished: a check
 * that is expected, queued, pending, or in progress. The PR stopped being
 * mergeable between the read and the merge (for example, the run's own label
 * writes re-triggered a required check), so it is armed instead and merges once
 * the check passes. Deliberately narrow: a failed check, a moved head, or any
 * other refusal is not a race and still propagates.
 */
function isPendingCheckError(error: unknown): boolean {
  return (
    error instanceof GitHubApiError &&
    /required status checks? .+ (?:is|are) (?:expected|queued|pending|in progress)/i.test(
      error.message,
    )
  );
}

type ArmOrMerge = 'arm' | 'merge';

const OTHER: Record<ArmOrMerge, ArmOrMerge> = { arm: 'merge', merge: 'arm' };

async function attempt(
  action: ArmOrMerge,
  release: ReleaseActions,
  target: PlanTarget,
): Promise<void> {
  switch (action) {
    case 'arm':
      await release.enableAutoMerge(target.nodeId, target.headSha);
      return;
    case 'merge':
      await release.mergePullRequest(target.nodeId, target.headSha);
  }
}

/** The error that means `action` lost the race and the other action should run. */
function lostRace(action: ArmOrMerge, error: unknown): boolean {
  switch (action) {
    case 'arm':
      return isCleanStatusError(error);
    case 'merge':
      return isPendingCheckError(error);
  }
}

/**
 * Arms or merges an approved PR. GitHub has no atomic "merge if mergeable, else
 * arm": arming a mergeable PR fails ("clean status") and merging one with a
 * required check still running fails, and the merge state can change between the
 * read and the write. Whichever is refused for that reason, the other is tried
 * once, bound to the same head. If the state flips back and the second is refused
 * the same way, the run gives up without error and reports it as deferred: the
 * next event (the check finishing, a review, a push) recomputes and converges.
 */
async function armOrMerge(
  planned: ArmOrMerge,
  release: ReleaseActions,
  target: PlanTarget,
): Promise<ExecuteOutcome> {
  try {
    await attempt(planned, release, target);
    return { autoMerge: planned, deferred: undefined };
  } catch (error) {
    if (!lostRace(planned, error)) {
      throw error;
    }
  }
  const fallback = OTHER[planned];
  try {
    await attempt(fallback, release, target);
    return { autoMerge: fallback, deferred: undefined };
  } catch (error) {
    if (!lostRace(fallback, error)) {
      throw error;
    }
    return { autoMerge: 'none', deferred: planned };
  }
}

/** Create any label about to be added that the repo doesn't have yet. */
async function ensureLabelsExist(client: GitHubClient, names: readonly string[]): Promise<void> {
  const existing = new Set(await client.listRepoLabels());
  for (const name of names) {
    if (existing.has(name)) {
      continue;
    }
    try {
      await client.createLabel(labelDefinition(name));
    } catch (error) {
      // 422: another run created it concurrently — the label exists, as needed.
      if (!isApiStatus(error, 422)) {
        throw error;
      }
    }
  }
}

function isUatLabel(name: string): boolean {
  return UAT_LABELS.some((label) => label === name);
}

export async function executePlan(
  client: GitHubClient,
  target: PlanTarget,
  plan: ReconcilePlan,
  release: ReleaseActions = client,
  uatWrites: UatLabelWrites = client,
): Promise<ExecuteOutcome> {
  if (plan.autoMerge === 'disarm') {
    await release.disableAutoMerge(target.nodeId);
  }
  for (const name of plan.removeLabels) {
    const writer = isUatLabel(name) ? uatWrites : client;
    try {
      await writer.removeLabel(target.pr, name);
    } catch (error) {
      // 404: already gone (e.g. removed by a concurrent run) — the goal state.
      if (!isApiStatus(error, 404)) {
        throw error;
      }
    }
  }
  if (plan.addLabels.length > 0) {
    await ensureLabelsExist(client, plan.addLabels);
    const uat = plan.addLabels.filter(isUatLabel);
    const lifecycle = plan.addLabels.filter((name) => !isUatLabel(name));
    if (lifecycle.length > 0) {
      await client.addLabels(target.pr, lifecycle);
    }
    // A UAT label is written by the real actor, whose label events fire workflows.
    if (uat.length > 0) {
      await uatWrites.addLabels(target.pr, uat);
    }
  }
  let outcome: ExecuteOutcome = { autoMerge: plan.autoMerge, deferred: undefined };
  if (plan.autoMerge === 'arm' || plan.autoMerge === 'merge') {
    outcome = await armOrMerge(plan.autoMerge, release, target);
  }
  // A PR that just merged, as planned or by falling back from an arm, needs no
  // update. One whose arm or merge was deferred keeps its update: it moves the
  // head, which re-triggers the reconcile that arms it.
  if (outcome.autoMerge === 'merge') {
    return outcome;
  }
  switch (plan.update) {
    case 'update-branch':
      await updateBranch(release, target);
      break;
    case 'none':
      break;
  }
  return outcome;
}

async function updateBranch(release: ReleaseActions, target: PlanTarget): Promise<void> {
  try {
    await release.updateBranch(target.pr, target.headSha);
  } catch (error) {
    // 422: the head moved since the read, or the base has nothing new. Either way
    // the push (or the base's) triggers a fresh event that re-evaluates.
    if (!isApiStatus(error, 422)) {
      throw error;
    }
  }
}
