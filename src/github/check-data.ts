import type { ActorType } from '../facts.js';

/**
 * The check, status, and check-suite shapes the GitHubClient returns and
 * accepts. Split out of client.ts; re-exported from there.
 */

/** A check-run on a commit (the latest run per name). */
export interface CheckRunData {
  name: string;
  status: string;
  conclusion: string | null;
  completedAt: string | null;
}

/** A commit status (the latest per context) — the channel some CI uses instead of checks. */
export interface CommitStatusData {
  context: string;
  state: string;
}

/** One commit status, newest first, as the statuses list reports it. */
export interface StatusData {
  context: string;
  state: string;
  description: string;
  /** Who created it; anything but a plain `User` reads as a `Bot`. */
  creatorType: ActorType;
}

/** A commit status to create. */
export interface NewCommitStatus {
  state: 'error' | 'failure' | 'pending' | 'success';
  context: string;
  description: string;
}

/** A check suite on a commit: which branch it ran for, and when it was created. */
export interface CheckSuiteData {
  /** Undefined when GitHub didn't record a branch. */
  headBranch: string | undefined;
  /** ISO-8601 creation time. */
  createdAt: string;
}
