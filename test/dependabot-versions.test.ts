import { describe, expect, it } from 'vitest';

import type { BotPrFacts } from '../src/bot-eligibility.js';
import { classifyBotPr } from '../src/bot-eligibility.js';
import {
  commitUpdateType,
  parseClaimedBumps,
  parseUpdatedDependencies,
} from '../src/dependabot-versions.js';
import { diffCorroborates, semverDelta } from '../src/version-delta.js';
import { makeChangedFile } from './fixtures.js';

// Dependabot security updates carry no `update-type` line, so the type is derived
// from the bump's versions and corroborated by the diff (#92). The single-update
// fixture is rmartz/hidden-role-game#950's real commit message.

function makeSecurityMessage(from = '16.3.6', to = '16.3.8', version = to): string {
  return [
    `chore(deps): bump next from ${from} to ${to}`,
    '',
    `Bumps [next](https://github.com/vercel/next.js) from ${from} to ${to}.`,
    '- [Release notes](https://github.com/vercel/next.js/releases)',
    '',
    '---',
    'updated-dependencies:',
    '- dependency-name: next',
    `  dependency-version: ${version}`,
    '  dependency-type: direct:production',
    '...',
    '',
    'Signed-off-by: dependabot[bot] <support@github.com>',
  ].join('\n');
}

function makePackageJsonDiff(from = '16.3.6', to = '16.3.8') {
  return makeChangedFile({
    filename: 'package.json',
    patch: `@@ -20,7 +20,7 @@\n     "react": "19.2.0",\n-    "next": "${from}",\n+    "next": "${to}",\n`,
  });
}

function makeSecurityFacts(overrides: Partial<BotPrFacts> = {}): BotPrFacts {
  return {
    authorLogin: 'dependabot[bot]',
    headRef: 'dependabot/npm_and_yarn/next-16.3.8',
    isCrossRepository: false,
    commits: [{ authorLogin: 'dependabot[bot]', message: makeSecurityMessage() }],
    changedFiles: [makePackageJsonDiff()],
    ...overrides,
  };
}

describe('parseUpdatedDependencies', () => {
  it('reads each entry with its version and update type', () => {
    const message = `---\nupdated-dependencies:\n- dependency-name: a\n  dependency-version: 1.2.3\n  update-type: version-update:semver-minor\n- dependency-name: b\n  dependency-version: 4.0.0\n...`;

    expect(parseUpdatedDependencies(message)).toEqual([
      { name: 'a', version: '1.2.3', updateType: 'version-update:semver-minor' },
      { name: 'b', version: '4.0.0', updateType: undefined },
    ]);
  });

  it('returns undefined without a metadata block', () => {
    expect(parseUpdatedDependencies('chore(deps): bump things')).toBeUndefined();
  });
});

describe('parseClaimedBumps', () => {
  it('reads a single update from its Bumps line', () => {
    expect(parseClaimedBumps(makeSecurityMessage()).get('next')).toEqual({
      from: '16.3.6',
      to: '16.3.8',
    });
  });

  it('reads each entry of a group from its Updates lines', () => {
    const message =
      'Updates `next` from 16.3.6 to 16.3.8\nUpdates `@types/node` from 22.1.0 to 22.2.0';

    expect([...parseClaimedBumps(message)]).toEqual([
      ['next', { from: '16.3.6', to: '16.3.8' }],
      ['@types/node', { from: '22.1.0', to: '22.2.0' }],
    ]);
  });
});

describe('semverDelta', () => {
  it.each([
    ['16.3.6', '16.3.8', 'version-update:semver-patch'],
    ['16.3.6', '16.4.0', 'version-update:semver-minor'],
    ['16.3.6', '17.0.0', 'version-update:semver-major'],
    ['v4.1.0', 'v4.1.2', 'version-update:semver-patch'],
    ['2', '2.1', 'version-update:semver-minor'],
  ] as const)('classifies %s → %s as %s', (from, to, expected) => {
    expect(semverDelta(from, to)).toBe(expected);
  });

  it.each([
    ['a downgrade', '16.3.8', '16.3.6'],
    ['no change', '16.3.8', '16.3.8'],
    ['a pre-release', '16.3.6', '16.4.0-canary.1'],
    ['a non-numeric version', 'a1b2c3d', 'e4f5a6b'],
    ['too many components', '1.2.3.4', '1.2.3.5'],
  ])('gives no type for %s', (_label, from, to) => {
    expect(semverDelta(from, to)).toBeUndefined();
  });
});

