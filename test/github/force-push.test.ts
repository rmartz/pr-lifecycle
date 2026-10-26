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

/** One page of the timeline's force-push events, as GraphQL returns it. */
function forcePushPage(
  nodes: { createdAt: string; beforeCommit: unknown; afterCommit: unknown }[],
  endCursor: string | null = null,
) {
  return {
    json: {
      data: {
        repository: {
          pullRequest: {
            timelineItems: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes },
          },
        },
      },
    },
  };
}

describe('listForcePushes', () => {
  it('maps each force-push to the heads it replaced and made', async () => {
    const { client, requests } = makeTransport([
      forcePushPage([
        { createdAt: PUSHED_AFTER, beforeCommit: { oid: OLD_SHA }, afterCommit: { oid: HEAD_SHA } },
      ]),
    ]);

    const pushes = await client.listForcePushes(7);

    expect([requests[0]?.url, requests[0]?.body, pushes]).toEqual([
      'https://api.github.com/graphql',
      expect.objectContaining({
        variables: { owner: 'rmartz', repo: 'pr-lifecycle', pr: 7, cursor: null },
      }),
      [{ headSha: HEAD_SHA, beforeSha: OLD_SHA, pushedAt: PUSHED_AFTER }],
    ]);
  });

  it('reads a force-push without commits as unattributed', async () => {
    const { client } = makeTransport([
      forcePushPage([{ createdAt: PUSHED_AFTER, beforeCommit: null, afterCommit: null }]),
    ]);

    expect(await client.listForcePushes(7)).toEqual([
      { headSha: undefined, beforeSha: undefined, pushedAt: PUSHED_AFTER },
    ]);
  });

  it('follows the cursor to the next page', async () => {
    const node = { createdAt: PUSHED_AFTER, beforeCommit: null, afterCommit: { oid: HEAD_SHA } };
    const { client, requests } = makeTransport([
      forcePushPage([node], 'cursor-1'),
      forcePushPage([node]),
    ]);

    const pushes = await client.listForcePushes(7);
    const second = requests[1]?.body as { variables: { cursor: unknown } } | undefined;

    expect([pushes.length, second?.variables.cursor]).toEqual([2, 'cursor-1']);
  });

  it('fails when the pull request is missing', async () => {
    const { client } = makeTransport([{ json: { data: { repository: { pullRequest: null } } } }]);

    await expect(client.listForcePushes(7)).rejects.toThrow('pull request #7 not found');
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
