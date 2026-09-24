import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reconcilePullRequest } from '../../src/github/reconcile.js';
import { createGitRunner } from '../../src/lineage/git.js';
import { UPDATE_REQUIRED_LABEL } from '../../src/plan.js';
import { COPILOT_REVIEWER_LOGIN } from '../../src/state.js';
import { makeVerdictBody } from '../fixtures.js';
import { GitFixture } from '../lineage/fixture.js';
import { FakeGitHubClient, makePullRequestData, makeReviewData } from './fake-client.js';

/**
 * End to end: a PR approved on commit A, then updated with the base, reconciled
 * through the real carry-over path (real git, fixture repo as the remote).
 */

let repo: GitFixture;

beforeEach(() => {
  repo = new GitFixture();
  repo.commit('base', { 'shared.txt': 'a\nb\nc\n', 'other.txt': 'base\n' });
});

afterEach(() => {
  repo.dispose();
});

/** A PR approved (and Copilot-reviewed) on A; returns a client for the given head. */
function approvedPr(update: (fixture: GitFixture) => void): FakeGitHubClient {
  repo.checkout('pr', true);
  const approved = repo.commit('pr change', { 'feat.txt': 'feat\n' });
  repo.checkout('main');
  repo.commit('main change', { 'other.txt': 'main\n' });
  repo.checkout('pr');
  update(repo);

  const client = new FakeGitHubClient(
    makePullRequestData({ headSha: repo.head(), cloneUrl: repo.url }),
    [
      makeReviewData({ id: 1, login: COPILOT_REVIEWER_LOGIN, type: 'Bot', commitSha: approved }),
      makeReviewData({ id: 2, commitSha: approved, body: makeVerdictBody('approved', approved) }),
    ],
  );
  client.permissions.set('maintainer', { permission: 'write', roleName: 'write' });
  client.branchHeads.set('main', repo.git('rev-parse', 'main'));
  const fixtureClient = repo.client();
  client.getCommit = fixtureClient.getCommit;
  client.compareCommits = fixtureClient.compareCommits;
  return client;
}

const LINEAGE = { lineage: { git: createGitRunner() } };

describe('reconcilePullRequest with approval carry-over', () => {
  it('keeps the approval (and arms) after a clean base update', async () => {
    const client = approvedPr((fixture) => fixture.mergeClean('main'));

    const { plan } = await reconcilePullRequest(client, 7, { armAutoMerge: true }, LINEAGE);

    expect([plan.state, plan.autoMerge]).toEqual(['approved', 'arm']);
  });

  it('drops the approval after a tampered update', async () => {
    const client = approvedPr((fixture) =>
      fixture.mergeWithEdits('main', { 'feat.txt': 'feat\nsneaky\n' }),
    );

    const { plan } = await reconcilePullRequest(client, 7, { armAutoMerge: true }, LINEAGE);

    expect(plan.state).toBe('awaiting-copilot');
  });

  it('reports what carry-over verified', async () => {
    const client = approvedPr((fixture) => fixture.mergeClean('main'));

    const { lineage } = await reconcilePullRequest(client, 7, {}, { ...LINEAGE, dryRun: true });

    expect(lineage?.stoppedBecause).toBe('every reviewed ancestor reached');
  });

  it('carries nothing without the lineage option (off by default)', async () => {
    const client = approvedPr((fixture) => fixture.mergeClean('main'));

    const { plan, lineage } = await reconcilePullRequest(client, 7, {});

    expect([plan.state, lineage]).toEqual(['awaiting-copilot', undefined]);
  });

  it('skips carry-over for a closed PR', async () => {
    const client = approvedPr((fixture) => fixture.mergeClean('main'));
    client.pull.state = 'closed';

    const { lineage } = await reconcilePullRequest(client, 7, {}, LINEAGE);

    expect(lineage).toBeUndefined();
  });
});

describe('reconcilePullRequest auto-update, end to end', () => {
  it('updates an approved PR, then keeps it approved and armed once CI is green', async () => {
    // The update the fake update-branch will produce: a clean merge of main,
    // kept on a ref (so carry-over can fetch it) while the PR stays on A.
    let updated = '';
    const client = approvedPr((fixture) => {
      updated = fixture.mergeClean('main');
      fixture.git('branch', 'updated');
      fixture.git('reset', '--hard', 'HEAD~1');
    });
    client.pull.labels = [UPDATE_REQUIRED_LABEL];
    client.updatedHeadSha = updated;
    const policy = { armAutoMerge: true, autoUpdate: true };

    await reconcilePullRequest(client, 7, policy, LINEAGE);
    // merge-safety clears its label, and required CI passes on the new head.
    client.pull.labels = client.pull.labels.filter((name) => name !== UPDATE_REQUIRED_LABEL);
    client.requiredChecks.set('main', ['test']);
    client.checkRuns.set(updated, [
      { name: 'test', status: 'completed', conclusion: 'success', completedAt: null, title: null },
    ]);
    const { plan } = await reconcilePullRequest(client, 7, policy, LINEAGE);

    expect([client.pull.headSha, plan.state, client.pull.autoMergeEnabled, plan.update]).toEqual([
      updated,
      'approved',
      true,
      'none',
    ]);
  });
});
