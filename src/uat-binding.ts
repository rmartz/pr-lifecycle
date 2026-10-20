import type { PullRequestFacts, UatSignOffFact } from './facts.js';

/**
 * Head binding for UAT sign-off labels. A label records no commit, unlike a
 * review, so "applied to this head" is a comparison of times: when the label was
 * applied against when the head arrived. A commit's arrival is the latest
 * force-push that made it the head, or else the first check suite on the PR's
 * branch for it. Both are times GitHub records and the author can't forge;
 * commit dates are never used. See docs/uat.md §Sign-offs are bound to the head.
 *
 * Every comparison is strict and fails closed: an unreadable time, an unknown
 * arrival, or a force-push GitHub didn't name a commit for never binds a label.
 */

function time(iso: string | undefined): number {
  return iso === undefined ? Number.NaN : Date.parse(iso);
}

/**
 * When `sha` last became the head, or NaN when unknown. A force-push GitHub
 * didn't attribute could have made any commit the head, so `head` counts those
 * too; an earlier commit doesn't need to (see `boundToCarried`).
 */
function arrivalOf(sha: string, facts: PullRequestFacts, isHead: boolean): number {
  const pushes = facts.forcePushes
    .filter((push) => push.headSha === sha || (isHead && push.headSha === undefined))
    .map((push) => time(push.pushedAt));
  const firstSuite = time(facts.commitArrivals?.[sha]);
  const known = [...pushes, firstSuite].filter((value) => !Number.isNaN(value));
  // Every attributed push must be readable, or the latest arrival can't be known.
  if (pushes.some((value) => Number.isNaN(value)) || known.length === 0) {
    return Number.NaN;
  }
  return Math.max(...known);
}

/**
 * Whether the label was applied while `sha`, a commit carry-over verified, was
 * the head. Between `sha` arriving and the first force-push after it, the branch
 * only moved forward from `sha`:
 *
 * - With no force-push since, every later head is a clean base merge on the
 *   chain back to `sha` (that is what makes `sha` a clean ancestor), so the
 *   label described the same change.
 * - Otherwise the label counts only when that force-push replaced `sha` itself:
 *   then nothing else was the head in between. A push that replaced some other
 *   commit, or didn't say what it replaced, means an ordinary push came first,
 *   and the label may have been for that.
 */
function boundToCarried(applied: number, sha: string, facts: PullRequestFacts): boolean {
  const arrived = arrivalOf(sha, facts, false);
  const pushTimes = facts.forcePushes.map((push) => time(push.pushedAt));
  if (!(applied > arrived) || pushTimes.some((value) => Number.isNaN(value))) {
    return false;
  }
  const next = facts.forcePushes
    .filter((push) => time(push.pushedAt) > arrived)
    .toSorted((a, b) => time(a.pushedAt) - time(b.pushedAt))[0];
  if (next === undefined) {
    return true;
  }
  return applied < time(next.pushedAt) && next.beforeSha === sha;
}

/**
 * Whether a sign-off was applied to the PR's current head, or (when `carried`
 * is given) to an earlier commit whose reviews carry over to it.
 */
export function isSignOffCurrent(
  signOff: UatSignOffFact,
  facts: PullRequestFacts,
  carried: ReadonlySet<string> = new Set(),
): boolean {
  const applied = time(signOff.appliedAt);
  if (Number.isNaN(applied)) {
    return false;
  }
  if (applied > arrivalOf(facts.headSha, facts, true)) {
    return true;
  }
  return [...carried].some((sha) => sha !== facts.headSha && boundToCarried(applied, sha, facts));
}

/** Whether the PR's title changed after the sign-off was applied. */
export function isRetitledSince(signOff: UatSignOffFact, facts: PullRequestFacts): boolean {
  const applied = time(signOff.appliedAt);
  return (facts.titleChanges ?? []).some((changed) => !(time(changed) < applied));
}
