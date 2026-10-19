import { describe, expect, it } from 'vitest';

import { gatherFacts } from '../../src/github/gather.js';
import { reconcilePullRequest } from '../../src/github/reconcile.js';
import { HEAD_SHA, OLD_SHA } from '../fixtures.js';
import { FakeGitHubClient, makePullRequestData, makeReviewData } from './fake-client.js';
import { makeTransport } from './http-fake.js';

// GitHub moves an approval's commit_id onto the new head when a force-push leaves
// the diff unchanged (rmartz/personal-budget#562). These cover the edge: reading
// the force-pushes, and a full reconcile that refuses the moved approval.

const APPROVED_AT = '2026-10-19T16:15:32Z';
const PUSHED_AFTER = '2026-10-19T16:21:57Z';

function makeApprovedClient() {
  const client = new FakeGitHubClient(makePullRequestData({ autoMergeEnabled: true }), [
    makeReviewData({ state: 'APPROVED', submittedAt: APPROVED_AT }),
  ]);
  client.permissions.set('maintainer', { permission: 'write', roleName: 'write' });
  client.pull.labels = ['approved', 'auto-merge enabled'];
  return client;
}

describe('listForcePushes', () => {
  it('maps only the force-push events, with the commit each one made the head', async () => {
    const { client, requests } = makeTransport([
      {
        json: [
          {
            event: 'head_ref_force_pushed',
            created_at: PUSHED_AFTER,
            actor: { login: 'dependabot[bot]', type: 'Bot' },
            commit_id: HEAD_SHA,
          },
          {
            event: 'unlabeled',
            created_at: '2026-10-19T16:22:00Z',
            actor: { login: 'rmartz', type: 'User' },
            label: { name: 'approved' },
          },
        ],
      },
    ]);

    const pushes = await client.listForcePushes(7);

    expect([requests[0]?.url, pushes]).toEqual([
      'https://api.github.com/repos/rmartz/demo/issues/7/events?per_page=100&page=1',
      [{ headSha: HEAD_SHA, pushedAt: PUSHED_AFTER }],
    ]);
  });

  it('reads a force-push without a commit as unattributed', async () => {
    const { client } = makeTransport([
      { json: [{ event: 'head_ref_force_pushed', created_at: PUSHED_AFTER, commit_id: null }] },
    ]);

    expect(await client.listForcePushes(7)).toEqual([
      { headSha: undefined, pushedAt: PUSHED_AFTER },
    ]);
  });
});

describe('gatherFacts — force-pushes', () => {
  it('skips the issue events when no review is a verdict', async () => {
    const client = new FakeGitHubClient(makePullRequestData(), [makeReviewData()]);
    client.forcePushes = [{ headSha: HEAD_SHA, pushedAt: PUSHED_AFTER }];

    const { facts } = await gatherFacts(client, 7);

    expect([
      client.calls.some((call) => call.method === 'listForcePushes'),
      facts.forcePushes,
    ]).toEqual([false, []]);
  });

  it('gathers the force-pushes when a review is a verdict', async () => {
    const client = makeApprovedClient();
    client.forcePushes = [{ headSha: OLD_SHA, pushedAt: '2026-10-19T02:08:42Z' }];

    const { facts } = await gatherFacts(client, 7);

    expect(facts.forcePushes).toEqual([{ headSha: OLD_SHA, pushedAt: '2026-10-19T02:08:42Z' }]);
  });
});

describe('reconcilePullRequest — approval moved onto a force-pushed head', () => {
  it('un-approves and disarms the PR', async () => {
    const client = makeApprovedClient();
    client.forcePushes = [{ headSha: HEAD_SHA, pushedAt: PUSHED_AFTER }];

    const { plan } = await reconcilePullRequest(client, 7, { armAutoMerge: true });

    expect([plan.state, client.pull.autoMergeEnabled]).toEqual(['review-requested', false]);
  });

  it('keeps an approval submitted after the force-push armed', async () => {
    const client = makeApprovedClient();
    client.forcePushes = [{ headSha: HEAD_SHA, pushedAt: '2026-10-19T16:10:00Z' }];

    const { plan } = await reconcilePullRequest(client, 7, { armAutoMerge: true });

    expect([plan.state, client.pull.autoMergeEnabled]).toEqual(['approved', true]);
  });
});