describe('diffCorroborates', () => {
  const bump = { from: '16.3.6', to: '16.3.8' };

  it('accepts a diff that removes from and adds to', () => {
    expect(diffCorroborates([makePackageJsonDiff()], bump)).toBe(true);
  });

  it('rejects a diff that never removes the claimed from-version', () => {
    expect(diffCorroborates([makePackageJsonDiff('15.0.0', '16.3.8')], bump)).toBe(false);
  });

  it('does not match a version inside a longer one', () => {
    expect(diffCorroborates([makePackageJsonDiff('116.3.60', '16.3.8')], bump)).toBe(false);
  });

  it('skips a file whose patch GitHub omitted, without failing the rest', () => {
    const omitted = makeChangedFile({ filename: 'pnpm-lock.yaml', patch: undefined });

    expect(diffCorroborates([omitted, makePackageJsonDiff()], bump)).toBe(true);
  });

  it('fails closed with no files', () => {
    expect(diffCorroborates(undefined, bump)).toBe(false);
  });

  // The fleet pins actions as `@<sha> # vX.Y.Z`, so an Actions security update's
  // diff shows the version only behind a `v`.
  it('matches a version behind a single v prefix, as in an action pin comment', () => {
    const pin = makeChangedFile({
      filename: '.github/workflows/ci.yml',
      patch:
        '-      - uses: actions/checkout@aaaaaaa # v4.1.0\n+      - uses: actions/checkout@bbbbbbb # v4.1.1\n',
    });

    expect(diffCorroborates([pin], { from: '4.1.0', to: '4.1.1' })).toBe(true);
  });

  it.each([
    ['a v inside a longer token', 'xv4.1.0'],
    ['a longer version', '14.1.0'],
    ['a double v', 'vv4.1.0'],
  ])('does not match a version after %s', (_label, removed) => {
    const diff = makeChangedFile({ patch: `-  ${removed}\n+  4.1.1\n` });

    expect(diffCorroborates([diff], { from: '4.1.0', to: '4.1.1' })).toBe(false);
  });
});

describe('commitUpdateType', () => {
  it('derives the type of a corroborated security update', () => {
    expect(commitUpdateType(makeSecurityMessage(), [makePackageJsonDiff()])).toEqual({
      type: 'version-update:semver-patch',
      derived: true,
    });
  });

  it('uses an explicit update type without needing the diff', () => {
    const message = `---\nupdated-dependencies:\n- dependency-name: a\n  update-type: version-update:semver-minor\n...`;

    expect(commitUpdateType(message, undefined)).toEqual({
      type: 'version-update:semver-minor',
      derived: false,
    });
  });

  it('gives no type when the prose target disagrees with dependency-version', () => {
    const message = makeSecurityMessage('16.3.6', '16.3.8', '17.0.0');

    expect(commitUpdateType(message, [makePackageJsonDiff()]).type).toBeUndefined();
  });

  it('gives no type to a group when one entry has no stated versions', () => {
    const message = `Updates \`a\` from 1.0.0 to 1.0.1\n---\nupdated-dependencies:\n- dependency-name: a\n  dependency-version: 1.0.1\n- dependency-name: b\n  dependency-version: 2.0.1\n...`;
    const diff = makeChangedFile({ patch: '-  "a": "1.0.0"\n+  "a": "1.0.1"\n' });

    expect(commitUpdateType(message, [diff]).type).toBeUndefined();
  });
});

describe('classifyBotPr — Dependabot security updates', () => {
  it('approves a security patch whose versions the diff corroborates', () => {
    const eligibility = classifyBotPr(makeSecurityFacts());

    expect([eligibility.eligible, eligibility.updateType, eligibility.reason]).toEqual([
      true,
      'version-update:semver-patch',
      'Dependabot version-update:semver-patch (derived from the versions) — eligible',
    ]);
  });

  it('holds a security update whose versions span a major', () => {
    const facts = makeSecurityFacts({
      commits: [
        { authorLogin: 'dependabot[bot]', message: makeSecurityMessage('15.5.0', '16.3.8') },
      ],
      changedFiles: [makePackageJsonDiff('15.5.0', '16.3.8')],
    });

    expect(classifyBotPr(facts).eligible).toBe(false);
  });

  // Dependabot has misstated a from-version before (rmartz/envctl#27); a claimed
  // patch the diff contradicts must not hide a larger jump.
  it('holds a security update whose claimed from-version the diff contradicts', () => {
    const facts = makeSecurityFacts({ changedFiles: [makePackageJsonDiff('15.5.0', '16.3.8')] });

    expect(classifyBotPr(facts).eligible).toBe(false);
  });

  it('holds a security update when the diff was not read', () => {
    expect(classifyBotPr(makeSecurityFacts({ changedFiles: undefined })).eligible).toBe(false);
  });

  // An omitted patch adds no evidence, so a diff of only omitted patches can't
  // corroborate anything.
  it('holds a security update whose only changed file has no patch', () => {
    const omitted = makeChangedFile({ filename: 'pnpm-lock.yaml', patch: undefined });

    expect(classifyBotPr(makeSecurityFacts({ changedFiles: [omitted] })).eligible).toBe(false);
  });

  it('still holds a security update with a non-Dependabot commit', () => {
    const facts = makeSecurityFacts({
      commits: [
        { authorLogin: 'dependabot[bot]', message: makeSecurityMessage() },
        { authorLogin: 'someone', message: 'fix the build' },
      ],
    });

    expect(classifyBotPr(facts).eligible).toBe(false);
  });
});
