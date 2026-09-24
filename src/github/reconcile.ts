import type { BotEligibility } from '../bot-eligibility.js';
import type { ReconcilePolicy } from '../facts.js';
import type { ReconcilePlan } from '../plan.js';
import { planReconcile } from '../plan.js';
import type { GitHubClient } from './client.js';
import { executePlan } from './execute.js';
import type { GatherOptions } from './gather.js';
import { gatherFacts } from './gather.js';
import type { Lineage } from './lineage-facts.js';

export interface ReconcileOptions extends GatherOptions {
  /** Compute and return the plan without writing anything. */
  dryRun?: boolean;
}

export interface ReconcileResult {
  plan: ReconcilePlan;
  /** Why the PR was (or wasn't) treated as a trusted bot PR, for reporting. */
  botEligibility: BotEligibility;
  /** How far approval carry-over verified (absent when carry-over is off). */
  lineage: Lineage | undefined;
}

/**
 * One full reconcile pass for a PR: gather its facts, plan, and (unless dry-run)
 * execute. Returns the plan, the bot-eligibility verdict, and the carry-over
 * result so callers can report what changed and why.
 */
export async function reconcilePullRequest(
  client: GitHubClient,
  pr: number,
  policy: ReconcilePolicy,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const { facts, nodeId, botEligibility, lineage } = await gatherFacts(client, pr, policy, options);
  const plan = planReconcile(facts, policy);
  if (options.dryRun !== true) {
    await executePlan(client, { pr, nodeId }, plan);
  }
  return { plan, botEligibility, lineage };
}
