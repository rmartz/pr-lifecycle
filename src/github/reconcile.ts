import type { BotEligibility } from '../bot-eligibility.js';
import type { ReconcilePolicy } from '../facts.js';
import type { ReconcilePlan } from '../plan.js';
import { planReconcile } from '../plan.js';
import type { GitHubClient } from './client.js';
import { executePlan } from './execute.js';
import { gatherFacts } from './gather.js';

export interface ReconcileOptions {
  /** Compute and return the plan without writing anything. */
  dryRun?: boolean;
}

export interface ReconcileResult {
  plan: ReconcilePlan;
  /** Why the PR was (or wasn't) treated as a trusted bot PR, for reporting. */
  botEligibility: BotEligibility;
}

/**
 * One full reconcile pass for a PR: gather its facts, plan, and (unless dry-run)
 * execute. Returns the plan and the bot-eligibility verdict so callers can report
 * what changed and why.
 */
export async function reconcilePullRequest(
  client: GitHubClient,
  pr: number,
  policy: ReconcilePolicy,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const { facts, nodeId, botEligibility } = await gatherFacts(client, pr);
  const plan = planReconcile(facts, policy);
  if (options.dryRun !== true) {
    await executePlan(client, { pr, nodeId }, plan);
  }
  return { plan, botEligibility };
}
