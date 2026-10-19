import { describe, expect, it } from 'vitest';

import { runCli } from '../src/cli.js';
import { GitHubApiError } from '../src/github/client.js';
import { reconcilePullRequest } from '../src/github/reconcile.js';
import { makeApprovedClient, makeDeps, makeIo, RECONCILE } from './cli-fixtures.js';

/**
 * How the arm/merge race is reported: the result and `--json` say what was done,
 * not what was planned, and a deferral is a notice, never a failure.
 */

const ARMING = { armAutoMerge: true };
const ARM = [...RECONCILE, '--arm-auto-merge'];

const QUEUED = new GitHubApiError(
  200,
  'GraphQL error: Repository rule violations found\n\nRequired status check "merge-safety" is queued.\n\n',
);
const CLEAN_STATUS = new GitHubApiError(200, 'GraphQL error: Pull request is in clean status');

/** An approved PR GitHub reports as mergeable right now, so the plan says merge. */
function makeMergeableClient() {
  const client = makeApprovedClient();
  client.pull.mergeState = 'clean';
  return client;
}

describe('reconcilePullRequest — arm/merge outcome', () => {
  it('reports arm when a planned merge fell back to arming', async () => {
    const client = makeMergeableClient();
    client.failNext('mergePullRequest', QUEUED);

    const result = await reconcilePullRequest(client, 7, ARMING);

    expect([result.plan.autoMerge, result.autoMerge, result.deferredAutoMerge]).toEqual([
      'merge',
      'arm',
      undefined,
    ]);
  });

  it('reports a deferral when both attempts lost the race', async () => {
    const client = makeMergeableClient();
    client.failNext('mergePullRequest', QUEUED);
    client.failNext('enableAutoMerge', CLEAN_STATUS);

    const result = await reconcilePullRequest(client, 7, ARMING);

    expect([result.autoMerge, result.deferredAutoMerge]).toEqual(['none', 'merge']);
  });

  it('reports the planned action on a dry run', async () => {
    const result = await reconcilePullRequest(makeMergeableClient(), 7, ARMING, { dryRun: true });

    expect([result.autoMerge, result.deferredAutoMerge]).toEqual(['merge', undefined]);
  });
});

describe('runCli — a deferred arm or merge', () => {
  it('exits 0', async () => {
    const client = makeMergeableClient();
    client.failNext('mergePullRequest', QUEUED);
    client.failNext('enableAutoMerge', CLEAN_STATUS);

    const code = await runCli(ARM, makeIo().io, makeDeps(client).deps);

    expect(code).toBe(0);
  });

  it('reports the deferral in --json', async () => {
    const client = makeMergeableClient();
    client.failNext('mergePullRequest', QUEUED);
    client.failNext('enableAutoMerge', CLEAN_STATUS);
    const { out, io } = makeIo();

    await runCli([...ARM, '--json'], io, makeDeps(client).deps);

    const json = JSON.parse(out.join('')) as Record<string, unknown>;
    expect([json.autoMerge, json.autoMergeDeferred]).toEqual([
      'none',
      { action: 'merge', reason: 'merge-state-changed' },
    ]);
  });

  it('notes the deferral on stderr', async () => {
    const client = makeMergeableClient();
    client.failNext('mergePullRequest', QUEUED);
    client.failNext('enableAutoMerge', CLEAN_STATUS);
    const { err, io } = makeIo();

    await runCli(ARM, io, makeDeps(client).deps);

    expect(err).toEqual([
      'notice: rmartz/demo#7 is approved, but auto-merge merge was deferred: its merge state changed mid-run; the next event retries',
    ]);
  });

  it('reports the fallback arm in --json when the merge was refused', async () => {
    const client = makeMergeableClient();
    client.failNext('mergePullRequest', QUEUED);
    const { out, io } = makeIo();

    await runCli([...ARM, '--json'], io, makeDeps(client).deps);

    const json = JSON.parse(out.join('')) as Record<string, unknown>;
    expect([json.autoMerge, json.autoMergeDeferred]).toEqual(['arm', null]);
  });
});
