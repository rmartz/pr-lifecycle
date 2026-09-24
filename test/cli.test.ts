import { describe, expect, it } from 'vitest';

import type { CliDeps } from '../src/cli.js';
import { runCli, USAGE } from '../src/cli.js';
import { GitHubApiError } from '../src/github/client.js';
import type { HttpClientOptions } from '../src/github/http-client.js';
import { COPILOT_REVIEWER_LOGIN } from '../src/state.js';
import { makeVerdictBody } from './fixtures.js';
import { FakeGitHubClient, makePullRequestData, makeReviewData } from './github/fake-client.js';

const RECONCILE = ['reconcile', '--repo', 'rmartz/demo', '--pr', '7'];

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) },
  };
}

function makeApprovedClient() {
  const client = new FakeGitHubClient(makePullRequestData(), [
    makeReviewData({ id: 1, login: COPILOT_REVIEWER_LOGIN, type: 'Bot' }),
    makeReviewData({ id: 2, body: makeVerdictBody('approved') }),
  ]);
  client.permissions.set('maintainer', { permission: 'write', roleName: 'write' });
  return client;
}

function makeDeps(client: FakeGitHubClient, env: CliDeps['env'] = { GITHUB_TOKEN: 't0k' }) {
  const created: HttpClientOptions[] = [];
  const deps: CliDeps = {
    env,
    createClient: (options) => {
      created.push(options);
      return client;
    },
  };
  return { deps, created };
}

describe('runCli — help and usage', () => {
  it('prints usage and exits 0 for help', async () => {
    const { out, io } = makeIo();

    const code = await runCli(['help'], io, makeDeps(new FakeGitHubClient()).deps);

    expect([code, out]).toEqual([0, [USAGE]]);
  });

  it('exits 2 on a usage error and names it on stderr', async () => {
    const { err, io } = makeIo();

    const code = await runCli(['frobnicate'], io, makeDeps(new FakeGitHubClient()).deps);

    expect([code, err[0]]).toEqual([2, 'Unknown command: frobnicate']);
  });

  it('exits 2 when GITHUB_TOKEN is missing, without touching GitHub', async () => {
    const { err, io } = makeIo();
    const { deps, created } = makeDeps(new FakeGitHubClient(), {});

    const code = await runCli(RECONCILE, io, deps);

    expect([code, err[0], created.length]).toEqual([2, 'GITHUB_TOKEN is not set', 0]);
  });
});

