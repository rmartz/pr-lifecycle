import type { ReconcilePlan } from '../plan.js';
import type { GitHubClient, ReleaseActions } from './client.js';
import { GitHubApiError, isApiStatus } from './client.js';
import { labelDefinition } from './label-roster.js';

/**
 * Executes a reconcile plan against GitHub. Writes happen in a fail-safe order —
 * disarm, remove labels, add labels, arm — so a run that dies midway never leaves
 * auto-merge armed on a PR that is not approved. Arming and merging go through
 * `release` (a real-actor token) and are bound to the planned head. See
 * docs/github-edge-layer.md.
 */

export interface PlanTarget {
  pr: number;
  nodeId: string;
  /** The head the plan was computed for; a merge or arm is rejected if it moved. */
  headSha: string;
}

/**
 * GitHub's refusal to arm a PR that is already mergeable. The PR became
 * mergeable between the read and the arm, so it is merged instead.
 */
function isCleanStatusError(error: unknown): boolean {
  return error instanceof GitHubApiError && /clean status/i.test(error.message);
}

async function armOrMerge(release: ReleaseActions, target: PlanTarget): Promise<void> {
  try {
    await release.enableAutoMerge(target.nodeId, target.headSha);
  } catch (error) {
    if (!isCleanStatusError(error)) {
      throw error;
    }
    await release.mergePullRequest(target.nodeId, target.headSha);
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

export async function executePlan(
  client: GitHubClient,
  target: PlanTarget,
  plan: ReconcilePlan,
  release: ReleaseActions = client,
): Promise<void> {
  if (plan.autoMerge === 'disarm') {
    await client.disableAutoMerge(target.nodeId);
  }
  for (const name of plan.removeLabels) {
    try {
      await client.removeLabel(target.pr, name);
    } catch (error) {
      // 404: already gone (e.g. removed by a concurrent run) — the goal state.
      if (!isApiStatus(error, 404)) {
        throw error;
      }
    }
  }
  if (plan.addLabels.length > 0) {
    await ensureLabelsExist(client, plan.addLabels);
    await client.addLabels(target.pr, plan.addLabels);
  }
  if (plan.autoMerge === 'arm') {
    await armOrMerge(release, target);
  }
  if (plan.autoMerge === 'merge') {
    await release.mergePullRequest(target.nodeId, target.headSha);
  }
}
