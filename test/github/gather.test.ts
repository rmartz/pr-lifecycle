import { describe, expect, it } from 'vitest';

import { GitHubApiError } from '../../src/github/client.js';
import { gatherFacts } from '../../src/github/gather.js';
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

  it('passes botEligible through', async () => {
    const { facts } = await gatherFacts(new FakeGitHubClient(), 7, { botEligible: true });

    expect(facts.botEligible).toBe(true);
  });

  it('defaults botEligible to false', async () => {
    expect((await gatherFacts(new FakeGitHubClient(), 7)).facts.botEligible).toBe(false);
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

    expect([facts.reviews[0]?.author, client.calls.length]).toEqual([
      { login: 'ghost', type: 'User', permission: 'none' },
      2,
    ]);
  });
});
