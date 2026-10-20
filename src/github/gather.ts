import type { BotEligibility } from '../bot-eligibility.js';
import { DEPENDABOT_LOGIN } from '../bot-eligibility.js';
import type {
  BranchUpdater,
  PullRequestFacts,
  ReconcilePolicy,
  RepoPermission,
  ReviewFact,
} from '../facts.js';
import type { GitRunner } from '../lineage/git.js';
import { gatherBotEligibility } from './bot-facts.js';
import { gatherCiFacts } from './ci-facts.js';
import type { GitHubClient, PullRequestData, ReviewData } from './client.js';
import { isDependabotRebasing } from './dependabot-rebase.js';
import { gatherEscalationRemovals } from './escalation-facts.js';
import { gatherForcePushes } from './force-push-facts.js';
import type { Lineage } from './lineage-facts.js';
import { gatherLineage } from './lineage-facts.js';
import { lookupPermissions, toAuthor } from './permissions.js';
import {
  gatherCommitArrivals,
  gatherPathFacts,
  gatherSignOffApplications,
  presentSignOffs,
} from './uat-facts.js';

/**
 * Gathers a PR's facts from GitHub for the pure core. Everything is read before
 * anything is written (one gather → plan → execute pass per run), so a run never
 * reacts to its own writes. See docs/github-edge-layer.md.
 */

export interface GatheredPullRequest {
  facts: PullRequestFacts;
  /** GraphQL node id, for the auto-merge mutations. */
  nodeId: string;
  /** The bot-eligibility verdict behind `facts.botEligible`, with its reason. */
  botEligibility: BotEligibility;
  /** How far approval carry-over verified, for reporting (absent when off). */
  lineage: Lineage | undefined;
  /** When the PR was opened (ISO-8601), for the settle wait (settle.ts). */
  createdAt: string;
}

export interface GatherOptions {
  /**
   * Enables approval carry-over across clean base updates, which needs git and a
   * token that can fetch the repository. Omitted, carry-over is off (fail closed:
   * earlier-commit verdicts simply don't count).
   */
  lineage?: { git: GitRunner; token?: string; prosePatterns?: readonly string[] };
}

function toReviewFact(review: ReviewData, permissions: Map<string, RepoPermission>): ReviewFact {
  return {
    id: review.id,
    author: toAuthor(review, permissions),
    commitSha: review.commitSha,
    state: review.state,
    body: review.body,
    submittedAt: review.submittedAt ?? '',
  };
}

/** Carry-over only matters for an open PR, and only when enabled. */
async function gatherLineageFor(
  client: GitHubClient,
  pull: PullRequestData,
  reviews: readonly ReviewData[],
  options: GatherOptions,
): Promise<Lineage | undefined> {
  if (options.lineage === undefined || pull.state !== 'open') {
    return undefined;
  }
  try {
    const baseHeadSha = await client.getBranchHeadSha(pull.baseRef);
    // `return await`, not `return`: an un-awaited rejection would escape the catch.
    return await gatherLineage(client, options.lineage.git, {
      headSha: pull.headSha,
      baseHeadSha,
      source: {
        url: pull.cloneUrl,
        ...(options.lineage.token === undefined ? {} : { token: options.lineage.token }),
      },
      reviews,
      ...(options.lineage.prosePatterns === undefined
        ? {}
        : { prosePatterns: options.lineage.prosePatterns }),
    });
  } catch (error) {
    // Fail closed, but keep the reason: `undefined` would read as "didn't run".
    const message = error instanceof Error ? error.message : String(error);
    return { cleanAncestors: [], stoppedBecause: `verification failed: ${message}`, rebases: [] };
  }
}

/**
 * Merge states in which GitHub merges without waiting on anything, so arming
 * auto-merge fails ("clean status"). Mirrors `gh`'s `isImmediatelyMergeable`;
 * `unstable` means only non-required checks are failing.
 */
const IMMEDIATE_MERGE_STATES = new Set(['clean', 'has_hooks', 'unstable']);

export async function gatherFacts(
  client: GitHubClient,
  pr: number,
  policy: ReconcilePolicy = {},
  options: GatherOptions = {},
): Promise<GatheredPullRequest> {
  const [pull, reviews] = await Promise.all([client.getPullRequest(pr), client.listReviews(pr)]);
  const signOffLabels = presentSignOffs(policy, pull);
  const hasSignOff = signOffLabels.length > 0;
  const [removals, forcePushes, signOffs, titleChanges] = await Promise.all([
    gatherEscalationRemovals(client, pr, reviews),
    gatherForcePushes(client, pr, reviews, hasSignOff),
    gatherSignOffApplications(client, pr, signOffLabels),
    hasSignOff ? client.listTitleChanges(pr) : [],
  ]);
  // Dependabot rebases its own branches; the author login can't be forged.
  const updater: BranchUpdater = pull.authorLogin === DEPENDABOT_LOGIN ? 'dependabot' : 'github';
  const signOffActors = signOffs.map(({ application }) => application);
  const [permissions, botEligibility, ci, lineage, pathFacts] = await Promise.all([
    lookupPermissions(client, [...reviews, ...removals, ...signOffActors]),
    gatherBotEligibility(client, pr, pull),
    gatherCiFacts(client, pull, policy),
    gatherLineageFor(client, pull, reviews, options),
    gatherPathFacts(client, pr, pull, policy),
  ]);
  const cleanAncestors = lineage?.cleanAncestors ?? [];
  const cleanRebaseSources =
    lineage?.rebases.filter((check) => check.carried).map((check) => check.source) ?? [];
  // A sign-off binds to the head or a carried commit, so only their arrivals matter.
  const commitArrivals = hasSignOff
    ? await gatherCommitArrivals(client, pull, [
        pull.headSha,
        ...cleanAncestors,
        ...cleanRebaseSources,
      ])
    : {};
  return {
    nodeId: pull.nodeId,
    botEligibility,
    lineage,
    createdAt: pull.createdAt,
    facts: {
      status: pull.merged ? 'merged' : pull.state,
      isDraft: pull.draft,
      title: pull.title,
      headSha: pull.headSha,
      labels: pull.labels,
      autoMergeEnabled: pull.autoMergeEnabled,
      botEligible: botEligibility.eligible,
      mergeable: pull.mergeable,
      immediatelyMergeable: IMMEDIATE_MERGE_STATES.has(pull.mergeState ?? ''),
      ciStatus: ci.ciStatus,
      baseCiFailing: ci.baseCiFailing,
      cleanAncestors,
      cleanRebaseSources,
      updater,
      dependabotRebasing: updater === 'dependabot' && isDependabotRebasing(pull.body),
      reviews: reviews.map((review) => toReviewFact(review, permissions)),
      forcePushes,
      escalationRemovals: removals.map((removal) => ({
        actor: toAuthor(removal, permissions),
        removedAt: removal.removedAt,
      })),
      pendingBotReviewers: pull.requestedBotReviewers,
      ...pathFacts,
      ...(hasSignOff
        ? {
            uatSignOffs: signOffs.map(({ label, application }) => ({
              label,
              actor: toAuthor(application, permissions),
              appliedAt: application.appliedAt,
            })),
            commitArrivals,
            titleChanges,
          }
        : {}),
    },
  };
}
