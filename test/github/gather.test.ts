import { describe, expect, it } from 'vitest';

import type { PullRequestData } from '../../src/github/client.js';
import { GitHubApiError } from '../../src/github/client.js';
import { gatherFacts } from '../../src/github/gather.js';
import type { GitRunner } from '../../src/lineage/git.js';
import { OLD_SHA } from '../fixtures.js';
import { FakeGitHubClient, makePullRequestData, makeReviewData } from './fake-client.js';

function makeClient(reviews = [makeReviewData()]) {
  const client = new FakeGitHubClient(makePullRequestData(), reviews);
  client.permissions.set('maintainer', { permission: 'write', roleName: 'write' });
  return client;
}

describe('gatherFacts — pull request fields', () => {
  it('maps the PR fields into facts', async () => {
    const client = new FakeGitHubClient(
      makePullRequestData({
        draft: true,
        title: '[WIP] fix: thing',
        headSha: OLD_SHA,
        labels: ['DevOps', 'approved'],
        autoMergeEnabled: true,
      }),
    );

    const { facts } = await gatherFacts(client, 7);

    expect(facts).toMatchObject({
      isDraft: true,
      title: '[WIP] fix: thing',
      headSha: OLD_SHA,
      labels: ['DevOps', 'approved'],
      autoMergeEnabled: true,
    });
  });

  it.each([false, undefined])('passes mergeable %j through to the facts', async (mergeable) => {
    const client = new FakeGitHubClient(makePullRequestData({ mergeable }));

    expect((await gatherFacts(client, 7)).facts.mergeable).toBe(mergeable);
  });

  it('returns the node id for the auto-merge mutations', async () => {
    const client = new FakeGitHubClient(makePullRequestData({ nodeId: 'PR_kwDO123' }));

    expect((await gatherFacts(client, 7)).nodeId).toBe('PR_kwDO123');
  });

  it.each([
    [{ state: 'open' as const, merged: false }, 'open'],
    [{ state: 'closed' as const, merged: false }, 'closed'],
    [{ state: 'closed' as const, merged: true }, 'merged'],
  ])('maps %j to status %s', async (pull, status) => {
    const client = new FakeGitHubClient(makePullRequestData(pull));

    expect((await gatherFacts(client, 7)).facts.status).toBe(status);
  });
});

describe('gatherFacts — bot eligibility', () => {
  const MINOR_BUMP = [
    '---',
    'updated-dependencies:',
    '- dependency-name: prettier',
    '  update-type: version-update:semver-minor',
    '...',
  ].join('\n');

  function makeDependabotClient(pull: Partial<PullRequestData> = {}) {
    const client = new FakeGitHubClient(
      makePullRequestData({ authorLogin: 'dependabot[bot]', headRef: 'dependabot/x', ...pull }),
    );
    client.commits = [{ authorLogin: 'dependabot[bot]', message: MINOR_BUMP }];
    return client;
  }

  it('marks a same-repo Dependabot minor bump eligible', async () => {
    expect((await gatherFacts(makeDependabotClient(), 7)).facts.botEligible).toBe(true);
  });

  it('returns the eligibility reason', async () => {
    const { botEligibility } = await gatherFacts(makeDependabotClient(), 7);

    expect(botEligibility).toMatchObject({
      prType: 'dependabot',
      updateType: 'version-update:semver-minor',
    });
  });

  it('never marks a fork PR eligible', async () => {
    const client = makeDependabotClient({ isCrossRepository: true });

    expect((await gatherFacts(client, 7)).facts.botEligible).toBe(false);
  });

  it('skips the commit fetch for a fork', async () => {
    const client = makeDependabotClient({ isCrossRepository: true });

    await gatherFacts(client, 7);

    expect(client.calls.some((call) => call.method === 'listCommits')).toBe(false);
  });

  it('skips the commit fetch for a non-Dependabot PR', async () => {
    const client = new FakeGitHubClient();

    await gatherFacts(client, 7);

    expect(client.calls.some((call) => call.method === 'listCommits')).toBe(false);
  });

  it('marks a same-repo release-please PR eligible', async () => {
    const client = new FakeGitHubClient(
      makePullRequestData({ headRef: 'release-please--branches--main' }),
    );

    expect((await gatherFacts(client, 7)).facts.botEligible).toBe(true);
  });

  it('treats a PR by a deleted account as not a bot PR', async () => {
    const client = new FakeGitHubClient(makePullRequestData({ authorLogin: undefined }));

    expect((await gatherFacts(client, 7)).botEligibility.prType).toBeUndefined();
  });
});

