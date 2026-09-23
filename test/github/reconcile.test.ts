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

    const plan = await reconcilePullRequest(client, 7, ARMING);

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
    const plan = await reconcilePullRequest(makeApprovedClient(), 7, ARMING, { dryRun: true });

    expect(plan).toEqual({
      state: 'approved',
      addLabels: ['approved', 'auto-merge enabled'],
      removeLabels: [],
      autoMerge: 'arm',
    });
  });
});
