import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LineageInput } from '../../src/github/lineage-facts.js';
import { gatherLineage, MAX_REBASE_CHECKS } from '../../src/github/lineage-facts.js';
import { checkCleanRebase } from '../../src/github/lineage-rebase.js';
import type { GitRunner } from '../../src/lineage/git.js';
import { createGitRunner } from '../../src/lineage/git.js';
import { createMergeVerifier } from '../../src/lineage/verify.js';
import { makeVerdictBody } from '../fixtures.js';
import { GitFixture } from '../lineage/fixture.js';
import { makeReviewData } from './fake-client.js';

/**
 * Carry-over across a rebase, against real git. Each scenario reviews commit `S`
 * on a PR branch, then force-pushes the branch (rebased onto a newer base, or
 * rewritten some other way) and asks whether `S`'s reviews carry to the new head.
 * Only a head whose tree is the clean automatic replay of `S` onto a newer base
 * may carry; any other rewrite must not.
 */

let repo: GitFixture;
const git = createGitRunner();

beforeEach(() => {
  repo = new GitFixture();
  repo.commit('base', {
    'shared.txt': 'a\nb\nc\nd\ne\nf\ng\nh\n',
    'other.txt': 'base\n',
    'docs/guide.md': 'intro\n\nbody\n\noutro\n',
  });
});

afterEach(() => {
  repo.dispose();
});

/** A PR branch with one reviewed commit `S` touching shared.txt line 2. */
function openPr(files: Record<string, string> = {}): string {
  repo.checkout('pr', true);
  return repo.commit('pr change', {
    'shared.txt': 'a\nb-pr\nc\nd\ne\nf\ng\nh\n',
    'feat.txt': 'feat\n',
    ...files,
  });
}

/** Advance main with a change (by default to an unrelated file); returns its sha. */
function advanceMain(files: Record<string, string> = { 'other.txt': 'main\n' }): string {
  repo.checkout('main');
  const sha = repo.commit('main change', files);
  repo.checkout('pr');
  return sha;
}

/** Rebase the PR branch onto `onto`, as `@dependabot rebase` does with a force-push. */
function rebaseOnto(onto = 'main'): string {
  repo.git('rebase', '--quiet', onto);
  return repo.head();
}

/** Rewrite the head commit with extra edits, keeping its parent and message. */
function amend(files: Record<string, string>): string {
  repo.commit('scratch', files);
  repo.git('reset', '--quiet', '--soft', 'HEAD~2');
  repo.git('commit', '--quiet', '--message', 'pr change');
  return repo.head();
}

function lineageInput(reviewed: string, overrides: Partial<LineageInput> = {}): LineageInput {
  return {
    headSha: repo.head(),
    baseHeadSha: repo.git('rev-parse', 'main'),
    source: { url: repo.url },
    reviews: [makeReviewData({ commitSha: reviewed, body: makeVerdictBody('approved', reviewed) })],
    ...overrides,
  };
}

describe('gatherLineage — verified clean rebases', () => {
  it('carries across a rebase onto a base that changed an unrelated file', async () => {
    const reviewed = openPr();
    advanceMain();
    rebaseOnto();

    const lineage = await gatherLineage(repo.client(), git, lineageInput(reviewed));

    expect(lineage.rebases).toEqual([
      { source: reviewed, carried: true, reason: 'the head is its clean rebase onto the base' },
    ]);
  });

  it('carries across a rebase where both sides edited the same code file', async () => {
    const reviewed = openPr();
    advanceMain({ 'shared.txt': 'a\nb\nc\nd\ne\nf\ng-main\nh\n' });
    rebaseOnto();

    const lineage = await gatherLineage(repo.client(), git, lineageInput(reviewed));

    expect(lineage.rebases.map((check) => check.carried)).toEqual([true]);
  });

  it('carries across a recreate with the same content on the same base', async () => {
    const reviewed = openPr();
    repo.git('commit', '--quiet', '--amend', '--message', 'pr change, recreated');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(reviewed));

    expect(lineage.rebases.map((check) => check.carried)).toEqual([true]);
  });

  it('finds the reviewed commit by its marker when GitHub re-pointed commit_id at the head', async () => {
    const reviewed = openPr();
    advanceMain();
    const head = rebaseOnto();
    const repointed = makeReviewData({
      commitSha: head,
      body: makeVerdictBody('approved', reviewed),
    });

    const lineage = await gatherLineage(
      repo.client(),
      git,
      lineageInput(reviewed, { reviews: [repointed] }),
    );

    expect(lineage.rebases.map((check) => [check.source, check.carried])).toEqual([
      [reviewed, true],
    ]);
  });

  it('carries an unmarked native approval across a clean rebase', async () => {
    const reviewed = openPr();
    advanceMain();
    rebaseOnto();
    const native = makeReviewData({ commitSha: reviewed, state: 'APPROVED' });

    const lineage = await gatherLineage(
      repo.client(),
      git,
      lineageInput(reviewed, { reviews: [native] }),
    );

    expect(lineage.rebases.map((check) => check.carried)).toEqual([true]);
  });
});

