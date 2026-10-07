import { describe, expect, it } from 'vitest';

import { gatherFacts } from '../../src/github/gather.js';
import { reconcilePullRequest } from '../../src/github/reconcile.js';
import { makeVerdictBody } from '../fixtures.js';
import { FakeGitHubClient, makePullRequestData, makeReviewData } from './fake-client.js';
import { makeTransport } from './http-fake.js';

// A person resolves an escalation by removing `escalation needed` (#79). These
// cover the edge: reading the removals, and a full reconcile honouring them.

const ESCALATION_REVIEW = makeReviewData({ id: 5, body: makeVerdictBody('escalation-needed') });
const AFTER_ESCALATION = '2026-09-23T15:00:00Z';

function makeEscalatedClient(pull = makePullRequestData()) {
  const client = new FakeGitHubClient(pull, [ESCALATION_REVIEW]);
  client.permissions.set('maintainer', { permission: 'write', roleName: 'write' });
  return client;
}

describe('listLabelRemovals', () => {
  it('maps only the removals of the named label from the issue events', async () => {
    const { client, requests } = makeTransport([
      {
        json: [
          {
            event: 'unlabeled',
            created_at: '2026-09-23T10:00:00Z',
            actor: { login: 'rmartz', type: 'User' },
            label: { name: 'escalation needed' },
          },
          {
            event: 'labeled',
            created_at: '2026-09-23T11:00:00Z',
            actor: { login: 'rmartz', type: 'User' },
            label: { name: 'escalation needed' },
          },
          {
            event: 'unlabeled',
            created_at: '2026-09-23T12:00:00Z',
            actor: { login: 'rmartz', type: 'User' },
            label: { name: 'approved' },
          },
        ],
      },
    ]);

    const removals = await client.listLabelRemovals(7, 'escalation needed');

    expect([requests[0]?.url, removals]).toEqual([
      'https://api.github.com/repos/rmartz/demo/issues/7/events?per_page=100&page=1',
      [{ login: 'rmartz', type: 'User', removedAt: '2026-09-23T10:00:00Z' }],
    ]);
  });

  it('reads a removal by a deleted account as an untrusted bot', async () => {
    const { client } = makeTransport([
      {
        json: [
          {
            event: 'unlabeled',
            created_at: '2026-09-23T10:00:00Z',
            actor: null,
            label: { name: 'escalation needed' },
          },
        ],
      },
    ]);

    expect(await client.listLabelRemovals(7, 'escalation needed')).toEqual([
      { login: undefined, type: 'Bot', removedAt: '2026-09-23T10:00:00Z' },
    ]);
  });
});

describe('gatherFacts — escalation removals', () => {
  it('skips the issue events when no review is an escalation verdict', async () => {
    const client = new FakeGitHubClient(makePullRequestData(), [
      makeReviewData({ body: makeVerdictBody('approved') }),
    ]);

    const { facts } = await gatherFacts(client, 7);

    expect([
      client.calls.some((call) => call.method === 'listLabelRemovals'),
      facts.escalationRemovals,
    ]).toEqual([false, []]);
  });

  it('gathers the removals with each remover’s permission', async () => {
    const client = makeEscalatedClient();
    client.permissions.set('triager', { permission: 'read', roleName: 'triage' });
    client.labelRemovals.set('escalation needed', [
      { login: 'triager', type: 'User', removedAt: '2026-09-23T13:00:00Z' },
      { login: 'maintainer', type: 'User', removedAt: AFTER_ESCALATION },
    ]);

    const { facts } = await gatherFacts(client, 7);

    expect(facts.escalationRemovals).toEqual([
      {
        actor: { login: 'triager', type: 'User', permission: 'triage' },
        removedAt: '2026-09-23T13:00:00Z',
      },
      {
        actor: { login: 'maintainer', type: 'User', permission: 'write' },
        removedAt: AFTER_ESCALATION,
      },
    ]);
  });
});

describe('reconcilePullRequest — escalation resolved by removing its label', () => {
  it('sends the PR back to review instead of re-applying the label', async () => {
    const client = makeEscalatedClient();
    client.labelRemovals.set('escalation needed', [
      { login: 'maintainer', type: 'User', removedAt: AFTER_ESCALATION },
    ]);

    const { plan } = await reconcilePullRequest(client, 7, {});

    expect([plan.state, client.pull.labels]).toEqual(['review-requested', ['review requested']]);
  });

  it('re-applies the label when the remover is not trusted', async () => {
    const client = makeEscalatedClient();
    client.labelRemovals.set('escalation needed', [
      { login: 'github-actions[bot]', type: 'Bot', removedAt: AFTER_ESCALATION },
    ]);

    const { plan } = await reconcilePullRequest(client, 7, {});

    expect([plan.state, client.pull.labels]).toEqual(['escalation-needed', ['escalation needed']]);
  });

  // rmartz/pr-lifecycle-action#35: an eligible Dependabot bump whose escalation a
  // person resolved is approved and armed like any other eligible bump.
  it('approves an eligible bot PR once its escalation is resolved', async () => {
    const client = makeEscalatedClient(
      makePullRequestData({ authorLogin: 'dependabot[bot]', headRef: 'dependabot/x' }),
    );
    client.commits = [
      {
        authorLogin: 'dependabot[bot]',
        message: '---\nupdated-dependencies:\n  update-type: version-update:semver-minor\n...',
      },
    ];
    client.labelRemovals.set('escalation needed', [
      { login: 'maintainer', type: 'User', removedAt: AFTER_ESCALATION },
    ]);

    const { plan } = await reconcilePullRequest(client, 7, { armAutoMerge: true });

    expect([plan.state, client.pull.autoMergeEnabled]).toEqual(['approved', true]);
  });
});
