import type { PullRequestFacts, ReviewFact } from './facts.js';

/**
 * Head binding: which commit a verdict reviewed, and whether that commit still
 * counts for the PR's current head. See docs/verdicts.md §When a verdict counts
 * (rule 2) and docs/approval-carry-over.md.
 */

/**
 * The earlier commits whose reviews carry over to the head: every commit whose
 * only changes since are verified clean base merges, and every reviewed commit
 * the head is a verified clean rebase of. Either way the PR's diff is unchanged,
 * so a review of the earlier commit still describes the change being merged.
 */
export function carriedCommits(facts: PullRequestFacts): ReadonlySet<string> {
  return new Set([...facts.cleanAncestors, ...(facts.cleanRebaseSources ?? [])]);
}

/**
 * Whether GitHub may have moved the review onto its commit after it was
 * submitted. A force-push that leaves the PR's diff unchanged (a clean rebase)
 * rewrites an approval's `commit_id` to the new head, so the review reads as bound
 * to a commit its author never saw, and its `commit_id` alone can't be trusted.
 * Any force-push to the review's commit at or after the review was submitted
 * means it was rebound. Fails closed: an unreadable time, or a push GitHub didn't
 * name the commit of, counts as rebinding.
 */
function isReboundByForcePush(review: ReviewFact, facts: PullRequestFacts): boolean {
  const submittedAt = Date.parse(review.submittedAt);
  return facts.forcePushes.some(
    (push) =>
      (push.headSha === undefined || push.headSha === review.commitSha) &&
      !(Date.parse(push.pushedAt) < submittedAt),
  );
}

/**
 * Whether a verdict is bound to a commit that counts for the head. The commit it
 * reviewed is its marker's `pr_head` when it names one, else its `commit_id`, and
 * that must be the head or a carried commit. A marker naming a different commit
 * than `commit_id` is honored only for a carried commit: GitHub re-points an old
 * review's `commit_id` at the new head after a force-push, so the marker is what
 * still names the commit actually reviewed. A marker can never claim the head
 * for a review GitHub bound to some other commit.
 *
 * A review GitHub moved by a force-push has no trustworthy `commit_id` at all, so
 * it counts only through its marker, and only when the marker names a verified
 * carried commit (a clean rebase source): never the head, and never without a
 * marker.
 */
export function isBoundToHead(
  review: ReviewFact,
  markerHead: string | undefined,
  facts: PullRequestFacts,
  carried: ReadonlySet<string>,
): boolean {
  if (isReboundByForcePush(review, facts)) {
    return markerHead !== undefined && carried.has(markerHead);
  }
  const reviewed = markerHead ?? review.commitSha;
  if (reviewed !== facts.headSha && !carried.has(reviewed)) {
    return false;
  }
  return markerHead === undefined || markerHead === review.commitSha || carried.has(markerHead);
}
