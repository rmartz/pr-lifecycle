import { describe, expect, it } from 'vitest';

import { GitHubApiError } from '../../src/github/client.js';
import { executePlan } from '../../src/github/execute.js';
import type { ReconcilePlan } from '../../src/plan.js';
import { HEAD_SHA } from '../fixtures.js';
import { FakeGitHubClient } from './fake-client.js';

/**
 * The arm/merge race: GitHub's merge state can change between the read and the
 * write, so each of arm and merge falls back to the other once (see
 * docs/github-edge-layer.md §Arming and merging).
 */

const TARGET = { pr: 7, nodeId: 'PR_node', headSha: HEAD_SHA };

function makePlan(overrides: Partial<ReconcilePlan> = {}): ReconcilePlan {
  return {
    state: 'approved',
    addLabels: [],
    removeLabels: [],
    autoMerge: 'none',
    update: 'none',
    ...overrides,
  };
}

/** GitHub's refusal of a merge while a required check is still running. */
function pendingCheck(phrase: string): GitHubApiError {
  return new GitHubApiError(
    200,
    `GraphQL error: Repository rule violations found\n\nRequired status check "merge-safety" ${phrase}.\n\n`,
  );
}

const CLEAN_STATUS = new GitHubApiError(200, 'GraphQL error: Pull request is in clean status');

describe('executePlan — merge falls back to arming', () => {
  // rmartz/hidden-role-game#988: the run's own label writes re-triggered
  // merge-safety, which queued a fresh required check before the merge.
  it('arms, bound to the same head, when a required check is queued', async () => {
    const client = new FakeGitHubClient();
    client.failNext('mergePullRequest', pendingCheck('is queued'));

    await executePlan(client, TARGET, makePlan({ autoMerge: 'merge' }));

    expect(client.calls).toEqual([
      { method: 'mergePullRequest', args: ['PR_node', HEAD_SHA] },
      { method: 'enableAutoMerge', args: ['PR_node', HEAD_SHA] },
    ]);
  });

  it.each(['is expected', 'is pending', 'is in progress'])(
    'arms when a required check %s',
    async (phrase) => {
      const client = new FakeGitHubClient();
      client.failNext('mergePullRequest', pendingCheck(phrase));

      const outcome = await executePlan(client, TARGET, makePlan({ autoMerge: 'merge' }));

      expect(outcome).toEqual({ autoMerge: 'arm', deferred: undefined });
    },
  );

  it('arms when several required checks are still running', async () => {
    const client = new FakeGitHubClient();
    client.failNext(
      'mergePullRequest',
      new GitHubApiError(200, 'GraphQL error: Required status checks "CI", "Lint" are expected.'),
    );

    const outcome = await executePlan(client, TARGET, makePlan({ autoMerge: 'merge' }));

    expect(outcome.autoMerge).toBe('arm');
  });

  // A failed required check is not a race: arming would only wait on a red check.
  it('propagates a merge refused for a failed required check, without arming', async () => {
    const client = new FakeGitHubClient();
    client.failNext(
      'mergePullRequest',
      new GitHubApiError(200, 'GraphQL error: Required status check "CI" has failed.'),
    );

    await expect(executePlan(client, TARGET, makePlan({ autoMerge: 'merge' }))).rejects.toThrow(
      'has failed',
    );
    expect(client.calls.map((call) => call.method)).toEqual(['mergePullRequest']);
  });

  // A moved head means unreviewed commits: never retry, never arm.
  it('propagates a merge refused because the head moved, without arming', async () => {
    const client = new FakeGitHubClient();
    client.failNext(
      'mergePullRequest',
      new GitHubApiError(200, 'GraphQL error: Head branch was modified. Review and try again.'),
    );

    await expect(executePlan(client, TARGET, makePlan({ autoMerge: 'merge' }))).rejects.toThrow(
      'Head branch was modified',
    );
    expect(client.calls.map((call) => call.method)).toEqual(['mergePullRequest']);
  });

  it('propagates an arming error after the fallback that is not the race', async () => {
    const client = new FakeGitHubClient();
    client.failNext('mergePullRequest', pendingCheck('is queued'));
    client.failNext('enableAutoMerge', new GitHubApiError(403, 'forbidden'));

    await expect(executePlan(client, TARGET, makePlan({ autoMerge: 'merge' }))).rejects.toThrow(
      'forbidden',
    );
  });
});

