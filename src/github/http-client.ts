import type { ActorType, ReviewState } from '../facts.js';
import { REVIEW_STATES } from '../facts.js';
import type {
  CheckRunData,
  CollaboratorPermission,
  CommitData,
  CommitStatusData,
  GitHubClient,
  LabelDefinition,
  PullRequestData,
  ReviewData,
} from './client.js';
import { GitHubApiError } from './client.js';

/**
 * The real GitHubClient: REST for reads and labels, GraphQL for the auto-merge
 * mutations (REST has no endpoint for them). Deliberately thin — it maps requests
 * and responses and throws GitHubApiError on failure; every decision lives in
 * gather.ts / execute.ts. `fetch` is injectable so tests use a fake transport.
 */

export interface HttpClientOptions {
  token: string;
  owner: string;
  repo: string;
  /** Defaults to GitHub.com; pass GITHUB_API_URL for GHES. */
  apiUrl?: string;
  fetch?: typeof fetch;
}

const PAGE_SIZE = 100;

// Minimal shapes of the REST payloads we read. Fields are optional/unknown
// where GitHub can omit or null them.
interface RestPull {
  node_id: string;
  state: 'closed' | 'open';
  merged: boolean;
  draft?: boolean;
  title: string;
  user: { login: string } | null;
  /** `head.repo` is null when the fork was deleted. */
  head: { sha: string; ref: string; repo: { id: number } | null };
  base: { ref: string; repo: { id: number } };
  labels: { name: string }[];
  auto_merge: unknown;
  /** `null` while GitHub computes mergeability in the background. */
  mergeable: boolean | null;
}

interface RestCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
}

interface RestRule {
  type: string;
  parameters?: { required_status_checks?: { context: string }[] };
}

interface RestCommit {
  author: { login: string } | null;
  commit: { message: string };
}

interface RestReview {
  id: number;
  user: { login: string; type: string } | null;
  commit_id: string;
  state: string;
  body: string | null;
  submitted_at?: string | null;
}

interface GraphQlResponse {
  errors?: { message: string }[];
}

/** An unrecognized review state must never count as a verdict. */
function toReviewState(state: string): ReviewState {
  return REVIEW_STATES.find((known) => known === state) ?? 'DISMISSED';
}

/** Anything that isn't plainly a User (e.g. an Organization) is untrusted. */
function toActorType(type: string): ActorType {
  return type === 'User' ? 'User' : 'Bot';
}

function toReviewData(review: RestReview): ReviewData {
  return {
    id: review.id,
    login: review.user?.login,
    type: review.user === null ? 'User' : toActorType(review.user.type),
    commitSha: review.commit_id,
    state: toReviewState(review.state),
    body: review.body ?? '',
    submittedAt: review.submitted_at ?? undefined,
  };
}

const ENABLE_AUTO_MERGE = `mutation($id: ID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId }
}`;

const DISABLE_AUTO_MERGE = `mutation($id: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId }
}`;

