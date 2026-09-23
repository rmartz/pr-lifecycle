import type { ReconcilePolicy } from '../facts.js';
import type { ReconcilePlan } from '../plan.js';
import { planReconcile } from '../plan.js';
import type { GitHubClient } from './client.js';
import { executePlan } from './execute.js';
import type { GatherOptions } from './gather.js';
import { gatherFacts } from './gather.js';

export interface ReconcileOptions extends GatherOptions {
  /** Compute and return the plan without writing anything. */
  dryRun?: boolean;
}

/**
 * One full reconcile pass for a PR: gather its facts, plan, and (unless dry-run)
 * execute. Returns the plan so callers can report what changed.
 */
export async function reconcilePullRequest(
  client: GitHubClient,
  pr: number,
  policy: ReconcilePolicy,
  options: ReconcileOptions = {},
): Promise<ReconcilePlan> {
  const { facts, nodeId } = await gatherFacts(client, pr, options);
  const plan = planReconcile(facts, policy);
  if (options.dryRun !== true) {
    await executePlan(client, { pr, nodeId }, plan);
  }
  return plan;
}
