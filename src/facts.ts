/**
 * The facts the reconciler core computes a PR's lifecycle state from. The edge
 * layer gathers these from GitHub; the core never performs I/O. See
 * docs/reconciler-design.md §Facts.
 */

import type { CiStatus } from './ci.js';

export const REPO_PERMISSIONS = ['admin', 'maintain', 'none', 'read', 'triage', 'write'] as const;
export type RepoPermission = (typeof REPO_PERMISSIONS)[number];

export const ACTOR_TYPES = ['Bot', 'User'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** GitHub's native review states, as returned by the REST reviews API. */
export const REVIEW_STATES = [
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const PR_STATUSES = ['closed', 'merged', 'open'] as const;
export type PullRequestStatus = (typeof PR_STATUSES)[number];

export interface ReviewAuthor {
  login: string;
  type: ActorType;
  /** The author's permission on the repository, fetched at the edge. */
  permission: RepoPermission;
}

export interface ReviewFact {
  id: number;
  author: ReviewAuthor;
  /** The commit GitHub bound the review to (REST `commit_id`). */
  commitSha: string;
  state: ReviewState;
  body: string;
  /** ISO-8601 submission time. */
  submittedAt: string;
}

export interface PullRequestFacts {
  status: PullRequestStatus;
  isDraft: boolean;
  title: string;
  headSha: string;
  labels: readonly string[];
  autoMergeEnabled: boolean;
  /** Result of the bot-PR eligibility predicate (Dependabot patch/minor, release-please). */
  botEligible: boolean;
  /**
   * Whether the PR merges cleanly into its base: `false` is a merge conflict, and
   * `undefined` means GitHub hasn't computed it yet (never treated as a conflict).
   */
  mergeable: boolean | undefined;
  /** The CI gate over the head's required checks (see src/ci.ts). */
  ciStatus: CiStatus;
  /** Whether the same required checks are failing on the base branch head. */
  baseCiFailing: boolean;
  reviews: readonly ReviewFact[];
}

export interface ReconcilePolicy {
  /**
   * When set, only these logins (case-insensitive) may author a counting verdict,
   * in addition to the write-permission requirement. It narrows trust and never
   * widens it.
   */
  trustedAuthors?: readonly string[];
  /** Arm/disarm native auto-merge from the lifecycle state. Off by default. */
  armAutoMerge?: boolean;
  /**
   * Don't wait for a Copilot review before `review-requested`, for repos without
   * Copilot code review (where the wait would never end). Off by default.
   */
  skipCopilotReview?: boolean;
  /**
   * Required checks whose *pending* is a hold on a human act, not a running build;
   * their failures still count. Defaults to `DEFAULT_HOLD_CHECKS` (src/ci.ts).
   */
  holdChecks?: readonly string[];
  /** Required checks the CI gate never counts. Defaults to `DEFAULT_IGNORED_CHECKS`. */
  ignoredChecks?: readonly string[];
}
