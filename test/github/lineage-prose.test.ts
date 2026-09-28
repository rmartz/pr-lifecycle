import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LineageInput } from '../../src/github/lineage-facts.js';
import { gatherLineage } from '../../src/github/lineage-facts.js';
import type { GitRunner } from '../../src/lineage/git.js';
import { createGitRunner } from '../../src/lineage/git.js';
import { GitFixture } from '../lineage/fixture.js';
import { makeReviewData } from './fake-client.js';

/**
 * The prose-overlap rule of approval carry-over, against real git: a clean base
 * merge in which both sides edited the same prose file must not carry an
 * approval over, while every other clean merge still does.
 */

const PAGE = 'intro\n\nalpha\n\nbeta\n\ngamma\n\ndelta\n\nepsilon\n';

let repo: GitFixture;
const git = createGitRunner();

beforeEach(() => {
  repo = new GitFixture();
  repo.commit('base', {
    'docs/guide.md': PAGE,
    'docs/index.md': PAGE,
    'docs/other.md': PAGE,
    'src/code.ts': PAGE,
  });
});

afterEach(() => {
  repo.dispose();
});

/** The PR's approved commit edits the top of `path`; main then edits its bottom. */
function cleanOverlap(path: string): string {
  repo.checkout('pr', true);
  const approved = repo.commit('pr change', { [path]: PAGE.replace('alpha', 'alpha-pr') });
  repo.checkout('main');
  repo.commit('main change', { [path]: PAGE.replace('epsilon', 'epsilon-main') });
  repo.checkout('pr');
  repo.mergeClean('main');
  return approved;
}

function lineageInput(approved: string, prosePatterns?: string[]): LineageInput {
  return {
    headSha: repo.head(),
    baseHeadSha: repo.git('rev-parse', 'main'),
    source: { url: repo.url },
    reviews: [makeReviewData({ commitSha: approved, state: 'APPROVED' })],
    ...(prosePatterns === undefined ? {} : { prosePatterns }),
  };
}

describe('gatherLineage — prose overlap', () => {
  it('does not carry over a clean merge where both sides edited the same page', async () => {
    const approved = cleanOverlap('docs/guide.md');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage).toEqual({
      cleanAncestors: [],
      stoppedBecause: `${repo.head()}: both sides edited the same prose (docs/guide.md)`,
    });
  });

  it('carries over when both sides edited the same index page', async () => {
    const approved = cleanOverlap('docs/index.md');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.cleanAncestors).toEqual([approved]);
  });

  it('carries over when both sides edited the same non-prose file', async () => {
    const approved = cleanOverlap('src/code.ts');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.cleanAncestors).toEqual([approved]);
  });

  it('carries over when the sides edited different pages', async () => {
    repo.checkout('pr', true);
    const approved = repo.commit('pr change', { 'docs/guide.md': 'pr\n' });
    repo.checkout('main');
    repo.commit('main change', { 'docs/other.md': 'main\n' });
    repo.checkout('pr');
    repo.mergeClean('main');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.cleanAncestors).toEqual([approved]);
  });

  it('keeps ancestors verified before the overlapping merge', async () => {
    const approved = cleanOverlap('docs/guide.md');
    const overlapping = repo.head();
    repo.checkout('main');
    repo.commit('late main change', { 'late.txt': 'late\n' });
    repo.checkout('pr');
    repo.mergeClean('main');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved));

    expect(lineage.cleanAncestors).toEqual([overlapping]);
  });

  it('applies custom patterns', async () => {
    const approved = cleanOverlap('src/code.ts');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved, ['*.ts']));

    expect(lineage.cleanAncestors).toEqual([]);
  });

  it('skips the check when the patterns are empty', async () => {
    const approved = cleanOverlap('docs/guide.md');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(approved, []));

    expect(lineage.cleanAncestors).toEqual([approved]);
  });

  it('fails closed when the changed files cannot be listed', async () => {
    const approved = cleanOverlap('docs/guide.md');
    const noDiff: GitRunner = {
      run: (args) =>
        args.includes('diff-tree')
          ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal' })
          : git.run(args),
    };

    const lineage = await gatherLineage(repo.client(), noDiff, lineageInput(approved));

    expect(lineage.stoppedBecause).toBe(
      `${repo.head()}: could not list the files each side changed`,
    );
  });
});
