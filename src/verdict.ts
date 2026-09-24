import type { PullRequestFacts, ReconcilePolicy, ReviewAuthor, ReviewFact } from './facts.js';

/**
 * Verdict parsing and trust. A review is a verdict when it carries a /review
 * `skill-meta` marker with a verdict outcome, or (with no marker) a native
 * APPROVED / CHANGES_REQUESTED state. It *counts* only from a trusted author and
 * only when bound to the current head. See docs/reconciler-design.md §Verdicts.
 */

export const VERDICTS = ['approved', 'changes-requested', 'escalation-needed'] as const;
export type Verdict = (typeof VERDICTS)[number];

const TRUSTED_PERMISSIONS: ReadonlySet<ReviewAuthor['permission']> = new Set([
  'admin',
  'maintain',
  'write',
]);

// Review bodies are attacker-controlled (anyone can comment), so the marker is
// located with a linear scan: this pattern matches only the marker opening (no
// overlapping quantifiers), and the payload runs to the next `-->` via indexOf.
// A single `<!--\s*skill-meta:\s*(.*?)\s*-->` regex backtracks cubically on an
// unterminated marker padded with whitespace (CodeQL js/polynomial-redos).
const SKILL_META_OPENING = /<!--\s*skill-meta:/;
const COMMENT_CLOSE = '-->';

interface SkillMeta {
  skill?: unknown;
  outcome?: unknown;
  pr_head?: unknown;
}

export interface ParsedVerdict {
  verdict: Verdict;
  /** The head SHA the marker says was reviewed, when the marker names one. */
  markerHead: string | undefined;
}

function isVerdict(value: unknown): value is Verdict {
  return VERDICTS.some((verdict) => verdict === value);
}

function readSkillMeta(body: string): SkillMeta | undefined {
  const opening = SKILL_META_OPENING.exec(body);
  if (opening === null) {
    return undefined;
  }
  const payloadStart = opening.index + opening[0].length;
  const payloadEnd = body.indexOf(COMMENT_CLOSE, payloadStart);
  if (payloadEnd === -1) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body.slice(payloadStart, payloadEnd).trim());
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The verdict a review expresses, or undefined when it is not a verdict. */
export function parseVerdict(review: ReviewFact): ParsedVerdict | undefined {
  // A dismissed review was revoked by a maintainer, and a pending one was never
  // submitted: neither is a verdict, whatever its body's marker says.
  if (review.state === 'DISMISSED' || review.state === 'PENDING') {
    return undefined;
  }
  const meta = readSkillMeta(review.body);
  if (meta?.skill === 'review') {
    // A /review marker is authoritative, including `skipped` (not a verdict).
    if (!isVerdict(meta.outcome)) {
      return undefined;
    }
    return {
      verdict: meta.outcome,
      markerHead: typeof meta.pr_head === 'string' ? meta.pr_head : undefined,
    };
  }
  switch (review.state) {
    case 'APPROVED':
      return { verdict: 'approved', markerHead: undefined };
    case 'CHANGES_REQUESTED':
      return { verdict: 'changes-requested', markerHead: undefined };
    case 'COMMENTED':
      return undefined;
  }
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

/** The latest verdict that counts for the PR's current head, if any. */
/**
 * The commits whose reviews count for the head: the head itself, plus every
 * commit whose only changes since are verified clean base merges. A clean base
 * merge leaves the PR's diff unchanged, so a review of the earlier commit still
 * describes the change being merged. Shared by verdicts and the Copilot gate.
 */
export function countingCommits(facts: PullRequestFacts): ReadonlySet<string> {
  return new Set([facts.headSha, ...facts.cleanAncestors]);
}

export function currentVerdict(
  facts: PullRequestFacts,
  policy: ReconcilePolicy,
): Verdict | undefined {
  const countingShas = countingCommits(facts);
  let latest: { review: ReviewFact; verdict: Verdict } | undefined;
  for (const review of facts.reviews) {
    const parsed = parseVerdict(review);
    const counts =
      parsed !== undefined &&
      isTrustedAuthor(review.author, policy) &&
      countingShas.has(review.commitSha) &&
      // The marker, when present, must name the same commit the review is bound to.
      (parsed.markerHead === undefined || parsed.markerHead === review.commitSha);
    if (counts && (latest === undefined || compareSubmission(review, latest.review) > 0)) {
      latest = { review, verdict: parsed.verdict };
    }
  }
  return latest?.verdict;
}
