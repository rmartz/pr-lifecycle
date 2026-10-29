import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli.js';
import { reconcilePullRequest } from '../../src/github/reconcile.js';
import { makeDeps, makeIo, makeSourceClient, RECONCILE } from '../cli-fixtures.js';
import { HEAD_SHA, makeDimensionedVerdictBody } from '../fixtures.js';
import { FakeGitHubClient, makePullRequestData, makeReviewData } from './fake-client.js';

// UAT labels at the edge: they are for people, so every write uses the workflow
// token, with or without a real-actor token configured. The decision reaches
// pr-policy through the sign-off status instead (#119).

const ON = { uat: 'on' } as const;
const NO_RELEASE_TOKEN = { GITHUB_TOKEN: 't0k' };

/** A docs PR whose review recorded that it needs no UAT, and no code verdict yet. */
function makeWaivedClient() {
  const client = makeSourceClient(makePullRequestData({ title: 'docs: explain a thing' }));
  client.reviews = [
    makeReviewData({
      body: makeDimensionedVerdictBody({ uat: 'not-needed' }),
      submittedAt: '2026-10-19T10:30:00Z',
    }),
  ];
  client.permissions.set('maintainer', { permission: 'write', roleName: 'write' });
  return client;
}

/** A feature PR whose `no UAT needed` a trusted person applied before the last push. */
function makeStaleWaiverClient() {
  const client = makeSourceClient(makePullRequestData({ labels: ['no UAT needed'] }));
  client.permissions.set('rmartz', { permission: 'admin', roleName: 'admin' });
  client.labelApplications.set('no UAT needed', [
    { login: 'rmartz', type: 'User', appliedAt: '2026-10-19T09:00:00Z' },
  ]);
  client.checkSuites.set(HEAD_SHA, [
    { headBranch: 'feature/thing', createdAt: '2026-10-19T10:00:00Z' },
  ]);
  return client;
}

function makeTokenDeps(main: FakeGitHubClient, release: FakeGitHubClient) {
  return {
    env: { GITHUB_TOKEN: 't0k', PR_LIFECYCLE_TOKEN: 'r3l' },
    createClient: (options: { token: string }) => (options.token === 'r3l' ? release : main),
    git: { run: () => Promise.reject(new Error('git must not run in CLI tests')) },
  };
}

describe('reconcilePullRequest — UAT labels', () => {
  it('applies no UAT needed when the review waives UAT', async () => {
    const client = makeWaivedClient();

    const result = await reconcilePullRequest(client, 7, ON);

    expect([result.plan.uat, client.pull.labels]).toEqual([
      'waived-by-review',
      ['review requested', 'no UAT needed'],
    ]);
  });

  it('applies UAT pending to a PR that could be user-facing', async () => {
    const client = makeSourceClient();

    await reconcilePullRequest(client, 7, ON);

    expect(client.pull.labels).toEqual(['review requested', 'UAT pending']);
  });

  it('replaces a stale trusted waiver with UAT pending', async () => {
    const client = makeStaleWaiverClient();

    await reconcilePullRequest(client, 7, ON);

    expect(client.pull.labels).toEqual(['review requested', 'UAT pending']);
  });

  it('converges: a second reconcile writes nothing', async () => {
    const client = makeSourceClient();
    await reconcilePullRequest(client, 7, ON);
    const writesBefore = client.writes.length;

    await reconcilePullRequest(client, 7, ON);

    expect(client.writes.length).toBe(writesBefore);
  });
});

describe('runCli — UAT labels', () => {
  it('labels every PR no UAT needed with --uat off', async () => {
    const client = makeSourceClient();

    await runCli([...RECONCILE, '--uat', 'off'], makeIo().io, makeDeps(client).deps);

    expect(client.pull.labels).toEqual(['review requested', 'no UAT needed']);
  });

  it('applies no UAT needed without a release token', async () => {
    const client = makeWaivedClient();

    await runCli(RECONCILE, makeIo().io, makeDeps(client, NO_RELEASE_TOKEN).deps);

    expect(client.pull.labels).toEqual(['review requested', 'no UAT needed']);
  });

  it('never uses the release token for a UAT label, adding or removing', async () => {
    const main = makeStaleWaiverClient();
    const release = new FakeGitHubClient();

    await runCli(RECONCILE, makeIo().io, makeTokenDeps(main, release));

    expect([
      release.calls.filter((call) => call.method !== 'createCommitStatus'),
      main.pull.labels,
    ]).toEqual([[], ['review requested', 'UAT pending']]);
  });

  it('reports the UAT outcome in --json', async () => {
    const { out, io } = makeIo();

    await runCli([...RECONCILE, '--json'], io, makeDeps(makeWaivedClient()).deps);

    const json = JSON.parse(out[0] ?? '{}') as Record<string, unknown>;
    expect([json['uat'], 'uatWaiverSkipped' in json]).toEqual([
      { outcome: 'waived-by-review', label: 'no UAT needed' },
      false,
    ]);
  });
});
