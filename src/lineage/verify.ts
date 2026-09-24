import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitRunner } from './git.js';
import { parseGitVersion } from './git.js';

/**
 * Verifies that a merge commit is exactly the automatic, conflict-free merge of
 * its parents — the content check behind approval carry-over (see
 * docs/reconciler-design.md §Approval carry-over). The commits are fetched as git
 * data only into a throwaway bare repository; nothing is checked out and no PR
 * code runs.
 */

/** `git merge-tree --merge-base` (explicit merge base) needs git 2.40+. */
const MIN_GIT: [number, number] = [2, 40];

// Every value passed to git in argv is validated, so nothing from an API response
// can be read as an option (e.g. a "sha" of `--upload-pack=…`).
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function isStepSafe(step: MergeStep): boolean {
  return [step.mergeBase, step.first, step.second, step.tree].every((id) => OBJECT_ID.test(id));
}

export interface MergeStep {
  /** The merge base of the two parents. */
  mergeBase: string;
  first: string;
  second: string;
  /** The tree the merge commit actually has. */
  tree: string;
}

export interface RepoSource {
  /** Clone URL of the repository (https, or file:// in tests). */
  url: string;
  /** Token for an https URL; sent as a header, never in argv or the URL. */
  token?: string;
}

/**
 * Credentials go through GIT_CONFIG_* environment variables (as actions/checkout
 * does), so the token never appears in argv, the process list, or an error
 * message that echoes the URL.
 */
function authEnv(source: RepoSource): Record<string, string> {
  if (source.token === undefined) {
    return {};
  }
  const basic = Buffer.from(`x-access-token:${source.token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export interface MergeVerifier {
  /** True only when the step is a verified clean merge; false on any doubt. */
  verify(step: MergeStep): Promise<boolean>;
  dispose(): Promise<void>;
}

/**
 * A verifier bound to one repository and one scratch directory. Returns
 * undefined when git is too old to verify at all (the caller then carries
 * nothing over).
 */
export async function createMergeVerifier(
  git: GitRunner,
  source: RepoSource,
): Promise<MergeVerifier | undefined> {
  const version = parseGitVersion((await git.run(['version'])).stdout);
  if (
    version === undefined ||
    version[0] < MIN_GIT[0] ||
    (version[0] === MIN_GIT[0] && version[1] < MIN_GIT[1])
  ) {
    return undefined;
  }
  if (!/^(https|file):\/\//.test(source.url)) {
    return undefined;
  }
  const gitDir = await mkdtemp(join(tmpdir(), 'pr-lifecycle-lineage-'));
  const init = await git.run(['init', '--bare', '--quiet', gitDir]);
  if (init.code !== 0) {
    await rm(gitDir, { recursive: true, force: true });
    return undefined;
  }
  const env = authEnv(source);

  return {
    async verify(step) {
      if (!isStepSafe(step)) {
        return false;
      }
      const fetched = await git.run(
        [
          '--git-dir',
          gitDir,
          'fetch',
          '--quiet',
          '--no-tags',
          '--depth=1',
          '--end-of-options',
          source.url,
          step.mergeBase,
          step.first,
          step.second,
        ],
        env,
      );
      if (fetched.code !== 0) {
        return false;
      }
      const merged = await git.run([
        '--git-dir',
        gitDir,
        'merge-tree',
        '--write-tree',
        `--merge-base=${step.mergeBase}`,
        step.first,
        step.second,
      ]);
      // Exit 0 = clean; 1 = conflicts; anything else = error. Only a clean merge
      // whose tree is byte-identical to the commit's tree passes.
      return merged.code === 0 && merged.stdout.split('\n')[0]?.trim() === step.tree;
    },
    async dispose() {
      await rm(gitDir, { recursive: true, force: true });
    },
  };
}
