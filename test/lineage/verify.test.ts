import { afterEach, describe, expect, it } from 'vitest';

import type { GitRunner } from '../../src/lineage/git.js';
import { createGitRunner, parseGitVersion } from '../../src/lineage/git.js';
import { createMergeVerifier } from '../../src/lineage/verify.js';
import { GitFixture } from './fixture.js';

const repos: GitFixture[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    repo.dispose();
  }
});

/** A repo with a clean merge; returns the merge step to verify. */
function cleanMergeStep() {
  const repo = new GitFixture();
  repos.push(repo);
  repo.commit('base', { 'a.txt': 'a\n' });
  repo.checkout('pr', true);
  const first = repo.commit('pr', { 'b.txt': 'b\n' });
  repo.checkout('main');
  const second = repo.commit('main', { 'c.txt': 'c\n' });
  repo.checkout('pr');
  const merge = repo.mergeClean('main');
  return {
    repo,
    step: {
      mergeBase: repo.git('merge-base', first, second),
      first,
      second,
      tree: repo.git('rev-parse', `${merge}^{tree}`),
    },
  };
}

describe('parseGitVersion', () => {
  it.each([
    ['git version 2.54.0 (Apple Git-157)\n', [2, 54]],
    ['git version 2.40.1\n', [2, 40]],
  ] as const)('parses %j', (output, expected) => {
    expect(parseGitVersion(output)).toEqual(expected);
  });

  it('returns undefined for unrecognized output', () => {
    expect(parseGitVersion('command not found')).toBeUndefined();
  });
});

describe('createMergeVerifier', () => {
  it('verifies a genuine clean merge', async () => {
    const { repo, step } = cleanMergeStep();
    const verifier = await createMergeVerifier(createGitRunner(), { url: repo.url });

    expect(await verifier?.verify(step)).toBe(true);
    await verifier?.dispose();
  });

  it('rejects the right parents with the wrong tree', async () => {
    const { repo, step } = cleanMergeStep();
    const verifier = await createMergeVerifier(createGitRunner(), { url: repo.url });

    expect(
      await verifier?.verify({ ...step, tree: repo.git('rev-parse', `${step.first}^{tree}`) }),
    ).toBe(false);
    await verifier?.dispose();
  });

  it('is unavailable when git reports an unrecognized version', async () => {
    const weird: GitRunner = { run: () => Promise.resolve({ code: 0, stdout: '???', stderr: '' }) };

    expect(await createMergeVerifier(weird, { url: 'file:///x' })).toBeUndefined();
  });

  it('is unavailable when the scratch repository cannot be created', async () => {
    const real = createGitRunner();
    const noInit: GitRunner = {
      run: (args, env) =>
        args[0] === 'init'
          ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal' })
          : real.run(args, env),
    };

    expect(await createMergeVerifier(noInit, { url: 'file:///x' })).toBeUndefined();
  });

  // The token must travel only in the environment (as a git config header),
  // never in argv (visible in the process list) or the URL (echoed in errors).
  it('passes the token as a GIT_CONFIG header, never in argv or the URL', async () => {
    const { repo, step } = cleanMergeStep();
    const real = createGitRunner();
    const seen: { args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
    const spy: GitRunner = {
      run: (args, env = {}) => {
        seen.push({ args, env });
        return real.run(args, env);
      },
    };
    const verifier = await createMergeVerifier(spy, { url: repo.url, token: 's3cr3t' });

    await verifier?.verify(step);
    await verifier?.dispose();

    const fetch = seen.find((call) => call.args.includes('fetch'));
    const header = Buffer.from('x-access-token:s3cr3t').toString('base64');
    expect([
      fetch?.env['GIT_CONFIG_VALUE_0'],
      seen.some((call) => call.args.some((arg) => arg.includes('s3cr3t') || arg.includes(header))),
    ]).toEqual([`AUTHORIZATION: basic ${header}`, false]);
  });
});
