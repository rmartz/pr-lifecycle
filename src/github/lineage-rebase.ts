import type { ProseMatcher } from '../lineage/prose.js';
import { proseOverlapReason } from '../lineage/prose.js';
import type { MergeVerifier } from '../lineage/verify.js';
import { isObjectId } from '../object-id.js';
import type { GitHubClient } from './client.js';

/**
 * Verifies that the PR head is a **clean rebase** of a reviewed commit that is no
 * longer in the branch's history (a force-push, typically `@dependabot rebase`).
 * The head's tree must be byte-identical to what git's automatic three-way merge
 * produces when the reviewed commit's change is replayed onto the head's newer
 * base: the same content a clean update-branch merge would have produced, which
 * already carries an approval (docs/approval-carry-over.md §Rebased heads). Every
 * doubt returns a reason, never a carry-over.
 */

type RebaseClient = Pick<GitHubClient, 'compareCommits' | 'getCommit'>;

export interface RebaseInput {
  /** The reviewed commit, no longer an ancestor of the head. */
  source: string;
  headSha: string;
  /** The base branch's current head: both merge bases are taken against it. */
  baseHeadSha: string;
}

export interface RebaseCheck {
  source: string;
  /** Whether the source's reviews carry over to the head. */
  carried: boolean;
  /** Why it did or didn't, for reporting. */
  reason: string;
}

const CARRIED = 'the head is its clean rebase onto the base';

/**
 * The check for one reviewed commit, or undefined when it doesn't apply because
 * the commit is still in the head's history.
 */
export async function checkCleanRebase(
  client: RebaseClient,
  verifier: MergeVerifier,
  input: RebaseInput,
  isProse: ProseMatcher | undefined,
): Promise<RebaseCheck | undefined> {
  const { source, headSha, baseHeadSha } = input;
  const reject = (reason: string): RebaseCheck => ({ source, carried: false, reason });
  // The source comes from a review marker anyone can write, and reaches API paths.
  if (!isObjectId(source)) {
    return reject('not a commit id');
  }
  // A commit still in the head's history is the merge walk's to judge, step by
  // step; this check is only for one a force-push removed.
  const { status: history } = await client.compareCommits(source, headSha);
  if (history === 'identical' || history === 'ahead') {
    return undefined;
  }
  const { mergeBaseSha: sourceBase } = await client.compareCommits(baseHeadSha, source);
  const { mergeBaseSha: headBase } = await client.compareCommits(baseHeadSha, headSha);
  // The base may only have moved forward: replaying onto an older base would
  // also drop base changes the reviewed commit sat on.
  const { status } = await client.compareCommits(sourceBase, headBase);
  if (status !== 'identical' && status !== 'ahead') {
    return reject('the head sits on an older or unrelated base');
  }
  const { treeSha } = await client.getCommit(headSha);
  const step = { mergeBase: sourceBase, first: source, second: headBase, tree: treeSha };
  if (!(await verifier.verify(step))) {
    return reject('the head is not its clean automatic rebase');
  }
  const overlap =
    isProse === undefined ? undefined : await proseOverlapReason(verifier, step, isProse);
  return overlap === undefined ? { source, carried: true, reason: CARRIED } : reject(overlap);
}
