import type {
  CollaboratorPermission,
  CommitComparison,
  CommitData,
  CommitObject,
  GitHubClient,
  LabelDefinition,
  PullRequestData,
} from './client.js';
import { createCheckMethods } from './http-checks.js';
import type { HttpClientOptions } from './http-transport.js';
import { createTransport } from './http-transport.js';
import type { RestCommit, RestPull, RestPullFile, RestReview } from './rest-payloads.js';
import { toReviewData } from './rest-payloads.js';

/**
 * The real GitHubClient: REST for reads and labels, GraphQL for the auto-merge
 * mutations (REST has no endpoint for them). Deliberately thin — it maps requests
 * and responses and throws GitHubApiError on failure; every decision lives in
 * gather.ts / execute.ts. `fetch` is injectable so tests use a fake transport.
 */

export type { HttpClientOptions } from './http-transport.js';

const ENABLE_AUTO_MERGE = `mutation($id: ID!, $head: GitObjectID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $head }) { clientMutationId }
}`;

const MERGE_PULL_REQUEST = `mutation($id: ID!, $head: GitObjectID!) {
  mergePullRequest(input: { pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $head }) { clientMutationId }
}`;

const DISABLE_AUTO_MERGE = `mutation($id: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId }
}`;

export function createHttpClient(options: HttpClientOptions): GitHubClient {
  const transport = createTransport(options);
  const { repoPath, request, paginate, graphql } = transport;

  return {
    ...createCheckMethods(transport),
    async getPullRequest(pr): Promise<PullRequestData> {
      const pull = (await request('GET', `${repoPath}/pulls/${pr}`)) as RestPull;
      return {
        nodeId: pull.node_id,
        state: pull.state,
        merged: pull.merged,
        draft: pull.draft === true,
        title: pull.title,
        body: pull.body ?? '',
        headSha: pull.head.sha,
        labels: pull.labels.map((label) => label.name),
        autoMergeEnabled: pull.auto_merge !== null && pull.auto_merge !== undefined,
        authorLogin: pull.user?.login,
        headRef: pull.head.ref,
        baseRef: pull.base.ref,
        cloneUrl: pull.base.repo.clone_url,
        // Compare repo ids, not names (names change on rename); a deleted head
        // repo is treated as a fork, so it can never look like a trusted branch.
        isCrossRepository: pull.head.repo?.id !== pull.base.repo.id,
        mergeable: pull.mergeable ?? undefined,
        mergeState: pull.mergeable_state,
        changedFileCount: pull.changed_files,
      };
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
    async getCommit(sha): Promise<CommitObject> {
      const commit = (await request('GET', `${repoPath}/git/commits/${sha}`)) as {
        tree: { sha: string };
        parents: { sha: string }[];
      };
      return { treeSha: commit.tree.sha, parents: commit.parents.map((parent) => parent.sha) };
    },
    async compareCommits(base, head): Promise<CommitComparison> {
      // Three-dot compare: status relative to `base`, plus their merge base. Only
      // the summary is needed, so ask for a single commit page.
      const result = (await request('GET', `${repoPath}/compare/${base}...${head}?per_page=1`)) as {
        status: string;
        merge_base_commit: { sha: string };
      };
      return { status: result.status, mergeBaseSha: result.merge_base_commit.sha };
    },
    async listPullRequestFiles(pr) {
      const files = await paginate<RestPullFile>(`${repoPath}/pulls/${pr}/files`);
      return files.map((file) => ({
        filename: file.filename,
        status: file.status,
        patch: file.patch,
      }));
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
    async listIssueComments(pr) {
      const comments = await paginate<{ body: string | null }>(`${repoPath}/issues/${pr}/comments`);
      return comments.map((comment) => comment.body ?? '');
    },
    async createIssueComment(pr, body) {
      await request('POST', `${repoPath}/issues/${pr}/comments`, { body });
    },
    async enableAutoMerge(pullRequestNodeId, expectedHeadOid) {
      await graphql(ENABLE_AUTO_MERGE, { id: pullRequestNodeId, head: expectedHeadOid });
    },
    async mergePullRequest(pullRequestNodeId, expectedHeadOid) {
      await graphql(MERGE_PULL_REQUEST, { id: pullRequestNodeId, head: expectedHeadOid });
    },
    async updateBranch(pr, expectedHeadSha) {
      await request('PUT', `${repoPath}/pulls/${pr}/update-branch`, {
        expected_head_sha: expectedHeadSha,
      });
    },
    async disableAutoMerge(pullRequestNodeId) {
      await graphql(DISABLE_AUTO_MERGE, { id: pullRequestNodeId });
    },
  };
}
