import type { ActorType, ReviewState } from '../facts.js';

/**
 * The narrow GitHub surface the edge layer needs, shaped around the domain rather
 * than raw REST payloads. Decisions (permission mapping, which errors are
 * tolerable, write order) live in gather.ts / execute.ts and are tested against
 * a fake of this interface; the real implementation (http-client.ts) only maps
 * requests and responses.
 */

export interface PullRequestData {
  /** GraphQL node id, needed for the auto-merge mutations. */
  nodeId: string;
  state: 'closed' | 'open';
  merged: boolean;
  draft: boolean;
  title: string;
  /** The PR description (empty when none); Dependabot reports a running rebase here. */
  body: string;
  headSha: string;
  labels: string[];
  autoMergeEnabled: boolean;
  /** The PR author's login; undefined when the account was deleted. */
  authorLogin: string | undefined;
  headRef: string;
  /** The base branch name, whose rulesets define the required checks. */
  baseRef: string;
  /** Clone URL of the base repository, used to fetch commits for carry-over checks. */
  cloneUrl: string;
  /** True when the head branch lives in a fork (or a deleted repo), not the base. */
  isCrossRepository: boolean;
  /** `false` is a merge conflict; `undefined` means GitHub is still computing it. */
  mergeable: boolean | undefined;
  /** GitHub's merge state (`clean`, `blocked`, `behind`, …); undefined while computing. */
  mergeState: string | undefined;
}

/** A check-run on a commit (the latest run per name). */
export interface CheckRunData {
  name: string;
  status: string;
  conclusion: string | null;
  completedAt: string | null;
  /** The run's output title (`null` when it has none). */
  title: string | null;
}

/** A check-run to post on a commit: still running (a hold), or passed. */
export interface CheckRunWrite {
  name: string;
  headSha: string;
  status: 'completed' | 'in_progress';
  /** Set exactly when `status` is `completed`. */
  conclusion: 'success' | undefined;
  title: string;
  summary: string;
}

/** A `labeled` event from the PR's issue events: which label, and who applied it. */
export interface LabelEventData {
  label: string;
  /** Undefined when the actor's account was deleted. */
  login: string | undefined;
  type: ActorType;
  /** ISO-8601 time the label was applied. */
  createdAt: string;
}

/** A commit status (the latest per context) — the channel some CI uses instead of checks. */
export interface CommitStatusData {
  context: string;
  state: string;
}

/** A git commit's structure: its tree and parents (for carry-over verification). */
export interface CommitObject {
  treeSha: string;
  parents: string[];
}

/** The compare API's answer: how `head` relates to `base`, and their merge base. */
export interface CommitComparison {
  /** `ahead` / `identical` mean `head` contains `base`. */
  status: string;
  mergeBaseSha: string;
}

export interface CommitData {
  /** The commit author's GitHub login; undefined when not linked to an account. */
  authorLogin: string | undefined;
  message: string;
}

export interface ReviewData {
  id: number;
  /** Undefined when the author's account was deleted (a "ghost" review). */
  login: string | undefined;
  type: ActorType;
  commitSha: string;
  state: ReviewState;
  body: string;
  /** Undefined for a pending (unsubmitted) review. */
  submittedAt: string | undefined;
}

/** The collaborator-permission API's answer: the legacy level and the role. */
export interface CollaboratorPermission {
  /** Legacy level: admin, write, read, or none (maintain → write, triage → read). */
  permission: string;
  /** Fine-grained role: admin, maintain, write, triage, read, or a custom role. */
  roleName: string;
}

export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

export interface GitHubClient {
  getPullRequest(pr: number): Promise<PullRequestData>;
  listReviews(pr: number): Promise<ReviewData[]>;
  listCommits(pr: number): Promise<CommitData[]>;
  /** The contexts the branch's rulesets require (empty when none are configured). */
  getRequiredStatusChecks(branch: string): Promise<string[]>;
  getBranchHeadSha(branch: string): Promise<string>;
  listCheckRuns(sha: string): Promise<CheckRunData[]>;
  listCommitStatuses(sha: string): Promise<CommitStatusData[]>;
  /** Needs an app token (e.g. `GITHUB_TOKEN`) with `checks: write`; a PAT gets 403. */
  createCheckRun(run: CheckRunWrite): Promise<void>;
  /** The PR's `labeled` events, oldest first. */
  listLabelEvents(pr: number): Promise<LabelEventData[]>;
  getCommit(sha: string): Promise<CommitObject>;
  compareCommits(base: string, head: string): Promise<CommitComparison>;
  /** Throws a GitHubApiError with status 404 when the user is not a collaborator. */
  getCollaboratorPermission(login: string): Promise<CollaboratorPermission>;
  listRepoLabels(): Promise<string[]>;
  /** Throws a GitHubApiError with status 422 when the label already exists. */
  createLabel(label: LabelDefinition): Promise<void>;
  addLabels(pr: number, names: readonly string[]): Promise<void>;
  /** Throws a GitHubApiError with status 404 when the label is not on the PR. */
  removeLabel(pr: number, name: string): Promise<void>;
  /** Bodies of the PR's conversation comments, oldest first. */
  listIssueComments(pr: number): Promise<string[]>;
  createIssueComment(pr: number, body: string): Promise<void>;
  /**
   * Arm squash auto-merge, bound to `expectedHeadOid`: GitHub rejects it if the
   * head has moved. Throws "…clean status" when the PR is already mergeable.
   */
  enableAutoMerge(pullRequestNodeId: string, expectedHeadOid: string): Promise<void>;
  /** Squash-merge now, bound to `expectedHeadOid` like `enableAutoMerge`. */
  mergePullRequest(pullRequestNodeId: string, expectedHeadOid: string): Promise<void>;
  disableAutoMerge(pullRequestNodeId: string): Promise<void>;
  /**
   * Merge the base into the PR branch, bound to `expectedHeadSha`. Throws a
   * GitHubApiError with status 422 when the head moved or there is nothing to merge.
   */
  updateBranch(pr: number, expectedHeadSha: string): Promise<void>;
}

/**
 * The writes that must come from a real actor: a merge or branch update made with
 * `GITHUB_TOKEN` triggers no workflows (so no release, and no CI on the new head),
 * and Dependabot only takes commands from people. Kept to these calls so the
 * release token is never used for anything else, reads included.
 */
export type ReleaseActions = Pick<
  GitHubClient,
  'createIssueComment' | 'enableAutoMerge' | 'mergePullRequest' | 'updateBranch'
>;

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export function isApiStatus(error: unknown, status: number): boolean {
  return error instanceof GitHubApiError && error.status === status;
}
