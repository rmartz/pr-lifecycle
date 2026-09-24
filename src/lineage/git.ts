import { execFile } from 'node:child_process';

/**
 * A bounded `git` subprocess runner. A non-zero exit is data (returned, not
 * thrown), because `git merge-tree` reports conflicts that way; a timeout, a
 * missing binary, or an oversized output throws. Injected so lineage code can be
 * tested against real git in fixture repositories.
 */

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(args: readonly string[], env?: Readonly<Record<string, string>>): Promise<GitResult>;
}

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export function createGitRunner(): GitRunner {
  return {
    run(args, env = {}) {
      return new Promise((resolve, reject) => {
        execFile(
          'git',
          [...args],
          {
            timeout: TIMEOUT_MS,
            maxBuffer: MAX_BUFFER,
            // Never prompt for credentials; fail instead.
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({ code: 0, stdout, stderr });
              return;
            }
            // A numeric code means git ran and exited non-zero: that is data.
            if (typeof error.code === 'number' && !error.killed) {
              resolve({ code: error.code, stdout, stderr });
              return;
            }
            reject(new Error(`git ${args[0] ?? ''} failed: ${error.message}`, { cause: error }));
          },
        );
      });
    },
  };
}

/** Parse `git version 2.54.0 (…)` into [major, minor]; undefined when unrecognized. */
export function parseGitVersion(output: string): [number, number] | undefined {
  const match = /git version (\d+)\.(\d+)/.exec(output);
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2])];
}
