import { describe, expect, it } from 'vitest';

import type { BotPrCommit, BotPrFacts } from '../src/bot-eligibility.js';
import { classifyBotPr, parseDependabotUpdateType } from '../src/bot-eligibility.js';

function makeDependabotMessage(...updateTypes: string[]): string {
  const entries = updateTypes
    .map(
      (type, index) =>
        `- dependency-name: dep-${index}\n  dependency-version: 1.0.0\n  dependency-type: direct:development\n  update-type: ${type}`,
    )
    .join('\n');
  return `chore(deps): bump things\n\nBumps deps.\n\n---\nupdated-dependencies:\n${entries}\n...\n\nSigned-off-by: dependabot[bot] <support@github.com>`;
}

function makeCommit(overrides: Partial<BotPrCommit> = {}): BotPrCommit {
  return {
    authorLogin: 'dependabot[bot]',
    message: makeDependabotMessage('version-update:semver-minor'),
    ...overrides,
  };
}

function makeBotPrFacts(overrides: Partial<BotPrFacts> = {}): BotPrFacts {
  return {
    authorLogin: 'dependabot[bot]',
    headRef: 'dependabot/npm_and_yarn/prettier-3.9.8',
    isCrossRepository: false,
    labels: [],
    commits: [makeCommit()],
    ...overrides,
  };
}

describe('parseDependabotUpdateType', () => {
  it.each([
    'version-update:semver-patch',
    'version-update:semver-minor',
    'version-update:semver-major',
  ])('reads a single %s entry', (type) => {
    expect(parseDependabotUpdateType(makeDependabotMessage(type))).toBe(type);
  });

  it('takes the highest update type in a grouped update', () => {
    const message = makeDependabotMessage(
      'version-update:semver-patch',
      'version-update:semver-major',
      'version-update:semver-minor',
    );

    expect(parseDependabotUpdateType(message)).toBe('version-update:semver-major');
  });

  it('returns undefined with no metadata block', () => {
    expect(parseDependabotUpdateType('chore(deps): bump x\n\nno metadata')).toBeUndefined();
  });

  it('returns undefined when the block has no update-type', () => {
    const message = '---\nupdated-dependencies:\n- dependency-name: x\n...\n';

    expect(parseDependabotUpdateType(message)).toBeUndefined();
  });

  it('fails safe on any unrecognized update type in a group', () => {
    const message = makeDependabotMessage('version-update:semver-patch', 'security-update');

    expect(parseDependabotUpdateType(message)).toBeUndefined();
  });

  it('ignores update-type lines after the block ends', () => {
    const message = `${makeDependabotMessage('version-update:semver-patch')}\nupdate-type: version-update:semver-major`;

    expect(parseDependabotUpdateType(message)).toBe('version-update:semver-patch');
  });

  it('handles CRLF line endings', () => {
    const message = makeDependabotMessage('version-update:semver-minor').replace(/\n/g, '\r\n');

    expect(parseDependabotUpdateType(message)).toBe('version-update:semver-minor');
  });
});

describe('classifyBotPr — Dependabot', () => {
  it.each(['version-update:semver-patch', 'version-update:semver-minor'])(
    'makes a %s bump eligible',
    (type) => {
      const facts = makeBotPrFacts({
        commits: [makeCommit({ message: makeDependabotMessage(type) })],
      });

      expect(classifyBotPr(facts)).toMatchObject({ eligible: true, updateType: type });
    },
  );

  it('holds a major bump for review', () => {
    const facts = makeBotPrFacts({
      commits: [makeCommit({ message: makeDependabotMessage('version-update:semver-major') })],
    });

    expect(classifyBotPr(facts)).toMatchObject({
      eligible: false,
      updateType: 'version-update:semver-major',
    });
  });

  it('holds a grouped update containing a major', () => {
    const message = makeDependabotMessage(
      'version-update:semver-patch',
      'version-update:semver-major',
    );

    expect(classifyBotPr(makeBotPrFacts({ commits: [makeCommit({ message })] })).eligible).toBe(
      false,
    );
  });

  it('is not eligible when the update type is unavailable', () => {
    const facts = makeBotPrFacts({ commits: [makeCommit({ message: 'bump x' })] });

    expect(classifyBotPr(facts).eligible).toBe(false);
  });

  it('holds a Dependabot PR someone else pushed commits to', () => {
    // The foreign commit keeps valid Dependabot metadata (e.g. an amended or
    // cherry-picked message), so only the commit-author rule can reject it.
    const facts = makeBotPrFacts({
      commits: [makeCommit(), makeCommit({ authorLogin: 'maintainer' })],
    });

    expect(classifyBotPr(facts)).toMatchObject({
      eligible: false,
      reason: 'Dependabot PR has non-Dependabot commits — held for review',
    });
  });

  it('holds a Dependabot PR with an unlinked commit author', () => {
    const facts = makeBotPrFacts({ commits: [makeCommit({ authorLogin: undefined })] });

    expect(classifyBotPr(facts).eligible).toBe(false);
  });

  it('is not eligible with no commits', () => {
    expect(classifyBotPr(makeBotPrFacts({ commits: [] })).eligible).toBe(false);
  });

  it('takes the highest update type across commits', () => {
    const facts = makeBotPrFacts({
      commits: [
        makeCommit({ message: makeDependabotMessage('version-update:semver-patch') }),
        makeCommit({ message: makeDependabotMessage('version-update:semver-major') }),
      ],
    });

    expect(classifyBotPr(facts).updateType).toBe('version-update:semver-major');
  });

  it('never treats a fork as Dependabot', () => {
    expect(classifyBotPr(makeBotPrFacts({ isCrossRepository: true })).eligible).toBe(false);
  });
});

describe('classifyBotPr — release-please', () => {
  const human = { authorLogin: 'someone', commits: [] };

  it('makes a release-please branch eligible', () => {
    const facts = makeBotPrFacts({ ...human, headRef: 'release-please--branches--main' });

    expect(classifyBotPr(facts)).toMatchObject({ eligible: true, prType: 'release-please' });
  });

  it('makes a PR with the autorelease: pending label eligible', () => {
    const facts = makeBotPrFacts({ ...human, headRef: 'x', labels: ['autorelease: pending'] });

    expect(classifyBotPr(facts).eligible).toBe(true);
  });

  it('rejects a fork PR whose branch name imitates release-please', () => {
    const facts = makeBotPrFacts({
      ...human,
      headRef: 'release-please--branches--main',
      isCrossRepository: true,
    });

    expect(classifyBotPr(facts).eligible).toBe(false);
  });

  it('rejects a fork PR carrying the pending label', () => {
    const facts = makeBotPrFacts({
      ...human,
      headRef: 'x',
      labels: ['autorelease: pending'],
      isCrossRepository: true,
    });

    expect(classifyBotPr(facts).eligible).toBe(false);
  });
});

describe('classifyBotPr — other PRs', () => {
  it('is not eligible for a human PR', () => {
    const facts = makeBotPrFacts({ authorLogin: 'maintainer', headRef: 'feature/x', commits: [] });

    expect(classifyBotPr(facts)).toEqual({
      eligible: false,
      reason: 'not a recognized bot PR',
      prType: undefined,
      updateType: undefined,
    });
  });

  it('is not eligible for an unrecognized bot', () => {
    const facts = makeBotPrFacts({ authorLogin: 'renovate[bot]', headRef: 'renovate/x' });

    expect(classifyBotPr(facts).eligible).toBe(false);
  });
});
