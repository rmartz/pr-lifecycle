import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli.js';
import { GitHubApiError } from '../../src/github/client.js';
import { reconcilePullRequest } from '../../src/github/reconcile.js';
import { UAT_LABELS } from '../../src/uat.js';
import { makeDeps, makeIo, makeSourceClient, RECONCILE } from '../cli-fixtures.js';
import { makePullRequestData } from './fake-client.js';

// The UAT label invariant at the edge: the PR kinds and run conditions that
// could skip the label (a fork, Dependabot, a draft, no release token, a failed
// read) still leave exactly one UAT label.

const ON = { uat: 'on' } as const;

function uatLabels(labels: readonly string[]): string[] {
  return labels.filter((name) => UAT_LABELS.some((label) => label === name));
}

describe('reconcilePullRequest — exactly one UAT label', () => {
  it.each([
    ['a fork PR', { isCrossRepository: true }],
    ['a Dependabot PR', { authorLogin: 'dependabot[bot]', headRef: 'dependabot/npm/a' }],
    ['a draft', { draft: true }],
    ['a [WIP] PR', { title: '[WIP] feat: a' }],
    ['a PR with a merge conflict', { mergeable: false }],
  ])('labels %s', async (_kind, overrides) => {
    const client = makeSourceClient(makePullRequestData(overrides));

    await reconcilePullRequest(client, 7, ON);

    expect(uatLabels(client.pull.labels)).toHaveLength(1);
  });

  it('labels a PR without a release token', async () => {
    const client = makeSourceClient();

    await reconcilePullRequest(client, 7, ON, { release: 'unavailable' });

    expect(uatLabels(client.pull.labels)).toEqual(['UAT pending']);
  });

  it('records no UAT needed with UAT off', async () => {
    const client = makeSourceClient();

    await reconcilePullRequest(client, 7, { uat: 'off' });

    expect(uatLabels(client.pull.labels)).toEqual(['no UAT needed']);
  });

  it('still labels a docs PR when the changed files can’t be read', async () => {
    const client = makeSourceClient(makePullRequestData({ title: 'docs: a' }));
    client.failNext('listPullRequestFiles', new GitHubApiError(404, 'not found'));

    await reconcilePullRequest(client, 7, ON);

    // A docs title is statically safe without its paths.
    expect(uatLabels(client.pull.labels)).toEqual(['no UAT needed']);
  });

  it('fails closed to UAT pending when a feature PR’s files can’t be read', async () => {
    const client = makeSourceClient();
    client.failNext('listPullRequestFiles', new GitHubApiError(404, 'not found'));

    await reconcilePullRequest(client, 7, ON);

    expect(uatLabels(client.pull.labels)).toEqual(['UAT pending']);
  });

  it('still labels when the head’s statuses can’t be read', async () => {
    const client = makeSourceClient();
    client.failNext('listStatuses', new GitHubApiError(403, 'forbidden'));

    await reconcilePullRequest(client, 7, ON);

    expect(uatLabels(client.pull.labels)).toEqual(['UAT pending']);
  });

  it('still fails the run on a transient failure, so it is retried', async () => {
    const client = makeSourceClient();
    client.failNext(
      'listPullRequestFiles',
      new GitHubApiError(503, 'unavailable', { transient: true }),
    );

    await expect(reconcilePullRequest(client, 7, ON)).rejects.toThrow('unavailable');
  });
});

describe('runCli — exactly one UAT label', () => {
  it('labels a PR with only GITHUB_TOKEN set', async () => {
    const client = makeSourceClient();

    await runCli(RECONCILE, makeIo().io, makeDeps(client, { GITHUB_TOKEN: 't0k' }).deps);

    expect(uatLabels(client.pull.labels)).toEqual(['UAT pending']);
  });
});
