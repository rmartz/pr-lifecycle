import type { BotEligibility } from '../bot-eligibility.js';
import type { ReconcilePolicy } from '../facts.js';
import type { ReconcilePlan, UpdateAction } from '../plan.js';
import { planReconcile, withoutReleaseActions } from '../plan.js';
import type { GitHubClient, ReleaseActions } from './client.js';
import { executePlan } from './execute.js';
import type { GatherOptions } from './gather.js';
import { gatherFacts } from './gather.js';
import type { Lineage } from './lineage-facts.js';
import type { SettleOptions } from './settle.js';
import { resolveSettle, settleDelay } from './settle.js';

export interface ReconcileOptions extends GatherOptions {
  /** The settle wait for a PR that just became reviewable (settle.ts). */
  settle?: SettleOptions;
  /** Compute and return the plan without writing anything. */
  dryRun?: boolean;
  /**
   * Who disarms, arms, merges, and updates. Defaults to `client`, right when its
   * token is a real actor. `'unavailable'` (no real-actor token configured) skips
   * arming, merging, and updating rather than doing them with a token whose pushes
   * and merges trigger no workflows; a disarm falls back to `client`.
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
  /** How long the run waited for bot review requests before gathering again (ms). */
  settledMs: number;
}

/**
 * Stands in for the release actions when none are available. `withoutReleaseActions`
 * already removed every arm, merge, and update from the plan, so reaching one of
 * those is a bug; refusing guarantees it can never fall back to a token whose writes
 * fire nothing. A disarm is safety, so it is still attempted with the workflow
 * client: nothing this package did armed the PR, but whoever did may be undone.
 */
function refuseRelease(client: GitHubClient): ReleaseActions {
  return {
    createIssueComment: () => Promise.reject(new Error('rebase requests need a release token')),
    disableAutoMerge: (pullRequestNodeId) => client.disableAutoMerge(pullRequestNodeId),
    enableAutoMerge: () => Promise.reject(new Error('arming needs a release token')),
    mergePullRequest: () => Promise.reject(new Error('merging needs a release token')),
    updateBranch: () => Promise.reject(new Error('updating needs a release token')),
  };
}

/**
 * One full reconcile pass for a PR: gather its facts (waiting to settle first if it
 * just became reviewable), plan, and (unless dry-run) execute. Returns the plan, the bot-eligibility verdict, and the carry-over
 * result so callers can report what changed and why.
 */
export async function reconcilePullRequest(
  client: GitHubClient,
  pr: number,
  policy: ReconcilePolicy,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const settle = resolveSettle(options.settle);
  let gathered = await gatherFacts(client, pr, policy, options);
  const settledMs = await settleDelay(client, pr, gathered, policy, settle.settleMs, settle.now());
  if (settledMs > 0) {
    // Gather again rather than trusting stale facts: anything may have changed.
    await settle.sleep(settledMs);
    gathered = await gatherFacts(client, pr, policy, options);
  }
  const { facts, nodeId, botEligibility, lineage } = gathered;
  const planned = planReconcile(facts, policy);
  const unavailable = options.release === 'unavailable';
  const plan = unavailable ? withoutReleaseActions(planned) : planned;
  if (options.dryRun !== true) {
    const release =
      options.release === 'unavailable' ? refuseRelease(client) : (options.release ?? client);
    await executePlan(client, { pr, nodeId, headSha: facts.headSha }, plan, release);
  }
  const wanted = planned.autoMerge;
  const skippedAutoMerge =
    unavailable && (wanted === 'arm' || wanted === 'merge') ? wanted : undefined;
  const skippedUpdate = unavailable && planned.update !== 'none' ? planned.update : undefined;
  return { plan, botEligibility, lineage, skippedAutoMerge, skippedUpdate, settledMs };
}
