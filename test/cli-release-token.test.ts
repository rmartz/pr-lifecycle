import { describe, expect, it } from 'vitest';

import type { CliDeps } from '../src/cli.js';
import { runCli } from '../src/cli.js';
import { GitHubApiError } from '../src/github/client.js';
import { TOKEN_ADVISORY_MARKER } from '../src/github/token-advisory.js';
import { makeApprovedClient, makeDeps, makeIo, RECONCILE } from './cli-fixtures.js';
import { FakeGitHubClient } from './github/fake-client.js';

const ARM = [...RECONCILE, '--arm-auto-merge'];
const NO_RELEASE_TOKEN = { GITHUB_TOKEN: 't0k' };

/** Deps giving each token its own fake, to see which token each call used. */
function makeTokenDeps(main: FakeGitHubClient, release: FakeGitHubClient): CliDeps {
  return {
    env: { GITHUB_TOKEN: 't0k', PR_LIFECYCLE_TOKEN: 'r3l' },
    createClient: (options) => (options.token === 'r3l' ? release : main),
    git: { run: () => Promise.reject(new Error('git must not run in CLI tests')) },
  };
}

describe('runCli — release token', () => {
  it('arms with the release token and uses it for nothing else', async () => {
    const main = makeApprovedClient();
    const release = new FakeGitHubClient();

    await runCli(ARM, makeIo().io, makeTokenDeps(main, release));

    expect([
      release.calls.map((call) => call.method),
      main.calls.some((call) => call.method === 'enableAutoMerge'),
    ]).toEqual([['enableAutoMerge'], false]);
  });

  it('never uses the release token without --arm-auto-merge', async () => {
    const main = makeApprovedClient();
    const release = new FakeGitHubClient();

    await runCli(RECONCILE, makeIo().io, makeTokenDeps(main, release));

    expect(release.calls).toEqual([]);
  });
});

describe('runCli — release token missing', () => {
  it('still labels, skips arming, and exits 0', async () => {
    const client = makeApprovedClient();

    const code = await runCli(ARM, makeIo().io, makeDeps(client, NO_RELEASE_TOKEN).deps);

    expect([code, client.pull.labels, client.pull.autoMergeEnabled]).toEqual([
      0,
      ['approved'],
      false,
    ]);
  });

  it('warns on stderr', async () => {
    const { err, io } = makeIo();

    await runCli(ARM, io, makeDeps(makeApprovedClient(), NO_RELEASE_TOKEN).deps);

    expect(err).toEqual([
      'warning: rmartz/demo#7 is approved, but auto-merge arm was skipped: PR_LIFECYCLE_TOKEN is not set',
    ]);
  });

  it('posts the advisory comment once', async () => {
    const client = makeApprovedClient();
    const { deps } = makeDeps(client, NO_RELEASE_TOKEN);

    await runCli(ARM, makeIo().io, deps);
    await runCli(ARM, makeIo().io, deps);

    expect(client.comments.filter((body) => body.includes(TOKEN_ADVISORY_MARKER))).toHaveLength(1);
  });

  it('posts no comment with --no-token-advisory', async () => {
    const client = makeApprovedClient();

    await runCli(
      [...ARM, '--no-token-advisory'],
      makeIo().io,
      makeDeps(client, NO_RELEASE_TOKEN).deps,
    );

    expect(client.comments).toEqual([]);
  });

  it('posts no comment in a dry run', async () => {
    const client = makeApprovedClient();

    await runCli([...ARM, '--dry-run'], makeIo().io, makeDeps(client, NO_RELEASE_TOKEN).deps);

    expect(client.writes).toEqual([]);
  });

  it('treats an empty release token as missing', async () => {
    const client = makeApprovedClient();
    const env = { GITHUB_TOKEN: 't0k', PR_LIFECYCLE_TOKEN: '' };

    await runCli(ARM, makeIo().io, makeDeps(client, env).deps);

    expect(client.pull.autoMergeEnabled).toBe(false);
  });

  it('still exits 0 when the advisory cannot be posted', async () => {
    const client = makeApprovedClient();
    client.failNext('createIssueComment', new GitHubApiError(403, 'forbidden'));
    const { err, io } = makeIo();

    const code = await runCli(ARM, io, makeDeps(client, NO_RELEASE_TOKEN).deps);

    expect([code, err[1]]).toEqual([
      0,
      'warning: could not post the release-token advisory: forbidden',
    ]);
  });

  it('reports the skip in --json', async () => {
    const { out, io } = makeIo();

    await runCli([...ARM, '--json'], io, makeDeps(makeApprovedClient(), NO_RELEASE_TOKEN).deps);

    const json = JSON.parse(out[0] ?? '') as { autoMerge: string; autoMergeSkipped: unknown };
    expect([json.autoMerge, json.autoMergeSkipped]).toEqual([
      'none',
      { action: 'arm', reason: 'release-token-missing' },
    ]);
  });

  it('reports the skip in the summary', async () => {
    const { out, io } = makeIo();

    await runCli(ARM, io, makeDeps(makeApprovedClient(), NO_RELEASE_TOKEN).deps);

    expect(out).toEqual([
      'rmartz/demo#7 → approved: +approved, auto-merge arm skipped (no release token) (bot: not a recognized bot PR)',
    ]);
  });
});
