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

// The hyphenated verdict names are the canonical marker outcomes. The legacy
// spellings older /review markers carry (`changes requested`, and `blocked` for
// the verdict that applies `escalation needed`) are still read.
const LEGACY_MARKER_OUTCOMES: Readonly<Record<string, Verdict>> = {
  'changes requested': 'changes-requested',
  blocked: 'escalation-needed',
};

// A /review pass that deliberately did nothing: not a verdict.
const SKIPPED_OUTCOME = 'skipped';

/**
 * The verdict a /review marker's outcome expresses, or undefined for `skipped`.
 * Any other outcome, including a missing or non-string one, fails closed to
 * `escalation-needed`: a /review verdict that can't be read must never let an
 * earlier approval stand, so a human looks at it.
 */
function markerVerdict(outcome: unknown): Verdict | undefined {
  if (outcome === SKIPPED_OUTCOME) {
    return undefined;
  }
  if (typeof outcome !== 'string') {
    return 'escalation-needed';
  }
  const canonical = VERDICTS.find((verdict) => verdict === outcome);
  if (canonical !== undefined) {
    return canonical;
  }
  return Object.hasOwn(LEGACY_MARKER_OUTCOMES, outcome)
    ? LEGACY_MARKER_OUTCOMES[outcome]
    : 'escalation-needed';
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
export function parseVerdict(review: Pick<ReviewFact, 'body' | 'state'>): ParsedVerdict | undefined {
  // A dismissed review was revoked by a maintainer, and a pending one was never
  // submitted: neither is a verdict, whatever its body's marker says.
  if (review.state === 'DISMISSED' || review.state === 'PENDING') {
    return undefined;
  }
  const meta = readSkillMeta(review.body);
  if (meta?.skill === 'review') {
    // A /review marker is authoritative, including `skipped` (not a verdict)
    // and an unreadable outcome (escalation).
    const verdict = markerVerdict(meta.outcome);
    if (verdict === undefined) {
      return undefined;
    }
    return {
      verdict,
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

/**
 * The commits whose reviews count for the head: the head itself, plus every
 * commit whose only changes since are verified clean base merges. A clean base
 * merge leaves the PR's diff unchanged, so a review of the earlier commit still
 * describes the change being merged.
 */
function countingCommits(facts: PullRequestFacts): ReadonlySet<string> {
  return new Set([facts.headSha, ...facts.cleanAncestors]);
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
    (removal) =>
      isTrustedAuthor(removal.actor, policy) && Date.parse(removal.removedAt) > postedAt,
  );
}

/**
 * The latest verdict that counts for the PR's current head, if any. An escalation
 * a trusted person resolved by removing its label leaves no verdict: the PR goes
 * back through review, and the approvals it superseded stay superseded.
 */
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
  if (
    latest?.verdict === 'escalation-needed' &&
    isEscalationResolved(latest.review, facts, policy)
  ) {
    return undefined;
  }
  return latest?.verdict;
}
