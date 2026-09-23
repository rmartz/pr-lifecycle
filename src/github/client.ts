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
  headSha: string;
  labels: string[];
  autoMergeEnabled: boolean;
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
  /** Throws a GitHubApiError with status 404 when the user is not a collaborator. */
  getCollaboratorPermission(login: string): Promise<CollaboratorPermission>;
  listRepoLabels(): Promise<string[]>;
  /** Throws a GitHubApiError with status 422 when the label already exists. */
  createLabel(label: LabelDefinition): Promise<void>;
  addLabels(pr: number, names: readonly string[]): Promise<void>;
  /** Throws a GitHubApiError with status 404 when the label is not on the PR. */
  removeLabel(pr: number, name: string): Promise<void>;
  enableAutoMerge(pullRequestNodeId: string): Promise<void>;
  disableAutoMerge(pullRequestNodeId: string): Promise<void>;
}

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