describe('executePlan — arm/merge outcome', () => {
  it('reports the planned arm when it succeeds', async () => {
    const outcome = await executePlan(
      new FakeGitHubClient(),
      TARGET,
      makePlan({ autoMerge: 'arm' }),
    );

    expect(outcome).toEqual({ autoMerge: 'arm', deferred: undefined });
  });

  it('reports a merge when arming found the PR already clean', async () => {
    const client = new FakeGitHubClient();
    client.failNext('enableAutoMerge', CLEAN_STATUS);

    const outcome = await executePlan(client, TARGET, makePlan({ autoMerge: 'arm' }));

    expect(outcome).toEqual({ autoMerge: 'merge', deferred: undefined });
  });

  // rmartz/pr-lifecycle#114: a non-required check was still pending, so GitHub
  // refused the arm with "unstable status" and the whole reconcile failed.
  it('merges, bound to the same head, when arming found the PR unstable', async () => {
    const client = new FakeGitHubClient();
    client.failNext(
      'enableAutoMerge',
      new GitHubApiError(200, 'GraphQL error: Pull request Pull request is in unstable status'),
    );

    const outcome = await executePlan(client, TARGET, makePlan({ autoMerge: 'arm' }));

    expect(outcome).toEqual({ autoMerge: 'merge', deferred: undefined });
    expect(client.calls).toEqual([
      { method: 'enableAutoMerge', args: ['PR_node', HEAD_SHA] },
      { method: 'mergePullRequest', args: ['PR_node', HEAD_SHA] },
    ]);
  });

  it('reports a disarm as planned', async () => {
    const outcome = await executePlan(
      new FakeGitHubClient(),
      TARGET,
      makePlan({ state: 'review-requested', autoMerge: 'disarm' }),
    );

    expect(outcome).toEqual({ autoMerge: 'disarm', deferred: undefined });
  });
});

describe('executePlan — the race is bounded', () => {
  // The state flipped back between the two attempts: give up quietly, once.
  it('defers a planned merge when the arm fallback finds the PR clean again', async () => {
    const client = new FakeGitHubClient();
    client.failNext('mergePullRequest', pendingCheck('is queued'));
    client.failNext('enableAutoMerge', CLEAN_STATUS);

    const outcome = await executePlan(client, TARGET, makePlan({ autoMerge: 'merge' }));

    expect(outcome).toEqual({ autoMerge: 'none', deferred: 'merge' });
  });

  it('defers a planned arm when the merge fallback finds a check queued again', async () => {
    const client = new FakeGitHubClient();
    client.failNext('enableAutoMerge', CLEAN_STATUS);
    client.failNext('mergePullRequest', pendingCheck('is queued'));

    const outcome = await executePlan(client, TARGET, makePlan({ autoMerge: 'arm' }));

    expect(outcome).toEqual({ autoMerge: 'none', deferred: 'arm' });
  });

  it('makes exactly two attempts before deferring', async () => {
    const client = new FakeGitHubClient();
    client.failNext('mergePullRequest', pendingCheck('is queued'));
    client.failNext('enableAutoMerge', CLEAN_STATUS);

    await executePlan(client, TARGET, makePlan({ autoMerge: 'merge' }));

    expect(client.calls.map((call) => call.method)).toEqual([
      'mergePullRequest',
      'enableAutoMerge',
    ]);
  });
});

describe('executePlan — update after arm or merge', () => {
  it('skips the update when arming fell back to merging the PR', async () => {
    const client = new FakeGitHubClient();
    client.failNext('enableAutoMerge', CLEAN_STATUS);

    await executePlan(client, TARGET, makePlan({ autoMerge: 'arm', update: 'update-branch' }));

    expect(client.calls.map((call) => call.method)).toEqual([
      'enableAutoMerge',
      'mergePullRequest',
    ]);
  });

  // The update moves the head, which re-triggers the reconcile that arms the PR.
  it('still updates when the arm was deferred', async () => {
    const client = new FakeGitHubClient();
    client.failNext('enableAutoMerge', CLEAN_STATUS);
    client.failNext('mergePullRequest', pendingCheck('is queued'));

    await executePlan(client, TARGET, makePlan({ autoMerge: 'arm', update: 'update-branch' }));

    expect(client.calls.at(-1)).toEqual({ method: 'updateBranch', args: [7, HEAD_SHA] });
  });
});
