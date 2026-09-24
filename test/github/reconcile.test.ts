import { describe, expect, it } from 'vitest';

import { reconcilePullRequest } from '../../src/github/reconcile.js';
import { COPILOT_REVIEWER_LOGIN } from '../../src/state.js';
import { HEAD_SHA, makeVerdictBody, OLD_SHA } from '../fixtures.js';
import { FakeGitHubClient, makePullRequestData, makeReviewData } from './fake-client.js';

const ARMING = { armAutoMerge: true };

function makeApprovedClient() {
  const client = new FakeGitHubClient(makePullRequestData(), [
    makeReviewData({ id: 1, login: COPILOT_REVIEWER_LOGIN, type: 'Bot' }),
    makeReviewData({ id: 2, body: makeVerdictBody('approved') }),
  ]);
  client.permissions.set('maintainer', { permission: 'write', roleName: 'write' });
  return client;
}

describe('reconcilePullRequest', () => {
  it('converges an approved PR to its labels and arms auto-merge', async () => {
    const client = makeApprovedClient();

    await reconcilePullRequest(client, 7, ARMING);

    expect([client.pull.labels, client.pull.autoMergeEnabled]).toEqual([
      ['approved', 'auto-merge enabled'],
      true,
    ]);
  });

  it('is a no-op on the second pass', async () => {
    const client = makeApprovedClient();
    await reconcilePullRequest(client, 7, ARMING);
    const writesAfterFirstPass = client.writes.length;

    const { plan } = await reconcilePullRequest(client, 7, ARMING);

    expect([plan.addLabels, plan.removeLabels, plan.autoMerge, client.writes.length]).toEqual([
      [],
      [],
      'none',
      writesAfterFirstPass,
    ]);
  });

  it('disarms and relabels after a push invalidates the approval', async () => {
    const client = makeApprovedClient();
    await reconcilePullRequest(client, 7, ARMING);
    // A new commit lands: the approval and Copilot's review now cover OLD_SHA's
    // predecessor, and Copilot re-reviews the new head.
    client.reviews = client.reviews.map((review) => ({ ...review, commitSha: OLD_SHA }));
    client.pull.headSha = HEAD_SHA.replace(/a/g, 'c');
    client.reviews.push(
      makeReviewData({
        id: 3,
        login: COPILOT_REVIEWER_LOGIN,
        type: 'Bot',
        commitSha: client.pull.headSha,
      }),
    );

    await reconcilePullRequest(client, 7, ARMING);

    expect([client.pull.labels, client.pull.autoMergeEnabled]).toEqual([
      ['review requested'],
      false,
    ]);
  });

  it('never approves on a forged marker from a non-collaborator', async () => {
    const client = new FakeGitHubClient(makePullRequestData(), [
      makeReviewData({ login: 'drive-by', body: makeVerdictBody('approved') }),
    ]);

    await reconcilePullRequest(client, 7, ARMING);

    expect([client.pull.labels, client.pull.autoMergeEnabled]).toEqual([[], false]);
  });

  it('writes nothing in dry-run mode', async () => {
    const client = makeApprovedClient();

    await reconcilePullRequest(client, 7, ARMING, { dryRun: true });

    expect(client.writes).toEqual([]);
  });

  it('returns the plan in dry-run mode', async () => {
    const { plan } = await reconcilePullRequest(makeApprovedClient(), 7, ARMING, {
      dryRun: true,
    });

    expect(plan).toEqual({
      state: 'approved',
      addLabels: ['approved', 'auto-merge enabled'],
      removeLabels: [],
      autoMerge: 'arm',
      update: 'none',
    });
  });

  it('approves and arms an eligible Dependabot bump with no review', async () => {
    const client = new FakeGitHubClient(
      makePullRequestData({ authorLogin: 'dependabot[bot]', headRef: 'dependabot/x' }),
    );
    client.commits = [
      {
        authorLogin: 'dependabot[bot]',
        message: '---\nupdated-dependencies:\n  update-type: version-update:semver-patch\n...',
      },
    ];

    await reconcilePullRequest(client, 7, ARMING);

    expect([client.pull.labels, client.pull.autoMergeEnabled]).toEqual([
      ['approved', 'auto-merge enabled'],
      true,
    ]);
  });

  it('never approves a fork PR imitating a release-please branch', async () => {
    const client = new FakeGitHubClient(
      makePullRequestData({ headRef: 'release-please--branches--main', isCrossRepository: true }),
    );

    await reconcilePullRequest(client, 7, ARMING);

    expect([client.pull.labels, client.pull.autoMergeEnabled]).toEqual([[], false]);
  });
});

describe('reconcilePullRequest — merge or arm', () => {
  it.each(['clean', 'has_hooks', 'unstable'])(
    'merges an approved PR whose merge state is %s, bound to its head',
    async (mergeState) => {
      const client = makeApprovedClient();
      client.pull.mergeState = mergeState;

      await reconcilePullRequest(client, 7, ARMING);

      expect(client.writes.filter((call) => call.method === 'mergePullRequest')).toEqual([
        { method: 'mergePullRequest', args: ['PR_node', HEAD_SHA] },
      ]);
    },
  );

  it.each(['blocked', 'behind', 'unknown', undefined])(
    'arms, not merges, an approved PR whose merge state is %s',
    async (mergeState) => {
      const client = makeApprovedClient();
      client.pull.mergeState = mergeState;

      const { plan } = await reconcilePullRequest(client, 7, ARMING);

      expect(plan.autoMerge).toBe('arm');
    },
  );

  it('arms and merges through the release actions when given', async () => {
    const client = makeApprovedClient();
    const release = new FakeGitHubClient();

    await reconcilePullRequest(client, 7, ARMING, { release });

    expect([
      client.writes.some((call) => call.method === 'enableAutoMerge'),
      release.calls.map((call) => call.method),
    ]).toEqual([false, ['enableAutoMerge']]);
  });
});

describe('reconcilePullRequest — release unavailable', () => {
  it('keeps the labels but neither arms nor claims the auto-merge label', async () => {
    const client = makeApprovedClient();

    const { plan } = await reconcilePullRequest(client, 7, ARMING, { release: 'unavailable' });

    expect([plan.autoMerge, client.pull.labels, client.pull.autoMergeEnabled]).toEqual([
      'none',
      ['approved'],
      false,
    ]);
  });

  it.each([
    ['blocked', 'arm'],
    ['clean', 'merge'],
  ] as const)('reports a skipped %s → %s', async (mergeState, skipped) => {
    const client = makeApprovedClient();
    client.pull.mergeState = mergeState;

    const result = await reconcilePullRequest(client, 7, ARMING, { release: 'unavailable' });

    expect([result.skippedAutoMerge, client.pull.merged]).toEqual([skipped, false]);
  });

  it('still disarms a PR that lost its approval', async () => {
    const client = new FakeGitHubClient(
      makePullRequestData({ labels: ['auto-merge enabled'], autoMergeEnabled: true }),
    );

    const result = await reconcilePullRequest(client, 7, ARMING, { release: 'unavailable' });

    expect([result.plan.autoMerge, result.skippedAutoMerge, client.pull.autoMergeEnabled]).toEqual([
      'disarm',
      undefined,
      false,
    ]);
  });

  it('reports nothing skipped when arming is off', async () => {
    const client = makeApprovedClient();

    const { skippedAutoMerge } = await reconcilePullRequest(
      client,
      7,
      {},
      { release: 'unavailable' },
    );

    expect(skippedAutoMerge).toBeUndefined();
  });
});
