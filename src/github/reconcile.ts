import type { BotEligibility } from '../bot-eligibility.js';
import type { ReconcilePolicy } from '../facts.js';
import type { ReconcilePlan, UpdateAction } from '../plan.js';
import { planReconcile, withoutReleaseActions } from '../plan.js';
import type { GitHubClient, ReleaseActions } from './client.js';
import { executePlan } from './execute.js';
import type { GatherOptions } from './gather.js';
import { gatherFacts } from './gather.js';
import type { Lineage } from './lineage-facts.js';

export interface ReconcileOptions extends GatherOptions {
  /** Compute and return the plan without writing anything. */
  dryRun?: boolean;
  /**
   * Who arms, merges, and updates. Defaults to `client`, right when its token is a
   * real actor. `'unavailable'` (no real-actor token configured) skips them rather
   * than doing them with a token whose pushes and merges trigger no workflows.
   */
  release?: ReleaseActions | 'unavailable';
}

export interface ReconcileResult {
  plan: ReconcilePlan;
  /** Why the PR was (or wasn't) treated as a trusted bot PR, for reporting. */
  botEligibility: BotEligibility;
  /** How far approval carry-over verified (absent when carry-over is off). */
  lineage: Lineage | undefined;
  /** The arm or merge the plan wanted but skipped because `release` was unavailable. */
  skippedAutoMerge: 'arm' | 'merge' | undefined;
  /** The branch update the plan wanted but skipped because `release` was unavailable. */
  skippedUpdate: Exclude<UpdateAction, 'none'> | undefined;
}

/**
 * Stands in for the release actions when none are available. `withoutReleaseActions`
 * already removed every arm, merge, and update from the plan, so reaching this is a
 * bug; refusing guarantees it can never fall back to a token whose writes fire nothing.
 */
const REFUSE_RELEASE: ReleaseActions = {
  createIssueComment: () => Promise.reject(new Error('rebase requests need a release token')),
  enableAutoMerge: () => Promise.reject(new Error('arming needs a release token')),
  mergePullRequest: () => Promise.reject(new Error('merging needs a release token')),
  updateBranch: () => Promise.reject(new Error('updating needs a release token')),
};

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
  const { facts, nodeId, botEligibility, lineage, uatChecks } = await gatherFacts(
    client,
    pr,
    policy,
    options,
  );
  const planned = planReconcile(facts, policy);
  const unavailable = options.release === 'unavailable';
  const plan = unavailable ? withoutReleaseActions(planned) : planned;
  if (options.dryRun !== true) {
    const release =
      options.release === 'unavailable' ? REFUSE_RELEASE : (options.release ?? client);
    const target = { pr, nodeId, headSha: facts.headSha, uatChecks };
    await executePlan(client, target, plan, release);
  }
  const wanted = planned.autoMerge;
  const skippedAutoMerge =
    unavailable && (wanted === 'arm' || wanted === 'merge') ? wanted : undefined;
  const skippedUpdate = unavailable && planned.update !== 'none' ? planned.update : undefined;
  return { plan, botEligibility, lineage, skippedAutoMerge, skippedUpdate };
}
