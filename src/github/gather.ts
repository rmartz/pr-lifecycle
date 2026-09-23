import type { PullRequestFacts, RepoPermission, ReviewFact } from '../facts.js';
import { REPO_PERMISSIONS } from '../facts.js';
import type { GitHubClient, ReviewData } from './client.js';
import { isApiStatus } from './client.js';

/**
 * Gathers a PR's facts from GitHub for the pure core. Everything is read before
 * anything is written (one gather → plan → execute pass per run), so a run never
 * reacts to its own writes. See docs/github-edge-layer.md.
 */

export interface GatheredPullRequest {
  facts: PullRequestFacts;
  /** GraphQL node id, for the auto-merge mutations. */
  nodeId: string;
}

export interface GatherOptions {
  /** Result of the bot-PR eligibility predicate (#5); false until it exists. */
  botEligible?: boolean;
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

export async function gatherFacts(
  client: GitHubClient,
  pr: number,
  options: GatherOptions = {},
): Promise<GatheredPullRequest> {
  const [pull, reviews] = await Promise.all([client.getPullRequest(pr), client.listReviews(pr)]);
  const permissions = await lookupPermissions(client, reviews);
  return {
    nodeId: pull.nodeId,
    facts: {
      status: pull.merged ? 'merged' : pull.state,
      isDraft: pull.draft,
      title: pull.title,
      headSha: pull.headSha,
      labels: pull.labels,
      autoMergeEnabled: pull.autoMergeEnabled,
      botEligible: options.botEligible === true,
      reviews: reviews.map((review) => toReviewFact(review, permissions)),
    },
  };
}
