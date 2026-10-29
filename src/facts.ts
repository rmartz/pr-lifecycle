/**
 * The facts the reconciler core computes a PR's lifecycle state from. The edge
 * layer gathers these from GitHub; the core never performs I/O. See
 * docs/reconciler-design.md §Facts.
 */

import type { CiStatus } from './ci.js';
import type { FileChange, SignOffStatusFact, UatSignOffFact } from './sign-off-facts.js';

export { SIGN_OFF_STATUS_VERSIONS, UAT_SETTINGS } from './policy.js';
export type { ReconcilePolicy, SignOffStatusVersion, UatSetting } from './policy.js';

export {
  CI_CHANGE_APPROVED_LABEL,
  SIGN_OFF_LABELS,
  UAT_SIGN_OFF_LABELS,
} from './sign-off-facts.js';
export type {
  FileChange,
  SignOffStatusFact,
  SignOffLabel,
  UatSignOffFact,
  UatSignOffLabel,
} from './sign-off-facts.js';

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

/**
 * Who brings a PR's branch up to date with its base. Dependabot owns its branches
 * and rebases them itself (on its own, or when a person asks), so the reconciler
 * never updates them; anything else uses GitHub's update-branch.
 */
export const BRANCH_UPDATERS = ['dependabot', 'github'] as const;
export type BranchUpdater = (typeof BRANCH_UPDATERS)[number];
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

/** A force-push to the PR's branch, from its timeline. */
export interface ForcePushFact {
  /** The commit the push made the head; undefined when GitHub didn't say (fails closed). */
  headSha: string | undefined;
  /**
   * The head the push replaced; undefined when GitHub didn't say (fails closed).
   * Only UAT sign-off binding reads it (see src/uat-binding.ts).
   */
  beforeSha?: string | undefined;
  /** ISO-8601 time of the push. */
  pushedAt: string;
}

/** Someone removing the `escalation needed` label from the PR. */
export interface LabelRemovalFact {
  /** Who removed it, with their permission fetched at the edge (as for review authors). */
  actor: ReviewAuthor;
  /** ISO-8601 time of the removal. */
  removedAt: string;
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
  /**
   * Whether GitHub would merge the PR right now, with nothing left to wait on
   * (merge state `clean`, `has_hooks`, or `unstable`). Auto-merge can't be armed
   * then, so an approved PR is merged directly instead, as `gh pr merge --auto` does.
   */
  immediatelyMergeable: boolean;
  /** The CI gate over the head's required checks (see src/ci.ts). */
  ciStatus: CiStatus;
  /** Whether the same required checks are failing on the base branch head. */
  baseCiFailing: boolean;
  /**
   * Earlier commits whose verdicts carry over to the head: every commit reached
   * from the head through a chain of verified clean base merges (see
   * docs/approval-carry-over.md). Verified at the edge.
   */
  cleanAncestors: readonly string[];
  /**
   * Reviewed commits no longer in the branch's history whose verdicts carry over
   * to the head, because the head is their verified clean rebase onto the base
   * (see docs/approval-carry-over.md §Rebased heads). Verified at the edge; absent
   * means none.
   */
  cleanRebaseSources?: readonly string[];
  /** Who updates the branch (see `BranchUpdater`). */
  updater: BranchUpdater;
  /**
   * For a Dependabot PR: the PR body says Dependabot is rebasing or recreating the
   * branch right now (a person asked, or Dependabot rebased on its own). Only
   * Dependabot's notice counts, which it removes when done. Drives the
   * `dependabot rebasing` label. Always `false` for other PRs.
   */
  dependabotRebasing: boolean;
  /**
   * For a same-repo Dependabot PR: it is a security update, read from its commits'
   * metadata (see `isDependabotSecurityUpdate`). Drives the `security update`
   * label. Absent means not one.
   */
  securityUpdate?: boolean;
  reviews: readonly ReviewFact[];
  /**
   * Every force-push to the PR's branch. GitHub moves an approval's `commit_id`
   * onto the new head when a force-push leaves the PR's diff unchanged, so a
   * review submitted before the push that produced its commit never saw that
   * commit (see `currentVerdict`). Gathered only when some review is a verdict,
   * so empty otherwise.
   */
  forcePushes: readonly ForcePushFact[];
  /**
   * Every removal of the `escalation needed` label, by anyone. A trusted person
   * removing it after an escalation verdict resolves that escalation (see
   * `currentVerdict`). Gathered only when a review is an escalation verdict, so
   * empty otherwise.
   */
  escalationRemovals: readonly LabelRemovalFact[];
  /**
   * Logins of the bots (e.g. Copilot) whose review is requested and not yet
   * submitted. Users and teams are left out: the lifecycle never waits on people.
   */
  pendingBotReviewers: readonly string[];
  /**
   * Every path the PR touches, a rename's old path included, for the CI
   * classification. Absent when not gathered or when the listing was incomplete:
   * then the PR isn't a CI change, and counts as a loosening (fails closed).
   * Gathered whenever sign-offs are reconciled on an open PR.
   */
  changedPaths?: readonly string[];
  /** Base (merge base) and head text of each changed `package.json`, for the CI classification's path rules. */
  manifestChanges?: readonly FileChange[];
  /**
   * The latest application of each UAT sign-off label present on the PR.
   * Gathered only when UAT is on and one is present; absent means none.
   */
  uatSignOffs?: readonly UatSignOffFact[];
  /**
   * Every application of `UAT passed`, by anyone, oldest first, whether or not
   * the label is still on the PR. Read only when a review records
   * `uat: unchanged`, to find the person's pass it attests (docs/uat.md rule 5).
   */
  uatPassedHistory?: readonly UatSignOffFact[];
  /**
   * When each commit a sign-off could be bound to (the head, the commits
   * carry-over verified, and, with `uatPassedHistory`, every commit on the PR and
   * each `uat_since`) first had a check suite on the PR's branch (ISO-8601).
   * With the force-pushes, this is when a commit became the head: a time the
   * author can't forge, unlike a commit date. A commit with no entry has no known
   * arrival, so no sign-off binds to it.
   */
  commitArrivals?: Readonly<Record<string, string>>;
  /**
   * Merge-base and head text of each changed `.github/workflows/**` file, for
   * the CI loosening rules. A changed workflow with no entry counts as a
   * loosening (src/sign-off.ts).
   */
  workflowChanges?: readonly FileChange[];
  /**
   * The latest `pr-lifecycle/sign-off` status on the head, if any, so an
   * unchanged one isn't posted again.
   */
  signOffStatus?: SignOffStatusFact;
}
