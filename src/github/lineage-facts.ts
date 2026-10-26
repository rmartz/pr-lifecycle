import type { GitRunner } from '../lineage/git.js';
import type { ProseMatcher } from '../lineage/prose.js';
import { DEFAULT_PROSE_PATTERNS, proseMatcher, proseOverlapReason } from '../lineage/prose.js';
import type { MergeVerifier, RepoSource } from '../lineage/verify.js';
import { createMergeVerifier } from '../lineage/verify.js';
import { isObjectId } from '../object-id.js';
import { parseVerdictRecord } from '../verdict-marker.js';
import type { GitHubClient, ReviewData } from './client.js';
import type { RebaseCheck, RebaseInput } from './lineage-rebase.js';
import { checkCleanRebase } from './lineage-rebase.js';

/**
 * Finds the head's clean ancestors: commits reached by walking back from the head
 * through a chain of **verified clean base merges**, so reviews bound to them
 * still describe the change being merged (docs/reconciler-design.md §Approval
 * carry-over). A clean merge in which both sides edited the same prose file also
 * ends the chain: nothing automatic checks that the merged page still reads
 * correctly. A reviewed commit the walk can't reach (the branch was rebased)
 * gets the clean-rebase check instead (./lineage-rebase.ts). Fails closed: any
 * doubt or error ends the chain, and the cost is an extra review, never a false
 * approval.
 */

/** A longer chain of base merges than this is unusual enough to review again. */
export const MAX_CHAIN_STEPS = 20;

/**
 * At most this many unreached reviewed commits get the clean-rebase check, newest
 * review first. Anyone can post a marker naming a commit, so the work a run does
 * for them is bounded.
 */
export const MAX_REBASE_CHECKS = 3;

type LineageClient = Pick<GitHubClient, 'compareCommits' | 'getCommit'>;

export interface LineageInput {
  headSha: string;
  /** The base branch's current head: every merged-in base commit must be on it. */
  baseHeadSha: string;
  source: RepoSource;
  reviews: readonly ReviewData[];
  /**
   * Basename patterns for prose files (see src/lineage/prose.ts); default
   * `DEFAULT_PROSE_PATTERNS`. Empty turns the prose-overlap check off.
   */
  prosePatterns?: readonly string[];
}

export interface Lineage {
  cleanAncestors: string[];
  /** Why the walk stopped, for reporting. */
  stoppedBecause: string;
  /** The clean-rebase checks run for reviewed commits the walk didn't reach. */
  rebases: RebaseCheck[];
}

/**
 * Commits (other than the head) that some possible verdict reviewed, newest
 * review first: the only ones worth reaching. A verdict reviewed its marker's
 * `pr_head` when it names one, else its `commit_id`; GitHub can re-point a
 * review's `commit_id` after a force-push, but not the marker. A bot's review
 * never counts, so it is skipped.
 */
function reviewedCommits(input: LineageInput): string[] {
  const subjects = input.reviews
    .filter((review) => review.type === 'User')
    .toReversed()
    .flatMap((review) => {
      const parsed = parseVerdictRecord(review);
      return parsed === undefined ? [] : [parsed.markerHead ?? review.commitSha];
    })
    .filter((sha) => sha !== input.headSha);
  return [...new Set(subjects)];
}

/** Is `commit` on the base branch, i.e. reachable from its head? */
async function onBaseBranch(
  client: LineageClient,
  commit: string,
  baseHeadSha: string,
): Promise<boolean> {
  const { status } = await client.compareCommits(commit, baseHeadSha);
  return status === 'identical' || status === 'ahead';
}

interface WalkResult {
  cleanAncestors: string[];
  stoppedBecause: string;
}

