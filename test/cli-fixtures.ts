import type { CliDeps } from '../src/cli.js';
import type { HttpClientOptions } from '../src/github/http-client.js';
import { COPILOT_REVIEWER_LOGIN } from '../src/state.js';
import { makeVerdictBody } from './fixtures.js';
import { FakeGitHubClient, makePullRequestData, makeReviewData } from './github/fake-client.js';

/** Shared setup for the CLI tests (cli.test.ts, cli-release-token.test.ts). */

export const RECONCILE = ['reconcile', '--repo', 'rmartz/demo', '--pr', '7'];

export function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) },
  };
}

export function makeApprovedClient() {
  const client = new FakeGitHubClient(makePullRequestData(), [
    makeReviewData({ id: 1, login: COPILOT_REVIEWER_LOGIN, type: 'Bot' }),
    makeReviewData({ id: 2, body: makeVerdictBody('approved') }),
  ]);
  client.permissions.set('maintainer', { permission: 'write', roleName: 'write' });
  return client;
}

/**
 * CLI deps whose clients are all `client`, whatever the token. By default both
 * tokens are set, so arming works; pass `env` to test a missing one.
 */
export function makeDeps(
  client: FakeGitHubClient,
  env: CliDeps['env'] = { GITHUB_TOKEN: 't0k', PR_LIFECYCLE_RELEASE_TOKEN: 'r3l' },
) {
  const created: HttpClientOptions[] = [];
  const deps: CliDeps = {
    env,
    createClient: (options) => {
      created.push(options);
      return client;
    },
    // None of these PRs has a review on an earlier commit, so carry-over must
    // never reach git; fail loudly if it does.
    git: { run: () => Promise.reject(new Error('git must not run in CLI tests')) },
  };
  return { deps, created };
}
