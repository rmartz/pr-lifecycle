import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LineageInput } from '../../src/github/lineage-facts.js';
import { gatherLineage } from '../../src/github/lineage-facts.js';
import type { GitRunner } from '../../src/lineage/git.js';
import { createGitRunner } from '../../src/lineage/git.js';
import { GitFixture } from '../lineage/fixture.js';
import { makeReviewData } from './fake-client.js';

/**
 * Approval carry-over against real git. Each scenario builds a PR branch whose
 * approved commit `A` is followed by base updates, then asks which ancestors are
 * verified clean. Tampered, conflicting, or off-base merges must never verify.
 */

let repo: GitFixture;
const git = createGitRunner();

beforeEach(() => {
  repo = new GitFixture();
  repo.commit('base', { 'shared.txt': 'a\nb\nc\nd\ne\nf\ng\nh\n', 'other.txt': 'base\n' });
});

afterEach(() => {
  repo.dispose();
});

/** A PR branch with one approved commit `A` touching shared.txt line 2. */
function openPr(): string {
  repo.checkout('pr', true);
  return repo.commit('pr change', {
    'shared.txt': 'a\nb-pr\nc\nd\ne\nf\ng\nh\n',
    'feat.txt': 'feat\n',
  });
}

/** Advance main with a change (by default to an unrelated file). */
function advanceMain(
  files: Record<string, string> = { 'other.txt': `main ${Date.now()}\n` },
): void {
  repo.checkout('main');
  repo.commit('main change', files);
  repo.checkout('pr');
}

function lineageInput(approved: string): LineageInput {
  return {
    headSha: repo.head(),
    baseHeadSha: repo.git('rev-parse', 'main'),
    source: { url: repo.url },
    reviews: [makeReviewData({ commitSha: approved, state: 'APPROVED' })],
  };
}

describe('gatherLineage — verified clean updates', () => {
  it('carries across a clean update touching an unrelated file', async () => {
    const approved = openPr();
    advanceMain();
    repo.mergeClean('main');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.cleanAncestors).toEqual([approved]);
  });

  it('carries across a clean update where both sides edited the same file', async () => {
    const approved = openPr();
    advanceMain({ 'shared.txt': 'a\nb\nc\nd\ne\nf\ng-main\nh\n' });
    repo.mergeClean('main');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.cleanAncestors).toEqual([approved]);
  });

  it('carries across a chain of two clean updates', async () => {
    const approved = openPr();
    advanceMain();
    const first = repo.mergeClean('main');
    advanceMain({ 'late.txt': 'late\n' });
    repo.mergeClean('main');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.cleanAncestors).toEqual([first, approved]);
  });

  it('stops as soon as every reviewed ancestor is reached', async () => {
    const approved = openPr();
    advanceMain();
    repo.mergeClean('main');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.stoppedBecause).toBe('every reviewed ancestor reached');
  });
});

describe('gatherLineage — never verified', () => {
  it('rejects a merge with an extra edit sneaked in (identical parents and message)', async () => {
    const approved = openPr();
    advanceMain();
    repo.mergeWithEdits('main', { 'feat.txt': 'feat\nsneaky\n' });

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.cleanAncestors).toEqual([]);
  });

  it('rejects a hand-resolved conflict', async () => {
    const approved = openPr();
    advanceMain({ 'shared.txt': 'a\nb-main\nc\nd\ne\nf\ng\nh\n' });
    repo.mergeWithEdits('main', { 'shared.txt': 'a\nb-resolved\nc\nd\ne\nf\ng\nh\n' });

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.cleanAncestors).toEqual([]);
  });

  it("rejects a merge that reverts the base's change (-s ours)", async () => {
    const approved = openPr();
    advanceMain();
    repo.git('merge', '--quiet', '--no-edit', '-s', 'ours', 'main');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.cleanAncestors).toEqual([]);
  });

  it('rejects merging a branch that is not the base', async () => {
    const approved = openPr();
    repo.checkout('main');
    repo.checkout('side', true);
    repo.commit('side change', { 'side.txt': 'side\n' });
    repo.checkout('pr');
    repo.mergeClean('side');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect([lineage.cleanAncestors, lineage.stoppedBecause]).toEqual([
      [],
      `${repo.head()} merges a commit not on the base`,
    ]);
  });

  it('keeps only the verified prefix when a bad step sits between the head and the review', async () => {
    const approved = openPr();
    advanceMain();
    const tampered = repo.mergeWithEdits('main', { 'feat.txt': 'feat\nsneaky\n' });
    advanceMain({ 'late.txt': 'late\n' });
    repo.mergeClean('main');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.cleanAncestors).toEqual([tampered]);
  });

  it('carries nothing when the head is an ordinary commit', async () => {
    const approved = openPr();
    repo.commit('another change', { 'feat.txt': 'feat v2\n' });

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.cleanAncestors).toEqual([]);
  });
});

