import type { BotEligibility } from '../bot-eligibility.js';
import { classifyBotPr, DEPENDABOT_LOGIN } from '../bot-eligibility.js';
import type { PullRequestFacts, ReconcilePolicy, RepoPermission, ReviewFact } from '../facts.js';
import { REPO_PERMISSIONS } from '../facts.js';
import type { GitRunner } from '../lineage/git.js';
import { gatherCiFacts } from './ci-facts.js';
import type { GitHubClient, PullRequestData, ReviewData } from './client.js';
import { isApiStatus } from './client.js';
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

/**
 * Classify the PR for bot eligibility. Commits are only fetched for a Dependabot
 * PR from this repository — the one case where they can change the answer.
 */
async function gatherBotEligibility(
  client: GitHubClient,
  pr: number,
  pull: PullRequestData,
): Promise<BotEligibility> {
  const needsCommits = pull.authorLogin === DEPENDABOT_LOGIN && !pull.isCrossRepository;
  return classifyBotPr({
    authorLogin: pull.authorLogin ?? 'ghost',
    headRef: pull.headRef,
    isCrossRepository: pull.isCrossRepository,
    labels: pull.labels,
    commits: needsCommits ? await client.listCommits(pr) : [],
  });
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
  const baseHeadSha = await client.getBranchHeadSha(pull.baseRef);
  return gatherLineage(client, options.lineage.git, {
    headSha: pull.headSha,
    baseHeadSha,
    source: {
      url: pull.cloneUrl,
      ...(options.lineage.token === undefined ? {} : { token: options.lineage.token }),
    },
    reviews,
  });
}

export async function gatherFacts(
  client: GitHubClient,
  pr: number,
  policy: ReconcilePolicy = {},
  options: GatherOptions = {},
): Promise<GatheredPullRequest> {
  const [pull, reviews] = await Promise.all([client.getPullRequest(pr), client.listReviews(pr)]);
  const [permissions, botEligibility, ci, lineage] = await Promise.all([
    lookupPermissions(client, reviews),
    gatherBotEligibility(client, pr, pull),
    gatherCiFacts(client, pull, policy),
    gatherLineageFor(client, pull, reviews, options),
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
      ciStatus: ci.ciStatus,
      baseCiFailing: ci.baseCiFailing,
      cleanAncestors: lineage?.cleanAncestors ?? [],
      reviews: reviews.map((review) => toReviewFact(review, permissions)),
    },
  };
}
