import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../src/cli/args.js';

const BASE = ['reconcile', '--repo', 'rmartz/demo', '--pr', '7'];

describe('parseArgs — commands', () => {
  it.each([[[]], [['help']], [['--help']], [['-h']], [['reconcile', '--help']]])(
    'returns help for %j',
    (argv) => {
      expect(parseArgs(argv)).toEqual({ command: 'help' });
    },
  );

  it('rejects an unknown command', () => {
    expect(parseArgs(['frobnicate'])).toEqual({
      command: 'error',
      message: 'Unknown command: frobnicate',
    });
  });
});

describe('parseArgs — reconcile', () => {
  it('parses the required arguments with every flag off', () => {
    expect(parseArgs(BASE)).toEqual({
      command: 'reconcile',
      owner: 'rmartz',
      repo: 'demo',
      pr: 7,
      policy: { armAutoMerge: false, autoUpdate: false, skipCopilotReview: false, uatGate: false },
      dryRun: false,
      json: false,
      tokenAdvisory: true,
    });
  });

  it.each([
    ['--arm-auto-merge', { policy: { armAutoMerge: true, autoUpdate: false } }],
    ['--auto-update', { policy: { armAutoMerge: false, autoUpdate: true } }],
    ['--skip-copilot-review', { policy: { autoUpdate: false, skipCopilotReview: true } }],
    ['--dry-run', { dryRun: true }],
    ['--json', { json: true }],
    ['--no-token-advisory', { tokenAdvisory: false }],
  ])('sets %s', (flag, expected) => {
    expect(parseArgs([...BASE, flag])).toMatchObject(expected);
  });

  it('parses hold and ignored check lists', () => {
    expect(
      parseArgs([...BASE, '--hold-checks', 'pr-policy, uat', '--ignore-checks', 'merge-safety']),
    ).toMatchObject({
      policy: { holdChecks: ['pr-policy', 'uat'], ignoredChecks: ['merge-safety'] },
    });
  });

  it('allows an empty ignored list, meaning every required check counts', () => {
    expect(parseArgs([...BASE, '--ignore-checks', ''])).toMatchObject({
      policy: { ignoredChecks: [] },
    });
  });

  it('leaves the check lists unset (defaults apply) when not given', () => {
    const parsed = parseArgs(BASE);

    expect(parsed.command === 'reconcile' && 'holdChecks' in parsed.policy).toBe(false);
  });

  it('parses and trims trusted authors', () => {
    expect(parseArgs([...BASE, '--trusted-authors', 'rmartz, other ,'])).toMatchObject({
      policy: { trustedAuthors: ['rmartz', 'other'] },
    });
  });

  it('accepts a repo name with dots and underscores', () => {
    expect(parseArgs(['reconcile', '--repo', 'o/my.repo_x', '--pr', '1'])).toMatchObject({
      repo: 'my.repo_x',
    });
  });

  it('accepts flags in any order', () => {
    expect(parseArgs(['reconcile', '--pr', '9', '--json', '--repo', 'a/b'])).toMatchObject({
      pr: 9,
      json: true,
    });
  });
});

describe('parseArgs — usage errors', () => {
  it.each([
    [['reconcile', '--pr', '7'], '--repo <owner/repo> is required'],
    [['reconcile', '--repo', 'not-a-slug', '--pr', '7'], '--repo <owner/repo> is required'],
    [['reconcile', '--repo', 'a/b'], '--pr <number> is required and must be a positive integer'],
    [
      ['reconcile', '--repo', 'a/b', '--pr', '0'],
      '--pr <number> is required and must be a positive integer',
    ],
    [
      ['reconcile', '--repo', 'a/b', '--pr', '7x'],
      '--pr <number> is required and must be a positive integer',
    ],
    [['reconcile', '--repo', 'a/b', '--pr'], '--pr requires a value'],
    [['reconcile', '--repo', '--pr', '7'], '--repo requires a value'],
    [[...BASE, '--trusted-authors', ' , '], '--trusted-authors needs at least one login'],
    [[...BASE, '--bogus'], 'Unknown option: --bogus'],
  ])('rejects %j', (argv, message) => {
    expect(parseArgs(argv)).toEqual({ command: 'error', message });
  });
});
