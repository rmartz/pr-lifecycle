import { describe, expect, it } from 'vitest';

import { GitHubApiError } from '../../src/github/client.js';
import { executePlan } from '../../src/github/execute.js';
import { OWNED_LABEL_DEFINITIONS } from '../../src/github/label-roster.js';
import type { ReconcilePlan } from '../../src/plan.js';
import { HEAD_SHA } from '../fixtures.js';
import { FakeGitHubClient, makePullRequestData } from './fake-client.js';

const TARGET = { pr: 7, nodeId: 'PR_node', headSha: HEAD_SHA };

function makePlan(overrides: Partial<ReconcilePlan> = {}): ReconcilePlan {
  return {
    state: 'review-requested',
    addLabels: [],
    removeLabels: [],
    autoMerge: 'none',
    update: 'none',
    uatGate: undefined,
    ...overrides,
  };
}

function makeClient(labels: string[] = []) {
  const client = new FakeGitHubClient(makePullRequestData({ labels }));
  for (const label of Object.values(OWNED_LABEL_DEFINITIONS)) {
    client.repoLabels.set(label.name, label);
  }
  return client;
}

describe('executePlan', () => {
  it('makes no API calls for an empty plan', async () => {
    const client = makeClient();

    await executePlan(client, TARGET, makePlan());

    expect(client.calls).toEqual([]);
  });

  it('removes each label in the plan', async () => {
    const client = makeClient(['approved', 'changes requested']);

    await executePlan(
      client,
      TARGET,
      makePlan({ removeLabels: ['approved', 'changes requested'] }),
    );

    expect(client.pull.labels).toEqual([]);
  });

  it('tolerates removing a label that is already gone', async () => {
    const client = makeClient();

    await expect(
      executePlan(client, TARGET, makePlan({ removeLabels: ['approved'] })),
    ).resolves.toBeUndefined();
  });

  it('propagates a label-removal error other than 404', async () => {
    const client = makeClient(['approved']);
    client.failNext('removeLabel', new GitHubApiError(500, 'server error'));

    await expect(
      executePlan(client, TARGET, makePlan({ removeLabels: ['approved'] })),
    ).rejects.toThrow('server error');
  });

  it('adds the planned labels', async () => {
    const client = makeClient();

    await executePlan(client, TARGET, makePlan({ addLabels: ['review requested'] }));

    expect(client.pull.labels).toEqual(['review requested']);
  });

  it('creates a missing owned label with its roster definition before adding it', async () => {
    const client = new FakeGitHubClient();

    await executePlan(client, TARGET, makePlan({ addLabels: ['approved'] }));

    expect(client.repoLabels.get('approved')).toEqual(OWNED_LABEL_DEFINITIONS.approved);
  });

  it('does not recreate a label the repo already has', async () => {
    const client = makeClient();

    await executePlan(client, TARGET, makePlan({ addLabels: ['approved'] }));

    expect(client.calls.some((call) => call.method === 'createLabel')).toBe(false);
  });

  it('tolerates a concurrent run creating the label first (422)', async () => {
    const client = new FakeGitHubClient();
    client.failNext('createLabel', new GitHubApiError(422, 'already_exists'));

    await executePlan(client, TARGET, makePlan({ addLabels: ['approved'] }));

    expect(client.pull.labels).toEqual(['approved']);
  });

  it('propagates a label-creation error other than 422', async () => {
    const client = new FakeGitHubClient();
    client.failNext('createLabel', new GitHubApiError(403, 'forbidden'));

    await expect(
      executePlan(client, TARGET, makePlan({ addLabels: ['approved'] })),
    ).rejects.toThrow('forbidden');
  });

  it('arms auto-merge on the PR node, bound to the planned head', async () => {
    const client = makeClient();

    await executePlan(client, TARGET, makePlan({ autoMerge: 'arm' }));

    expect(client.calls).toEqual([{ method: 'enableAutoMerge', args: ['PR_node', HEAD_SHA] }]);
  });

  it('merges the PR node directly, bound to the planned head', async () => {
    const client = makeClient();

    await executePlan(client, TARGET, makePlan({ autoMerge: 'merge' }));

    expect(client.calls).toEqual([{ method: 'mergePullRequest', args: ['PR_node', HEAD_SHA] }]);
  });

  it('disarms auto-merge on the PR node', async () => {
    const client = makeClient();

    await executePlan(client, TARGET, makePlan({ autoMerge: 'disarm' }));

    expect(client.calls).toEqual([{ method: 'disableAutoMerge', args: ['PR_node'] }]);
  });

  it('disarms before touching labels', async () => {
    const client = makeClient(['approved', 'auto-merge enabled']);

    await executePlan(
      client,
      TARGET,
      makePlan({
        removeLabels: ['approved', 'auto-merge enabled'],
        addLabels: ['review requested'],
        autoMerge: 'disarm',
      }),
    );

    expect(client.writes.map((call) => call.method)).toEqual([
      'disableAutoMerge',
      'removeLabel',
      'removeLabel',
      'addLabels',
    ]);
  });

  it('arms only after the labels are written', async () => {
    const client = makeClient(['review requested']);

    await executePlan(
      client,
      TARGET,
      makePlan({
        removeLabels: ['review requested'],
        addLabels: ['approved', 'auto-merge enabled'],
        autoMerge: 'arm',
      }),
    );

    expect(client.writes.map((call) => call.method)).toEqual([
      'removeLabel',
      'addLabels',
      'enableAutoMerge',
    ]);
  });

  it('does not arm when an earlier write fails', async () => {
    const client = makeClient();
    client.failNext('addLabels', new GitHubApiError(500, 'server error'));

    await expect(
      executePlan(client, TARGET, makePlan({ addLabels: ['approved'], autoMerge: 'arm' })),
    ).rejects.toThrow('server error');
    expect(client.pull.autoMergeEnabled).toBe(false);
  });
});

