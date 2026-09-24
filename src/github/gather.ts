import type { BotEligibility } from '../bot-eligibility.js';
import { DEPENDABOT_LOGIN } from '../bot-eligibility.js';
import type {
  BranchUpdater,
  PullRequestFacts,
  ReconcilePolicy,
  RepoPermission,
  ReviewFact,
} from '../facts.js';
import { REPO_PERMISSIONS } from '../facts.js';
import type { GitRunner } from '../lineage/git.js';
import { UPDATE_REQUIRED_LABEL } from '../plan.js';
import { gatherBotEligibility } from './bot-facts.js';
import { gatherCiFacts } from './ci-facts.js';
import type { GitHubClient, PullRequestData, ReviewData } from './client.js';
import { isApiStatus } from './client.js';
import { DEPENDABOT_REBASING_NOTICE, isRebasePending } from './dependabot-rebase.js';
import type { Lineage } from './lineage-facts.js';
import { gatherLineage } from './lineage-facts.js';

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
}

export interface GatherOptions {
  /**
   * Enables approval carry-over across clean base updates, which needs git and a
   * token that can fetch the repository. Omitted, carry-over is off (fail closed:
   * earlier-commit verdicts simply don't count).
   */
  lineage?: { git: GitRunner; token?: string };
}

function isRepoPermission(value: string): value is RepoPermission {
  return REPO_PERMISSIONS.some((permission) => permission === value);
}

/**
 * The author's permission, preferring the fine-grained role (which distinguishes
 * maintain and triage) and falling back to the legacy level for custom roles.
 * A non-collaborator (404) has no permission.
 */
async function lookupPermission(client: GitHubClient, login: string): Promise<RepoPermission> {
  try {
    const { permission, roleName } = await client.getCollaboratorPermission(login);
    if (isRepoPermission(roleName)) {
      return roleName;
    }
    return isRepoPermission(permission) ? permission : 'none';
  } catch (error) {
    if (isApiStatus(error, 404)) {
      return 'none';
    }
    throw error;
  }
}

/**
 * Permissions for every author who could possibly be trusted. Bots and deleted
 * ("ghost") accounts can never cast a counting verdict, so they skip the lookup.
 */
async function lookupPermissions(
  client: GitHubClient,
  reviews: readonly ReviewData[],
): Promise<Map<string, RepoPermission>> {
  const logins = new Set<string>();
  for (const review of reviews) {
    if (review.login !== undefined && review.type === 'User') {
      logins.add(review.login);
    }
  }
  const entries = await Promise.all(
    [...logins].map(async (login) => [login, await lookupPermission(client, login)] as const),
  );
  return new Map(entries);
}

function toReviewFact(review: ReviewData, permissions: Map<string, RepoPermission>): ReviewFact {
  // Only looked-up Users have an entry; bots and ghosts get no permission.
  const permission = review.login === undefined ? undefined : permissions.get(review.login);
  return {
    id: review.id,
    author: {
      login: review.login ?? 'ghost',
      type: review.type,
      permission: permission ?? 'none',
    },
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
    });
  } catch (error) {
    // Fail closed, but keep the reason: `undefined` would read as "didn't run".
    const message = error instanceof Error ? error.message : String(error);
    return { cleanAncestors: [], stoppedBecause: `verification failed: ${message}` };
  }
}

/**
 * Whether a Dependabot rebase is already running or requested for this head. The
 * comments are only read when an update could actually be planned.
 */
async function gatherRebasePending(
  client: GitHubClient,
  pr: number,
  pull: PullRequestData,
  updater: BranchUpdater,
  policy: ReconcilePolicy,
): Promise<boolean> {
  if (updater !== 'dependabot') {
    return false;
  }
  if (pull.body.includes(DEPENDABOT_REBASING_NOTICE)) {
    return true;
  }
  const couldUpdate =
    policy.autoUpdate === true &&
    pull.state === 'open' &&
    pull.labels.includes(UPDATE_REQUIRED_LABEL);
  if (!couldUpdate) {
    return false;
  }
  return isRebasePending(pull.body, await client.listIssueComments(pr), pull.headSha);
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
  // Dependabot rebases its own branches; the author login can't be forged.
  const updater: BranchUpdater = pull.authorLogin === DEPENDABOT_LOGIN ? 'dependabot' : 'github';
  const [permissions, botEligibility, ci, lineage, rebasePending] = await Promise.all([
    lookupPermissions(client, reviews),
    gatherBotEligibility(client, pr, pull),
    gatherCiFacts(client, pull, policy),
    gatherLineageFor(client, pull, reviews, options),
    gatherRebasePending(client, pr, pull, updater, policy),
  ]);
  return {
    nodeId: pull.nodeId,
    botEligibility,
    lineage,
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
      cleanAncestors: lineage?.cleanAncestors ?? [],
      updater,
      rebasePending,
      reviews: reviews.map((review) => toReviewFact(review, permissions)),
    },
  };
}
