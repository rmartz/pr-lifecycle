import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommitComparison, CommitObject } from '../../src/github/client.js';

/**
 * Real git repositories for carry-over tests. Each fixture is a throwaway repo
 * that doubles as the "remote" (fetched over file://), and a client that answers
 * getCommit / compareCommits from the same repo, so verification runs the real
 * fetch and `git merge-tree` end to end.
 */

export class GitFixture {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'pr-lifecycle-fixture-'));
    this.git('init', '--quiet', '--initial-branch=main');
    this.git('config', 'user.email', 'fixture@example.com');
    this.git('config', 'user.name', 'Fixture');
    this.git('config', 'commit.gpgsign', 'false');
    // Serve arbitrary commits by SHA over file://, as GitHub does for reachable ones.
    this.git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  }

  get url(): string {
    return `file://${this.dir}`;
  }

  git(...args: string[]): string {
    return execFileSync('git', ['-C', this.dir, ...args], { encoding: 'utf8' }).trim();
  }

  /** Write files and commit them; returns the new commit's sha. */
  commit(message: string, files: Record<string, string>): string {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(this.dir, name), content);
    }
    this.git('add', '--all');
    this.git('commit', '--quiet', '--message', message);
    return this.head();
  }

  checkout(branch: string, create = false): void {
    this.git('checkout', '--quiet', ...(create ? ['-b', branch] : [branch]));
  }

  head(): string {
    return this.git('rev-parse', 'HEAD');
  }

  /** `git merge` a branch into the current one, as GitHub's update-branch does. */
  mergeClean(branch: string): string {
    this.git('merge', '--quiet', '--no-edit', '--no-ff', branch);
    return this.head();
  }

  /** A merge commit with the right parents whose tree is then altered by `files`. */
  mergeWithEdits(branch: string, files: Record<string, string>): string {
    try {
      this.git('merge', '--quiet', '--no-commit', '--no-ff', branch);
    } catch {
      // A conflicting merge stops here too; the caller's files resolve it.
    }
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(this.dir, name), content);
    }
    this.git('add', '--all');
    this.git('commit', '--quiet', '--no-edit', '--message', `Merge branch '${branch}'`);
    return this.head();
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** A client answering from this repo, like the GitHub commit/compare APIs. */
  client() {
    return {
      getCommit: (sha: string): Promise<CommitObject> => {
        const [, ...parents] = this.git('rev-list', '--parents', '-n', '1', sha).split(' ');
        return Promise.resolve({ treeSha: this.git('rev-parse', `${sha}^{tree}`), parents });
      },
      compareCommits: (base: string, head: string): Promise<CommitComparison> => {
        const mergeBaseSha = this.git('merge-base', base, head);
        const baseSha = this.git('rev-parse', base);
        const headSha = this.git('rev-parse', head);
        const status =
          baseSha === headSha
            ? 'identical'
            : mergeBaseSha === baseSha
              ? 'ahead'
              : mergeBaseSha === headSha
                ? 'behind'
                : 'diverged';
        return Promise.resolve({ status, mergeBaseSha });
      },
    };
  }
}
