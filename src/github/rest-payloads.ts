import type { ActorType, ReviewState } from '../facts.js';
import { REVIEW_STATES } from '../facts.js';
import type { ReviewData } from './client.js';

/**
 * The REST payload shapes http-client.ts reads, and the pure mappers from them to
 * the client's domain types. Split out of http-client.ts so it stays a thin
 * request/response layer.
 */

// Minimal shapes of the REST payloads we read. Fields are optional/unknown
// where GitHub can omit or null them.
export interface RestPull {
  node_id: string;
  state: 'closed' | 'open';
  merged: boolean;
  draft?: boolean;
  title: string;
  body: string | null;
  user: { login: string } | null;
  /** `head.repo` is null when the fork was deleted. */
  head: { sha: string; ref: string; repo: { id: number } | null };
  base: { ref: string; repo: { id: number; clone_url: string } };
  labels: { name: string }[];
  auto_merge: unknown;
  /** `null` while GitHub computes mergeability in the background. */
  mergeable: boolean | null;
  /** Lowercase merge state, e.g. `clean`, `blocked`, `behind`, `unknown`. */
  mergeable_state?: string;
  changed_files: number;
}

export interface RestPullFile {
  filename: string;
  status: string;
  /** Omitted for binary files and very large diffs. */
  patch?: string;
}

export interface RestCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
}

export interface RestRule {
  type: string;
  parameters?: { required_status_checks?: { context: string }[] };
}

export interface RestCommit {
  author: { login: string } | null;
  commit: { message: string };
}

export interface RestReview {
  id: number;
  user: { login: string; type: string } | null;
  commit_id: string;
  state: string;
  body: string | null;
  submitted_at?: string | null;
}

/** An unrecognized review state must never count as a verdict. */
export function toReviewState(state: string): ReviewState {
  return REVIEW_STATES.find((known) => known === state) ?? 'DISMISSED';
}

/** Anything that isn't plainly a User (e.g. an Organization) is untrusted. */
export function toActorType(type: string): ActorType {
  return type === 'User' ? 'User' : 'Bot';
}

export function toReviewData(review: RestReview): ReviewData {
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
