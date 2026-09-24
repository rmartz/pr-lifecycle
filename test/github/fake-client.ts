import type {
  CollaboratorPermission,
  CheckRunData,
  CommitData,
  CommitStatusData,
  GitHubClient,
  LabelDefinition,
  PullRequestData,
  ReviewData,
} from '../../src/github/client.js';
import { GitHubApiError } from '../../src/github/client.js';
import { HEAD_SHA } from '../fixtures.js';

/**
 * An in-memory GitHub for edge-layer tests: it holds real state, mutates it on
 * writes (so gather → execute → gather round-trips), and records every call in
 * order. Failures are injected per method via `failNext`.
 */

export type FakeCall = { method: keyof GitHubClient; args: unknown[] };

export function makePullRequestData(overrides: Partial<PullRequestData> = {}): PullRequestData {
  return {
    nodeId: 'PR_node',
    state: 'open',
    merged: false,
    draft: false,
    title: 'feat: add a thing',
    headSha: HEAD_SHA,
    labels: [],
    autoMergeEnabled: false,
    authorLogin: 'contributor',
    headRef: 'feature/thing',
    baseRef: 'main',
    isCrossRepository: false,
    mergeable: true,
    ...overrides,
  };
}

export function makeReviewData(overrides: Partial<ReviewData> = {}): ReviewData {
  return {
    id: 1,
    login: 'maintainer',
    type: 'User',
    commitSha: HEAD_SHA,
    state: 'COMMENTED',
    body: '',
    submittedAt: '2026-09-23T12:00:00Z',
    ...overrides,
  };
}

export class FakeGitHubClient implements GitHubClient {
  pull: PullRequestData;
  reviews: ReviewData[];
  commits: CommitData[] = [];
  /** Required contexts per branch (none by default: the CI gate is inactive). */
  requiredChecks = new Map<string, string[]>();
  branchHeads = new Map<string, string>();
  checkRuns = new Map<string, CheckRunData[]>();
  commitStatuses = new Map<string, CommitStatusData[]>();
  /** Collaborators by login; an absent login is a non-collaborator (404). */
  permissions = new Map<string, CollaboratorPermission>();
  repoLabels = new Map<string, LabelDefinition>();
  readonly calls: FakeCall[] = [];
  private readonly failures = new Map<keyof GitHubClient, Error>();

  constructor(pull: PullRequestData = makePullRequestData(), reviews: ReviewData[] = []) {
    this.pull = pull;
    this.reviews = reviews;
  }

  failNext(method: keyof GitHubClient, error: Error): void {
    this.failures.set(method, error);
  }

  get writes(): FakeCall[] {
    const reads = new Set<keyof GitHubClient>([
      'getPullRequest',
      'listReviews',
      'listCommits',
      'getRequiredStatusChecks',
      'getBranchHeadSha',
      'listCheckRuns',
      'listCommitStatuses',
      'getCollaboratorPermission',
      'listRepoLabels',
    ]);
    return this.calls.filter((call) => !reads.has(call.method));
  }

  private record(method: keyof GitHubClient, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.failures.get(method);
    if (failure !== undefined) {
      this.failures.delete(method);
      throw failure;
    }
  }

  getPullRequest(pr: number): Promise<PullRequestData> {
    this.record('getPullRequest', pr);
    return Promise.resolve({ ...this.pull, labels: [...this.pull.labels] });
  }

  getRequiredStatusChecks(branch: string): Promise<string[]> {
    this.record('getRequiredStatusChecks', branch);
    return Promise.resolve([...(this.requiredChecks.get(branch) ?? [])]);
  }

  getBranchHeadSha(branch: string): Promise<string> {
    this.record('getBranchHeadSha', branch);
    return Promise.resolve(this.branchHeads.get(branch) ?? 'f'.repeat(40));
  }

  listCheckRuns(sha: string): Promise<CheckRunData[]> {
    this.record('listCheckRuns', sha);
    return Promise.resolve([...(this.checkRuns.get(sha) ?? [])]);
  }

  listCommitStatuses(sha: string): Promise<CommitStatusData[]> {
    this.record('listCommitStatuses', sha);
    return Promise.resolve([...(this.commitStatuses.get(sha) ?? [])]);
  }

  listCommits(pr: number): Promise<CommitData[]> {
    this.record('listCommits', pr);
    return Promise.resolve([...this.commits]);
  }

  listReviews(pr: number): Promise<ReviewData[]> {
    this.record('listReviews', pr);
    return Promise.resolve([...this.reviews]);
  }

  getCollaboratorPermission(login: string): Promise<CollaboratorPermission> {
    this.record('getCollaboratorPermission', login);
    const permission = this.permissions.get(login);
    if (permission === undefined) {
      return Promise.reject(new GitHubApiError(404, `${login} is not a collaborator`));
    }
    return Promise.resolve(permission);
  }

  listRepoLabels(): Promise<string[]> {
    this.record('listRepoLabels');
    return Promise.resolve([...this.repoLabels.keys()]);
  }

  createLabel(label: LabelDefinition): Promise<void> {
    this.record('createLabel', label);
    this.repoLabels.set(label.name, label);
    return Promise.resolve();
  }

  addLabels(pr: number, names: readonly string[]): Promise<void> {
    this.record('addLabels', pr, [...names]);
    this.pull.labels = [...new Set([...this.pull.labels, ...names])];
    return Promise.resolve();
  }

  removeLabel(pr: number, name: string): Promise<void> {
    this.record('removeLabel', pr, name);
    if (!this.pull.labels.includes(name)) {
      return Promise.reject(new GitHubApiError(404, `${name} is not on the PR`));
    }
    this.pull.labels = this.pull.labels.filter((label) => label !== name);
    return Promise.resolve();
  }

  enableAutoMerge(nodeId: string): Promise<void> {
    this.record('enableAutoMerge', nodeId);
    this.pull.autoMergeEnabled = true;
    return Promise.resolve();
  }

  disableAutoMerge(nodeId: string): Promise<void> {
    this.record('disableAutoMerge', nodeId);
    this.pull.autoMergeEnabled = false;
    return Promise.resolve();
  }
}
