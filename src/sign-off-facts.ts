import type { ActorType, ReviewAuthor } from './facts.js';

/**
 * The facts behind a PR's sign-off classification and its UAT labels: changed
 * file text, who applied a UAT sign-off, and the sign-off status already on the
 * head. Split out of facts.ts; re-exported from there.
 */

/**
 * A changed file's text on each side, for rules that judge a file by content.
 * An absent side means the PR added (no `baseText`) or deleted (no `headText`)
 * the file, or that it couldn't be read.
 */
export interface FileChange {
  path: string;
  baseText?: string | undefined;
  headText?: string | undefined;
}

/** The UAT labels a person (or the review agent) applies as a sign-off. */
export const UAT_SIGN_OFF_LABELS = ['no UAT needed', 'UAT passed'] as const;
export type UatSignOffLabel = (typeof UAT_SIGN_OFF_LABELS)[number];

/** A person's sign-off on a CI loosening. Read, never written. */
export const CI_CHANGE_APPROVED_LABEL = 'CI change approved';

/** Every sign-off label whose applier is read: the UAT ones and the CI one. */
export const SIGN_OFF_LABELS = [...UAT_SIGN_OFF_LABELS, CI_CHANGE_APPROVED_LABEL] as const;
export type SignOffLabel = (typeof SIGN_OFF_LABELS)[number];

/** The latest application of a sign-off label, from the PR's issue events. */
export interface UatSignOffFact {
  label: SignOffLabel;
  /** Who applied it, with their permission fetched at the edge (as for review authors). */
  actor: ReviewAuthor;
  /** ISO-8601 time it was applied. */
  appliedAt: string;
}

/** A commit status already on the head, as the statuses API lists it. */
export interface SignOffStatusFact {
  state: string;
  description: string;
  /** Who posted it; pr-policy trusts only a `User`. */
  creatorType: ActorType;
}