export function createHttpClient(options: HttpClientOptions): GitHubClient {
  let apiUrl = options.apiUrl ?? 'https://api.github.com';
  while (apiUrl.endsWith('/')) {
    apiUrl = apiUrl.slice(0, -1);
  }
  const doFetch = options.fetch ?? fetch;
  const repoPath = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await doFetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'rmartz-pr-lifecycle',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new GitHubApiError(
        response.status,
        `${method} ${path} → ${response.status}: ${detail}`,
      );
    }
    return response.status === 204 ? undefined : response.json();
  }

  async function paginate<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page += 1) {
      const batch = (await request('GET', `${path}?per_page=${PAGE_SIZE}&page=${page}`)) as T[];
      items.push(...batch);
      if (batch.length < PAGE_SIZE) {
        return items;
      }
    }
  }

  async function graphql(query: string, variables: Record<string, string>): Promise<void> {
    const result = (await request('POST', '/graphql', { query, variables })) as GraphQlResponse;
    if (result.errors !== undefined && result.errors.length > 0) {
      const messages = result.errors.map((error) => error.message).join('; ');
      throw new GitHubApiError(200, `GraphQL error: ${messages}`);
    }
  }

  return {
    async getPullRequest(pr): Promise<PullRequestData> {
      const pull = (await request('GET', `${repoPath}/pulls/${pr}`)) as RestPull;
      return {
        nodeId: pull.node_id,
        state: pull.state,
        merged: pull.merged,
        draft: pull.draft === true,
        title: pull.title,
        headSha: pull.head.sha,
        labels: pull.labels.map((label) => label.name),
        autoMergeEnabled: pull.auto_merge !== null && pull.auto_merge !== undefined,
        authorLogin: pull.user?.login,
        headRef: pull.head.ref,
        baseRef: pull.base.ref,
        // Compare repo ids, not names (names change on rename); a deleted head
        // repo is treated as a fork, so it can never look like a trusted branch.
        isCrossRepository: pull.head.repo?.id !== pull.base.repo.id,
        mergeable: pull.mergeable ?? undefined,
      };
    },
    async getRequiredStatusChecks(branch) {
      // Rules from every active ruleset that targets the branch; several rulesets
      // can each require checks, so take the union.
      const rules = await paginate<RestRule>(
        `${repoPath}/rules/branches/${encodeURIComponent(branch)}`,
      );
      const contexts = rules
        .filter((rule) => rule.type === 'required_status_checks')
        .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
        .map((check) => check.context);
      return [...new Set(contexts)];
    },
    async getBranchHeadSha(branch) {
      const result = (await request(
        'GET',
        `${repoPath}/branches/${encodeURIComponent(branch)}`,
      )) as {
        commit: { sha: string };
      };
      return result.commit.sha;
    },
    async listCheckRuns(sha): Promise<CheckRunData[]> {
      // The default filter=latest returns only the most recent run per name, so
      // a re-run replaces the failure it retried.
      const runs: RestCheckRun[] = [];
      for (let page = 1; ; page += 1) {
        const batch = (await request(
          'GET',
          `${repoPath}/commits/${sha}/check-runs?per_page=${PAGE_SIZE}&page=${page}`,
        )) as { check_runs: RestCheckRun[] };
        runs.push(...batch.check_runs);
        if (batch.check_runs.length < PAGE_SIZE) {
          break;
        }
      }
      return runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        completedAt: run.completed_at,
      }));
    },
    async listCommitStatuses(sha): Promise<CommitStatusData[]> {
      // The combined status holds the latest status per context.
      const combined = (await request('GET', `${repoPath}/commits/${sha}/status`)) as {
        statuses: { context: string; state: string }[];
      };
      return combined.statuses.map((status) => ({ context: status.context, state: status.state }));
    },
    async listCommits(pr): Promise<CommitData[]> {
      const commits = await paginate<RestCommit>(`${repoPath}/pulls/${pr}/commits`);
      return commits.map((commit) => ({
        authorLogin: commit.author?.login,
        message: commit.commit.message,
      }));
    },
    async listReviews(pr) {
      const reviews = await paginate<RestReview>(`${repoPath}/pulls/${pr}/reviews`);
      return reviews.map(toReviewData);
    },
    async getCollaboratorPermission(login): Promise<CollaboratorPermission> {
      const result = (await request(
        'GET',
        `${repoPath}/collaborators/${encodeURIComponent(login)}/permission`,
      )) as { permission: string; role_name: string };
      return { permission: result.permission, roleName: result.role_name };
    },
    async listRepoLabels() {
      const labels = await paginate<{ name: string }>(`${repoPath}/labels`);
      return labels.map((label) => label.name);
    },
    async createLabel(label: LabelDefinition) {
      await request('POST', `${repoPath}/labels`, label);
    },
    async addLabels(pr, names) {
      await request('POST', `${repoPath}/issues/${pr}/labels`, { labels: names });
    },
    async removeLabel(pr, name) {
      await request('DELETE', `${repoPath}/issues/${pr}/labels/${encodeURIComponent(name)}`);
    },
    async enableAutoMerge(pullRequestNodeId) {
      await graphql(ENABLE_AUTO_MERGE, { id: pullRequestNodeId });
    },
    async disableAutoMerge(pullRequestNodeId) {
      await graphql(DISABLE_AUTO_MERGE, { id: pullRequestNodeId });
    },
  };
}