describe('gatherLineage — fails closed', () => {
  it('does no git work when no review is on an earlier commit', async () => {
    openPr();
    const calls: string[][] = [];
    const spy: GitRunner = {
      run: (args) => {
        calls.push([...args]);
        return git.run(args);
      },
    };

    const lineage = await gatherLineage(repo.client(), spy, {
      ...lineageInput(repo.head()),
      reviews: [makeReviewData({ commitSha: repo.head(), state: 'APPROVED' })],
    });

    expect([lineage.stoppedBecause, calls]).toEqual(['no reviews on earlier commits', []]);
  });

  it('carries nothing with git older than 2.40', async () => {
    const approved = openPr();
    advanceMain();
    repo.mergeClean('main');
    const oldGit: GitRunner = {
      run: () => Promise.resolve({ code: 0, stdout: 'git version 2.39.2\n', stderr: '' }),
    };

    const lineage = await gatherLineage(repo.client(), oldGit, lineageInput(approved));

    expect([lineage.cleanAncestors, lineage.stoppedBecause]).toEqual([
      [],
      'git unavailable or older than 2.40',
    ]);
  });

  it('carries nothing when the commits cannot be fetched', async () => {
    const approved = openPr();
    advanceMain();
    repo.mergeClean('main');

    const lineage = await gatherLineage(repo.client(), git, {
      ...lineageInput(approved),
      source: { url: 'file:///nonexistent/pr-lifecycle-repo' },
    });

    expect(lineage.cleanAncestors).toEqual([]);
  });

  it('refuses a non-https/file clone URL', async () => {
    const approved = openPr();
    advanceMain();
    repo.mergeClean('main');

    const lineage = await gatherLineage(repo.client(), git, {
      ...lineageInput(approved),
      source: { url: 'ext::sh -c touch% /tmp/pwned' },
    });

    expect(lineage.cleanAncestors).toEqual([]);
  });

  it('carries nothing when the client errors mid-walk', async () => {
    const approved = openPr();
    advanceMain();
    repo.mergeClean('main');
    const failing = { ...repo.client(), getCommit: () => Promise.reject(new Error('502')) };

    const lineage = await gatherLineage(failing, git, lineageInput(approved));

    expect([lineage.cleanAncestors, lineage.stoppedBecause]).toEqual([
      [],
      'verification failed: 502',
    ]);
  });

  it('never passes an API value that could be read as a git option to git', async () => {
    const approved = openPr();
    advanceMain();
    repo.mergeClean('main');
    const injection = '--upload-pack=touch /tmp/pr-lifecycle-pwned';
    // The merge base reaches git's argv (fetch refs and merge-tree), so a hostile
    // one is exactly what validation must stop before git ever sees it.
    const hostile = {
      ...repo.client(),
      compareCommits: async (base: string, head: string) => ({
        ...(await repo.client().compareCommits(base, head)),
        mergeBaseSha: injection,
      }),
    };
    const argv: string[] = [];
    const spy: GitRunner = {
      run: (args, env) => {
        argv.push(...args);
        return git.run(args, env);
      },
    };

    const lineage = await gatherLineage(hostile, spy, lineageInput(approved));

    expect([lineage.cleanAncestors, argv.some((arg) => arg.includes('upload-pack'))]).toEqual([
      [],
      false,
    ]);
  });

  it('rejects an octopus (three-parent) merge', async () => {
    const approved = openPr();
    repo.checkout('main');
    repo.checkout('side', true);
    repo.commit('side change', { 'side.txt': 'side\n' });
    repo.checkout('main');
    repo.commit('main change', { 'other.txt': 'main again\n' });
    repo.checkout('pr');
    repo.git('merge', '--quiet', '--no-edit', 'main', 'side');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.stoppedBecause).toBe(`${repo.head()} is not a two-parent merge`);
  });
});