describe('gatherLineage — rebases never verified', () => {
  it('rejects a rebase with an extra edit sneaked in', async () => {
    const reviewed = openPr();
    advanceMain();
    rebaseOnto();
    amend({ 'feat.txt': 'feat\nsneaky\n' });

    const lineage = await gatherLineage(repo.client(), git, lineageInput(reviewed));

    expect(lineage.rebases).toEqual([
      { source: reviewed, carried: false, reason: 'the head is not its clean automatic rebase' },
    ]);
  });

  it('rejects a rebase with a hand-resolved conflict', async () => {
    const reviewed = openPr();
    advanceMain({ 'shared.txt': 'a\nb-main\nc\nd\ne\nf\ng\nh\n' });
    repo.checkout('main');
    repo.checkout('rebased', true);
    repo.commit('pr change', {
      'shared.txt': 'a\nb-resolved\nc\nd\ne\nf\ng\nh\n',
      'feat.txt': 'feat\n',
    });

    const lineage = await gatherLineage(repo.client(), git, lineageInput(reviewed));

    expect(lineage.rebases.map((check) => check.carried)).toEqual([false]);
  });

  it('rejects a rebase onto a branch that is not the base', async () => {
    const reviewed = openPr();
    repo.checkout('main');
    repo.checkout('side', true);
    repo.commit('side change', { 'side.txt': 'side\n' });
    repo.checkout('pr');
    rebaseOnto('side');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(reviewed));

    expect(lineage.rebases.map((check) => check.carried)).toEqual([false]);
  });

  it('rejects a head on an older base than the reviewed commit', async () => {
    const original = repo.head();
    repo.commit('main change', { 'other.txt': 'main\n' });
    const reviewed = openPr();
    // Replay the change onto the original base: the base moved backwards.
    repo.git('rebase', '--quiet', '--onto', original, 'main');

    const lineage = await gatherLineage(repo.client(), git, lineageInput(reviewed));

    expect(lineage.rebases).toEqual([
      {
        source: reviewed,
        carried: false,
        reason: 'the head sits on an older or unrelated base',
      },
    ]);
  });

  it('rejects a clean rebase where both sides edited the same prose page', async () => {
    const reviewed = openPr({ 'docs/guide.md': 'intro, revised\n\nbody\n\noutro\n' });
    advanceMain({ 'docs/guide.md': 'intro\n\nbody\n\noutro, revised\n' });
    rebaseOnto();

    const lineage = await gatherLineage(repo.client(), git, lineageInput(reviewed));

    expect(lineage.rebases).toEqual([
      {
        source: reviewed,
        carried: false,
        reason: 'both sides edited the same prose (docs/guide.md)',
      },
    ]);
  });

  it('rejects a rebase whose reviewed commit cannot be fetched', async () => {
    const reviewed = openPr();
    advanceMain();
    rebaseOnto();
    const refuseSource: GitRunner = {
      run: (args, env) =>
        args.includes('fetch') && args.includes(reviewed)
          ? Promise.resolve({ code: 128, stdout: '', stderr: 'not our ref' })
          : git.run(args, env),
    };

    const lineage = await gatherLineage(repo.client(), refuseSource, lineageInput(reviewed));

    expect(lineage.rebases.map((check) => check.carried)).toEqual([false]);
  });

  it('leaves a reviewed commit still in the head history to the merge walk', async () => {
    const reviewed = openPr();
    repo.commit('another change', { 'feat.txt': 'feat v2\n' });

    const lineage = await gatherLineage(repo.client(), git, lineageInput(reviewed));

    expect([lineage.cleanAncestors, lineage.rebases]).toEqual([[], []]);
  });

  it('ignores a review from a bot', async () => {
    const reviewed = openPr();
    advanceMain();
    rebaseOnto();
    const bot = makeReviewData({
      type: 'Bot',
      commitSha: reviewed,
      body: makeVerdictBody('approved', reviewed),
    });

    const lineage = await gatherLineage(
      repo.client(),
      git,
      lineageInput(reviewed, { reviews: [bot] }),
    );

    expect(lineage.stoppedBecause).toBe('no reviews on earlier commits');
  });
});