describe('gatherFacts — reviews', () => {
  it('maps review fields', async () => {
    const client = makeClient([
      makeReviewData({
        id: 42,
        commitSha: OLD_SHA,
        state: 'APPROVED',
        body: 'ship it',
        submittedAt: '2026-09-23T15:00:00Z',
      }),
    ]);

    const { facts } = await gatherFacts(client, 7);

    expect(facts.reviews[0]).toMatchObject({
      id: 42,
      commitSha: OLD_SHA,
      state: 'APPROVED',
      body: 'ship it',
      submittedAt: '2026-09-23T15:00:00Z',
    });
  });

  it('maps a pending review with no submission time to an empty timestamp', async () => {
    const client = makeClient([makeReviewData({ state: 'PENDING', submittedAt: undefined })]);

    expect((await gatherFacts(client, 7)).facts.reviews[0]?.submittedAt).toBe('');
  });

  it('attaches the author permission', async () => {
    const { facts } = await gatherFacts(makeClient(), 7);

    expect(facts.reviews[0]?.author).toEqual({
      login: 'maintainer',
      type: 'User',
      permission: 'write',
    });
  });

  it('prefers the fine-grained role over the legacy level', async () => {
    const client = makeClient();
    client.permissions.set('maintainer', { permission: 'write', roleName: 'maintain' });

    expect((await gatherFacts(client, 7)).facts.reviews[0]?.author.permission).toBe('maintain');
  });

  it('falls back to the legacy level for a custom role', async () => {
    const client = makeClient();
    client.permissions.set('maintainer', { permission: 'read', roleName: 'release-captain' });

    expect((await gatherFacts(client, 7)).facts.reviews[0]?.author.permission).toBe('read');
  });

  it('maps an unrecognized permission to none', async () => {
    const client = makeClient();
    client.permissions.set('maintainer', { permission: 'superuser', roleName: 'custom' });

    expect((await gatherFacts(client, 7)).facts.reviews[0]?.author.permission).toBe('none');
  });

  it('gives a non-collaborator (404) no permission', async () => {
    const client = makeClient([makeReviewData({ login: 'drive-by' })]);

    expect((await gatherFacts(client, 7)).facts.reviews[0]?.author.permission).toBe('none');
  });

  it('propagates a permission-lookup error other than 404', async () => {
    const client = makeClient();
    client.failNext('getCollaboratorPermission', new GitHubApiError(502, 'bad gateway'));

    await expect(gatherFacts(client, 7)).rejects.toThrow('bad gateway');
  });

  it('looks up each distinct author once', async () => {
    const client = makeClient([makeReviewData({ id: 1 }), makeReviewData({ id: 2 })]);

    await gatherFacts(client, 7);

    const lookups = client.calls.filter((call) => call.method === 'getCollaboratorPermission');
    expect(lookups).toHaveLength(1);
  });

  it('skips the permission lookup for bots', async () => {
    const client = makeClient([makeReviewData({ login: 'dependabot[bot]', type: 'Bot' })]);

    await gatherFacts(client, 7);

    expect(client.calls.some((call) => call.method === 'getCollaboratorPermission')).toBe(false);
  });

  it('gives a bot no permission even if it is a collaborator', async () => {
    const client = makeClient([makeReviewData({ login: 'deploy[bot]', type: 'Bot' })]);
    client.permissions.set('deploy[bot]', { permission: 'admin', roleName: 'admin' });

    expect((await gatherFacts(client, 7)).facts.reviews[0]?.author.permission).toBe('none');
  });

  it('treats a deleted ("ghost") author as untrusted without a lookup', async () => {
    const client = makeClient([makeReviewData({ login: undefined })]);

    const { facts } = await gatherFacts(client, 7);

    const lookups = client.calls.filter((call) => call.method === 'getCollaboratorPermission');
    expect([facts.reviews[0]?.author, lookups]).toEqual([
      { login: 'ghost', type: 'User', permission: 'none' },
      [],
    ]);
  });
});

const neverCalledGit: GitRunner = {
  run() {
    throw new Error('git should not be called');
  },
};

// Carry-over errors fail closed (nothing carries) but keep the reason, so a
// failed walk is never mistaken for one that didn't run.
describe('gatherFacts — lineage error boundary', () => {
  it('fails closed with the reason when getBranchHeadSha throws', async () => {
    const client = makeClient();
    client.failNext('getBranchHeadSha', new Error('rate limit'));

    const { lineage } = await gatherFacts(client, 7, {}, { lineage: { git: neverCalledGit } });

    expect(lineage).toEqual({
      cleanAncestors: [],
      stoppedBecause: 'verification failed: rate limit',
    });
  });

  it('fails closed with the reason when gatherLineage itself rejects', async () => {
    const review = makeReviewData({ commitSha: OLD_SHA, state: 'COMMENTED' });
    // The body's first read is gatherLineage's scan for reviewed ancestors; throw
    // there only, so the later mapping into facts still succeeds.
    let reads = 0;
    Object.defineProperty(review, 'body', {
      get() {
        reads += 1;
        if (reads === 1) {
          throw new Error('malformed review');
        }
        return '';
      },
    });
    const client = makeClient([review]);

    const { lineage } = await gatherFacts(client, 7, {}, { lineage: { git: neverCalledGit } });

    expect(lineage).toEqual({
      cleanAncestors: [],
      stoppedBecause: 'verification failed: malformed review',
    });
  });
});
