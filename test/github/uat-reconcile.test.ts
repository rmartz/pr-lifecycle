import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli.js';
import { executePlan } from '../../src/github/execute.js';
import { reconcilePullRequest } from '../../src/github/reconcile.js';
import { buildTokenAdvisoryBody, TOKEN_ADVISORY_MARKER } from '../../src/github/token-advisory.js';
import type { ReconcilePlan } from '../../src/plan.js';
import { makeDeps, makeIo, makeSourceClient, RECONCILE } from '../cli-fixtures.js';
import { HEAD_SHA } from '../fixtures.js';
import { FakeGitHubClient, makePullRequestData } from './fake-client.js';

// UAT label writes at the edge: which token writes them, and the fail-closed
// path when no real-actor token is configured.

const ON = { uat: 'on' } as const;
const NO_RELEASE_TOKEN = { GITHUB_TOKEN: 't0k' };
const TARGET = { pr: 7, nodeId: 'PR_node', headSha: HEAD_SHA };

function makePlan(overrides: Partial<ReconcilePlan> = {}): ReconcilePlan {
  return {
    state: 'review-requested',
    addLabels: [],
    removeLabels: [],
    autoMerge: 'none',
    update: 'none',
    ...overrides,
  };
}

function makeDocsClient() {
  return new FakeGitHubClient(makePullRequestData({ title: 'docs: explain a thing' }));
}

describe('executePlan — UAT label writes', () => {
  it('adds UAT labels with the UAT writer and lifecycle labels with the client', async () => {
    const client = new FakeGitHubClient();
    const writer = new FakeGitHubClient();
    const plan = makePlan({ addLabels: ['review requested', 'UAT pending'] });

    await executePlan(client, TARGET, plan, client, writer);

    expect([client.writes.filter((call) => call.method === 'addLabels'), writer.calls]).toEqual([
      [{ method: 'addLabels', args: [7, ['review requested']] }],
      [{ method: 'addLabels', args: [7, ['UAT pending']] }],
    ]);
  });

  it('removes UAT labels with the UAT writer', async () => {
    const client = new FakeGitHubClient(makePullRequestData({ labels: ['approved'] }));
    const writer = new FakeGitHubClient(makePullRequestData({ labels: ['UAT passed'] }));
    const plan = makePlan({ removeLabels: ['approved', 'UAT passed'] });

    await executePlan(client, TARGET, plan, client, writer);

    expect([client.pull.labels, writer.pull.labels]).toEqual([[], []]);
  });

  it('creates a missing UAT label with the client before the writer applies it', async () => {
    const client = new FakeGitHubClient();
    const writer = new FakeGitHubClient();

    await executePlan(client, TARGET, makePlan({ addLabels: ['UAT ready'] }), client, writer);

    expect(client.repoLabels.get('UAT ready')?.color).toBe('22D3EE');
  });
});

describe('reconcilePullRequest — UAT writer', () => {
  it('applies no UAT needed to an exempt PR with the UAT writer', async () => {
    const client = makeDocsClient();
    const writer = new FakeGitHubClient();

    const result = await reconcilePullRequest(client, 7, ON, { uatWrites: writer });

    expect([result.plan.uat, writer.calls, result.skippedUatWaiver]).toEqual([
      'exempt-title',
      [{ method: 'addLabels', args: [7, ['no UAT needed']] }],
      false,
    ]);
  });

  it('never applies no UAT needed without a UAT writer, and reports the skip', async () => {
    const client = makeDocsClient();

    const result = await reconcilePullRequest(client, 7, ON, { uatWrites: 'unavailable' });

    expect([client.pull.labels, result.plan.addLabels, result.skippedUatWaiver]).toEqual([
      ['review requested'],
      ['review requested'],
      true,
    ]);
  });

  it('still applies UAT pending without a UAT writer, with the client', async () => {
    const client = makeSourceClient();

    const result = await reconcilePullRequest(client, 7, ON, { uatWrites: 'unavailable' });

    expect([client.pull.labels, result.skippedUatWaiver]).toEqual([
      ['review requested', 'UAT pending'],
      false,
    ]);
  });

  it('still removes a stale UAT passed without a UAT writer', async () => {
    const client = makeSourceClient(makePullRequestData({ labels: ['UAT passed'] }));

    await reconcilePullRequest(client, 7, ON, { uatWrites: 'unavailable' });

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

describe('runCli — UAT', () => {
  it('labels every PR no UAT needed with --uat off', async () => {
    const client = makeSourceClient();

    await runCli([...RECONCILE, '--uat', 'off'], makeIo().io, makeDeps(client).deps);

    expect(client.pull.labels).toEqual(['review requested', 'no UAT needed']);
  });

  it('warns when no UAT needed is skipped for want of a token', async () => {
    const { err, io } = makeIo();

    await runCli(RECONCILE, io, makeDeps(makeDocsClient(), NO_RELEASE_TOKEN).deps);

    expect(err).toEqual([
      "warning: rmartz/demo#7 needs no UAT, but 'no UAT needed' was not applied: PR_LIFECYCLE_TOKEN is not set",
    ]);
  });

  it('posts the token advisory for the skipped waiver', async () => {
    const client = makeDocsClient();

    await runCli(RECONCILE, makeIo().io, makeDeps(client, NO_RELEASE_TOKEN).deps);

    expect(client.comments).toEqual([buildTokenAdvisoryBody('uat-waiver')]);
  });

  it('reports the skipped waiver in --json and the summary', async () => {
    const json = makeIo();
    const summary = makeIo();

    await runCli(
      [...RECONCILE, '--json'],
      json.io,
      makeDeps(makeDocsClient(), NO_RELEASE_TOKEN).deps,
    );
    await runCli(RECONCILE, summary.io, makeDeps(makeDocsClient(), NO_RELEASE_TOKEN).deps);

    expect([
      (JSON.parse(json.out[0] ?? '{}') as { uat: unknown; uatWaiverSkipped: unknown }).uat,
      (JSON.parse(json.out[0] ?? '{}') as { uatWaiverSkipped: unknown }).uatWaiverSkipped,
      summary.out[0],
    ]).toEqual([
      { outcome: 'exempt-title', label: 'no UAT needed' },
      { reason: 'token-missing' },
      "rmartz/demo#7 → review-requested: +review requested, 'no UAT needed' skipped (no release token) (bot: not a recognized bot PR)",
    ]);
  });
});

describe('buildTokenAdvisoryBody — UAT waiver', () => {
  it('names the skipped waiver under the shared marker', () => {
    const body = buildTokenAdvisoryBody('uat-waiver');

    expect([
      body.startsWith(TOKEN_ADVISORY_MARKER),
      body.includes('`no UAT needed` skipped'),
    ]).toEqual([true, true]);
  });
});