describe('executePlan — release actions', () => {
  it('arms through the release actions, never the main client', async () => {
    const client = makeClient();
    const release = makeClient();

    await executePlan(client, TARGET, makePlan({ autoMerge: 'arm' }), release);

    expect([client.writes, release.calls.map((call) => call.method)]).toEqual([
      [],
      ['enableAutoMerge'],
    ]);
  });

  it('merges through the release actions, never the main client', async () => {
    const client = makeClient();
    const release = makeClient();

    await executePlan(client, TARGET, makePlan({ autoMerge: 'merge' }), release);

    expect([client.writes, release.calls.map((call) => call.method)]).toEqual([
      [],
      ['mergePullRequest'],
    ]);
  });

  it('disarms with the main client, since any token may disarm', async () => {
    const client = makeClient();
    const release = makeClient();

    await executePlan(client, TARGET, makePlan({ autoMerge: 'disarm' }), release);

    expect([client.writes.map((call) => call.method), release.calls]).toEqual([
      ['disableAutoMerge'],
      [],
    ]);
  });

  // The PR became mergeable between the read and the arm: merge it, as gh does.
  it('merges, bound to the same head, when arming finds the PR already clean', async () => {
    const client = makeClient();
    client.failNext(
      'enableAutoMerge',
      new GitHubApiError(200, 'GraphQL error: Pull request is in clean status'),
    );

    await executePlan(client, TARGET, makePlan({ autoMerge: 'arm' }));

    expect(client.calls).toEqual([
      { method: 'enableAutoMerge', args: ['PR_node', HEAD_SHA] },
      { method: 'mergePullRequest', args: ['PR_node', HEAD_SHA] },
    ]);
  });

  // A moved head means unreviewed commits: never retry, never merge.
  it('propagates any other arming error without merging', async () => {
    const client = makeClient();
    client.failNext(
      'enableAutoMerge',
      new GitHubApiError(200, 'GraphQL error: Head branch was modified. Review and try again.'),
    );

    await expect(executePlan(client, TARGET, makePlan({ autoMerge: 'arm' }))).rejects.toThrow(
      'Head branch was modified',
    );
    expect(client.calls.map((call) => call.method)).toEqual(['enableAutoMerge']);
  });

  it('propagates a rejected direct merge', async () => {
    const client = makeClient();
    client.failNext('mergePullRequest', new GitHubApiError(200, 'GraphQL error: Head moved'));

    await expect(executePlan(client, TARGET, makePlan({ autoMerge: 'merge' }))).rejects.toThrow(
      'Head moved',
    );
  });
});