describe('runCli — reconcile', () => {
  it('builds the client from the token, repo, and API URL', async () => {
    const { deps, created } = makeDeps(new FakeGitHubClient(), {
      GITHUB_TOKEN: 't0k',
      GITHUB_API_URL: 'https://ghe.example.com/api/v3',
    });

    await runCli(RECONCILE, makeIo().io, deps);

    expect(created).toEqual([
      { token: 't0k', owner: 'rmartz', repo: 'demo', apiUrl: 'https://ghe.example.com/api/v3' },
    ]);
  });

  it('omits an empty GITHUB_API_URL so the client uses github.com', async () => {
    const { deps, created } = makeDeps(new FakeGitHubClient(), {
      GITHUB_TOKEN: 't0k',
      GITHUB_API_URL: '',
    });

    await runCli(RECONCILE, makeIo().io, deps);

    expect(created[0]).toEqual({ token: 't0k', owner: 'rmartz', repo: 'demo' });
  });

  it('applies the plan and exits 0', async () => {
    const client = makeApprovedClient();

    const code = await runCli(
      [...RECONCILE, '--arm-auto-merge'],
      makeIo().io,
      makeDeps(client).deps,
    );

    expect([code, client.pull.labels, client.pull.autoMergeEnabled]).toEqual([
      0,
      ['approved', 'auto-merge enabled'],
      true,
    ]);
  });

  it('passes --trusted-authors through to the policy', async () => {
    const client = makeApprovedClient();

    await runCli(
      [...RECONCILE, '--trusted-authors', 'someone-else'],
      makeIo().io,
      makeDeps(client).deps,
    );

    expect(client.pull.labels).toEqual(['review requested']);
  });

  it('passes --skip-copilot-review through to the policy', async () => {
    const client = new FakeGitHubClient();

    await runCli([...RECONCILE, '--skip-copilot-review'], makeIo().io, makeDeps(client).deps);

    expect(client.pull.labels).toEqual(['review requested']);
  });

  it('writes nothing with --dry-run', async () => {
    const client = makeApprovedClient();

    await runCli(
      [...RECONCILE, '--dry-run', '--arm-auto-merge'],
      makeIo().io,
      makeDeps(client).deps,
    );

    expect(client.writes).toEqual([]);
  });

  it('prints a one-line summary', async () => {
    const { out, io } = makeIo();

    await runCli([...RECONCILE, '--arm-auto-merge'], io, makeDeps(makeApprovedClient()).deps);

    expect(out).toEqual([
      'rmartz/demo#7 → approved: +approved, +auto-merge enabled, auto-merge arm (bot: not a recognized bot PR)',
    ]);
  });

  it('lists removed labels and a disarm in the summary', async () => {
    const client = new FakeGitHubClient(
      makePullRequestData({ labels: ['approved', 'auto-merge enabled'], autoMergeEnabled: true }),
    );
    const { out, io } = makeIo();

    await runCli([...RECONCILE, '--arm-auto-merge'], io, makeDeps(client).deps);

    expect(out).toEqual([
      'rmartz/demo#7 → awaiting-copilot: -approved, -auto-merge enabled, auto-merge disarm (bot: not a recognized bot PR)',
    ]);
  });

  it('marks a dry-run summary', async () => {
    const { out, io } = makeIo();

    await runCli([...RECONCILE, '--dry-run'], io, makeDeps(new FakeGitHubClient()).deps);

    expect(out).toEqual([
      '[dry-run] rmartz/demo#7 → awaiting-copilot: no changes (bot: not a recognized bot PR)',
    ]);
  });

  it('exits 1 on a GitHub failure and reports it on stderr only', async () => {
    const client = new FakeGitHubClient();
    client.failNext('getPullRequest', new GitHubApiError(502, 'bad gateway'));
    const { out, err, io } = makeIo();

    const code = await runCli([...RECONCILE, '--json'], io, makeDeps(client).deps);

    expect([code, out, err]).toEqual([1, [], ['reconcile failed for rmartz/demo#7: bad gateway']]);
  });
});

describe('runCli — --json contract (schemaVersion 1)', () => {
  // This pins the whole shape consumed by rmartz/pr-lifecycle-action. Renaming,
  // removing, or retyping a field is a breaking change (bump SCHEMA_VERSION and
  // mark the PR breaking); adding one is not — extend this expectation.
  it('prints exactly one JSON object with every field present', async () => {
    const { out, io } = makeIo();

    await runCli(
      [...RECONCILE, '--json', '--arm-auto-merge'],
      io,
      makeDeps(makeApprovedClient()).deps,
    );

    expect(out.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        schemaVersion: 1,
        repo: 'rmartz/demo',
        pr: 7,
        dryRun: false,
        state: 'approved',
        addLabels: ['approved', 'auto-merge enabled'],
        removeLabels: [],
        autoMerge: 'arm',
        botEligibility: {
          eligible: false,
          reason: 'not a recognized bot PR',
          prType: null,
          updateType: null,
        },
      },
    ]);
  });

  it('reports bot eligibility with its type and update type', async () => {
    const client = new FakeGitHubClient(
      makePullRequestData({ authorLogin: 'dependabot[bot]', headRef: 'dependabot/x' }),
    );
    client.commits = [
      {
        authorLogin: 'dependabot[bot]',
        message: '---\nupdated-dependencies:\n  update-type: version-update:semver-minor\n...',
      },
    ];
    const { out, io } = makeIo();

    await runCli([...RECONCILE, '--json', '--dry-run'], io, makeDeps(client).deps);

    expect((JSON.parse(out[0] ?? '') as { botEligibility: unknown }).botEligibility).toEqual({
      eligible: true,
      reason: 'Dependabot version-update:semver-minor — eligible',
      prType: 'dependabot',
      updateType: 'version-update:semver-minor',
    });
  });
});