describe('gatherLineage — rebase checks are bounded and injection-safe', () => {
  it(`checks at most ${MAX_REBASE_CHECKS} reviewed commits, newest review first`, async () => {
    const reviewed = openPr();
    advanceMain();
    rebaseOnto();
    const decoys = ['1', '2', '3', '4'].map((digit) => digit.repeat(40));
    const reviews = [reviewed, ...decoys].map((sha, index) =>
      makeReviewData({ id: index + 1, commitSha: sha, body: makeVerdictBody('approved', sha) }),
    );

    const lineage = await gatherLineage(repo.client(), git, lineageInput(reviewed, { reviews }));

    expect(lineage.rebases.map((check) => check.source)).toEqual(decoys.toReversed().slice(0, 3));
  });

  it("still carries when another review's marker names a commit GitHub doesn't have", async () => {
    const reviewed = openPr();
    advanceMain();
    rebaseOnto();
    const unknown = 'f'.repeat(40);
    const reviews = [
      makeReviewData({ id: 1, commitSha: reviewed, body: makeVerdictBody('approved', reviewed) }),
      makeReviewData({ id: 2, body: makeVerdictBody('approved', unknown) }),
    ];

    const lineage = await gatherLineage(repo.client(), git, lineageInput(reviewed, { reviews }));

    expect(lineage.rebases.map((check) => [check.source, check.carried])).toEqual([
      [unknown, false],
      [reviewed, true],
    ]);
  });

  it('never passes a marker head that is not a commit id to git', async () => {
    const reviewed = openPr();
    advanceMain();
    rebaseOnto();
    const injection = '--upload-pack=touch /tmp/pr-lifecycle-pwned';
    const argv: string[] = [];
    const spy: GitRunner = {
      run: (args, env) => {
        argv.push(...args);
        return git.run(args, env);
      },
    };
    const hostile = makeReviewData({ body: makeVerdictBody('approved', injection) });

    const lineage = await gatherLineage(
      repo.client(),
      spy,
      lineageInput(reviewed, { reviews: [hostile] }),
    );

    expect([lineage.rebases, argv.some((arg) => arg.includes('upload-pack'))]).toEqual([[], false]);
  });

  it('rejects a source that is not a commit id before any API or git call', async () => {
    openPr();
    const verifier = await createMergeVerifier(git, { url: repo.url });
    const calls: string[] = [];
    const client = {
      compareCommits: (base: string) => {
        calls.push(base);
        return repo.client().compareCommits(base, base);
      },
      getCommit: (sha: string) => {
        calls.push(sha);
        return repo.client().getCommit(sha);
      },
    };
    if (verifier === undefined) {
      throw new Error('git is required for this test');
    }

    try {
      const check = await checkCleanRebase(
        client,
        verifier,
        { source: '../../pulls', headSha: repo.head(), baseHeadSha: repo.head() },
        undefined,
      );

      expect([check, calls]).toEqual([
        { source: '../../pulls', carried: false, reason: 'not a commit id' },
        [],
      ]);
    } finally {
      await verifier.dispose();
    }
  });
});
