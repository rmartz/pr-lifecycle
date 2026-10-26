import type { PullRequestFacts, ReconcilePolicy, ReviewAuthor, ReviewFact } from './facts.js';
import { carriedCommits, isBoundToHead } from './head-binding.js';
import type { UatVerdict, Verdict, VerdictRecord } from './verdict-marker.js';
import { parseVerdictRecord } from './verdict-marker.js';

/**
 * Verdict trust and resolution. A verdict *counts* only from a trusted author and
 * only when bound to the current head, and each dimension (code, UAT) is resolved
 * on its own: the latest counting review that records it decides it. Parsing is
 * in verdict-marker.ts. See docs/verdicts.md.
 */

const TRUSTED_PERMISSIONS: ReadonlySet<ReviewAuthor['permission']> = new Set([
  'admin',
  'maintain',
  'write',
]);

export interface ParsedVerdict {
  verdict: Verdict;
  /** The head SHA the marker says was reviewed, when the marker names one. */
  markerHead: string | undefined;
}

/** The code verdict a review expresses, or undefined when it records none. */
export function parseVerdict(
  review: Pick<ReviewFact, 'body' | 'state'>,
): ParsedVerdict | undefined {
  const record = parseVerdictRecord(review);
  return record?.code === undefined
    ? undefined
    : { verdict: record.code, markerHead: record.markerHead };
}

/** Whether an author may cast a counting verdict under the policy. */
export function isTrustedAuthor(author: ReviewAuthor, policy: ReconcilePolicy): boolean {
  if (author.type !== 'User' || !TRUSTED_PERMISSIONS.has(author.permission)) {
    return false;
  }
  if (policy.trustedAuthors === undefined) {
    return true;
  }
  const login = author.login.toLowerCase();
  return policy.trustedAuthors.some((trusted) => trusted.toLowerCase() === login);
}

function compareSubmission(a: ReviewFact, b: ReviewFact): number {
  return Date.parse(a.submittedAt) - Date.parse(b.submittedAt) || a.id - b.id;
}

/**
 * The latest counting review that records a dimension, and its value. A review
 * that leaves the dimension out doesn't supersede an earlier one that records it.
 */
function latestCounting<T>(
  facts: PullRequestFacts,
  policy: ReconcilePolicy,
  dimension: (record: VerdictRecord) => T | undefined,
): { review: ReviewFact; value: T } | undefined {
  const carried = carriedCommits(facts);
  let latest: { review: ReviewFact; value: T } | undefined;
  for (const review of facts.reviews) {
    const record = parseVerdictRecord(review);
    const value = record === undefined ? undefined : dimension(record);
    const counts =
      record !== undefined &&
      value !== undefined &&
      isTrustedAuthor(review.author, policy) &&
      isBoundToHead(review, record.markerHead, facts, carried);
    if (counts && (latest === undefined || compareSubmission(review, latest.review) > 0)) {
      latest = { review, value };
    }
  }
  return latest;
}

/**
 * Whether a trusted person removed `escalation needed` after this escalation was
 * posted. That removal is how people resolve an escalation (they don't post
 * verdicts), so it must outlast the verdict that applied the label. A removal in
 * the same instant as the post doesn't count: post-review-verdict.py may clear a
 * stale label while posting a fresh escalation.
 */
function isEscalationResolved(
  escalation: ReviewFact,
  facts: PullRequestFacts,
  policy: ReconcilePolicy,
): boolean {
  const postedAt = Date.parse(escalation.submittedAt);
  return facts.escalationRemovals.some(
    (removal) => isTrustedAuthor(removal.actor, policy) && Date.parse(removal.removedAt) > postedAt,
  );
}

/**
 * The latest code verdict that counts for the PR's current head, if any. An
 * escalation a trusted person resolved by removing its label leaves no verdict:
 * the PR goes back through review, and the approvals it superseded stay
 * superseded.
 */
export function currentVerdict(
  facts: PullRequestFacts,
  policy: ReconcilePolicy,
): Verdict | undefined {
  const latest = latestCounting(facts, policy, (record) => record.code);
  if (latest?.value === 'escalation-needed' && isEscalationResolved(latest.review, facts, policy)) {
    return undefined;
  }
  return latest?.value;
}

/**
 * The latest UAT decision that counts for the PR's current head, if any, by the
 * same trust and head-binding rules as the code verdict. Resolved independently
 * of it: a later review that records only a code verdict leaves it in force.
 */
export function currentUatVerdict(
  facts: PullRequestFacts,
  policy: ReconcilePolicy,
): UatVerdict | undefined {
  return latestCounting(facts, policy, (record) => record.uat)?.value;
}
