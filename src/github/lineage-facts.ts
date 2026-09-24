import type { GitRunner } from '../lineage/git.js';
import type { RepoSource } from '../lineage/verify.js';
import { createMergeVerifier } from '../lineage/verify.js';
import { COPILOT_REVIEWER_LOGIN } from '../state.js';
import type { GitHubClient, ReviewData } from './client.js';

/**
 * Finds the head's clean ancestors: commits reached by walking back from the head
 * through a chain of **verified clean base merges**, so reviews bound to them
 * still describe the change being merged (docs/reconciler-design.md §Approval
 * carry-over). Fails closed: any doubt or error ends the chain, and the cost is
 * an extra review, never a false approval.
 */

/** A longer chain of base merges than this is unusual enough to review again. */
export const MAX_CHAIN_STEPS = 20;

type LineageClient = Pick<GitHubClient, 'compareCommits' | 'getCommit'>;

export interface LineageInput {
  headSha: string;
  /** The base branch's current head: every merged-in base commit must be on it. */
  baseHeadSha: string;
  source: RepoSource;
  reviews: readonly ReviewData[];
}

export interface Lineage {
  cleanAncestors: string[];
  /** Why the walk stopped, for reporting. */
  stoppedBecause: string;
}

/** Commits (other than the head) that some review is bound to: the only ones worth reaching. */
function reviewedAncestors(input: LineageInput): Set<string> {
  return new Set(
    input.reviews
      .filter((review) => review.commitSha !== input.headSha)
      .filter(
        (review) =>
          review.login === COPILOT_REVIEWER_LOGIN ||
          review.state === 'APPROVED' ||
          review.state === 'CHANGES_REQUESTED' ||
          review.body.includes('skill-meta'),
      )
      .map((review) => review.commitSha),
  );
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

async function walk(
  client: LineageClient,
  git: GitRunner,
  input: LineageInput,
  wanted: Set<string>,
): Promise<Lineage> {
  const verifier = await createMergeVerifier(git, input.source);
  if (verifier === undefined) {
    return { cleanAncestors: [], stoppedBecause: 'git unavailable or older than 2.40' };
  }
  const cleanAncestors: string[] = [];
  try {
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
      const clean = await verifier.verify({
        mergeBase: mergeBaseSha,
        first,
        second,
        tree: commit.treeSha,
      });
      if (!clean) {
        return { cleanAncestors, stoppedBecause: `${current} is not the clean automatic merge` };
      }
      cleanAncestors.push(first);
      current = first;
      if ([...wanted].every((sha) => cleanAncestors.includes(sha))) {
        return { cleanAncestors, stoppedBecause: 'every reviewed ancestor reached' };
      }
    }
    return { cleanAncestors, stoppedBecause: `chain longer than ${MAX_CHAIN_STEPS} steps` };
  } finally {
    await verifier.dispose();
  }
}

export async function gatherLineage(
  client: LineageClient,
  git: GitRunner,
  input: LineageInput,
): Promise<Lineage> {
  const wanted = reviewedAncestors(input);
  if (wanted.size === 0) {
    return { cleanAncestors: [], stoppedBecause: 'no reviews on earlier commits' };
  }
  try {
    return await walk(client, git, input, wanted);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { cleanAncestors: [], stoppedBecause: `verification failed: ${message}` };
  }
}