async function walk(
  client: LineageClient,
  verifier: MergeVerifier,
  input: LineageInput,
  wanted: readonly string[],
  isProse: ProseMatcher | undefined,
): Promise<WalkResult> {
  const cleanAncestors: string[] = [];
  let current = input.headSha;
  for (let step = 0; step < MAX_CHAIN_STEPS; step += 1) {
    const commit = await client.getCommit(current);
    const [first, second, ...extra] = commit.parents;
    if (first === undefined || second === undefined || extra.length > 0) {
      return { cleanAncestors, stoppedBecause: `${current} is not a two-parent merge` };
    }
    if (!(await onBaseBranch(client, second, input.baseHeadSha))) {
      return { cleanAncestors, stoppedBecause: `${current} merges a commit not on the base` };
    }
    const { mergeBaseSha } = await client.compareCommits(first, second);
    const mergeStep = { mergeBase: mergeBaseSha, first, second, tree: commit.treeSha };
    if (!(await verifier.verify(mergeStep))) {
      return { cleanAncestors, stoppedBecause: `${current} is not the clean automatic merge` };
    }
    const overlap =
      isProse === undefined ? undefined : await proseOverlapReason(verifier, mergeStep, isProse);
    if (overlap !== undefined) {
      return { cleanAncestors, stoppedBecause: `${current}: ${overlap}` };
    }
    cleanAncestors.push(first);
    current = first;
    if (wanted.every((sha) => cleanAncestors.includes(sha))) {
      return { cleanAncestors, stoppedBecause: 'every reviewed ancestor reached' };
    }
  }
  return { cleanAncestors, stoppedBecause: `chain longer than ${MAX_CHAIN_STEPS} steps` };
}

/**
 * One rebase check, with an error confined to it: a review can name any commit,
 * including one GitHub doesn't know (404), and that must not stop the merge walk
 * or another review's check from carrying.
 */
async function checkRebaseSafely(
  client: LineageClient,
  verifier: MergeVerifier,
  input: RebaseInput,
  isProse: ProseMatcher | undefined,
): Promise<RebaseCheck | undefined> {
  try {
    return await checkCleanRebase(client, verifier, input, isProse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { source: input.source, carried: false, reason: `verification failed: ${message}` };
  }
}

async function verifyLineage(
  client: LineageClient,
  git: GitRunner,
  input: LineageInput,
  wanted: readonly string[],
): Promise<Lineage> {
  const verifier = await createMergeVerifier(git, input.source);
  if (verifier === undefined) {
    return {
      cleanAncestors: [],
      stoppedBecause: 'git unavailable or older than 2.40',
      rebases: [],
    };
  }
  const patterns = input.prosePatterns ?? DEFAULT_PROSE_PATTERNS;
  const isProse = patterns.length === 0 ? undefined : proseMatcher(patterns);
  try {
    const walked = await walk(client, verifier, input, wanted, isProse);
    // Anything but a commit id can't be a commit: don't let it use up the budget.
    const unreached = wanted.filter(
      (sha) => isObjectId(sha) && !walked.cleanAncestors.includes(sha),
    );
    const rebases: RebaseCheck[] = [];
    // One at a time: the checks share the verifier's scratch repository.
    for (const source of unreached.slice(0, MAX_REBASE_CHECKS)) {
      const { headSha, baseHeadSha } = input;
      const check = await checkRebaseSafely(
        client,
        verifier,
        { source, headSha, baseHeadSha },
        isProse,
      );
      if (check !== undefined) {
        rebases.push(check);
      }
    }
    return { ...walked, rebases };
  } finally {
    await verifier.dispose();
  }
}

export async function gatherLineage(
  client: LineageClient,
  git: GitRunner,
  input: LineageInput,
): Promise<Lineage> {
  const wanted = reviewedCommits(input);
  if (wanted.length === 0) {
    return { cleanAncestors: [], stoppedBecause: 'no reviews on earlier commits', rebases: [] };
  }
  try {
    return await verifyLineage(client, git, input, wanted);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { cleanAncestors: [], stoppedBecause: `verification failed: ${message}`, rebases: [] };
  }
}
