import type {
  CollaboratorPermission,
  CommitData,
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
    isCrossRepository: false,
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
