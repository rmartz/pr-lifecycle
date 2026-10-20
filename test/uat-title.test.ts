import { describe, expect, it } from 'vitest';

import { isUatExemptTitle, titleType } from '../src/uat-title.js';

describe('isUatExemptTitle', () => {
  it.each([
    'docs: explain the UAT rules',
    'test: cover the classifier',
    'refactor: extract the binding',
    'ci: pin the setup action',
  ])('exempts %j by title', (title) => {
    expect(isUatExemptTitle(title)).toBe(true);
  });

  it.each([
    'chore(deps): Bump left-pad from 1.0.0 to 1.0.1',
    'chore: tidy up',
    'feat: add a thing',
    'fix: stop the crash',
    'perf: cache the lookup',
    'revert: undo the thing',
    'build: change the bundler',
    'style: reformat',
  ])('does not exempt %j by title', (title) => {
    expect(isUatExemptTitle(title)).toBe(false);
  });

  it.each([
    'Add a thing',
    'docs:missing space',
    'Docs: wrong case',
    'docs : stray space',
    'wip: unknown type',
    '',
  ])('does not exempt the unparseable title %j', (title) => {
    expect(isUatExemptTitle(title)).toBe(false);
  });
});

describe('titleType', () => {
  it('reads the type through a scope and a breaking marker', () => {
    expect(titleType('feat(cli)!: drop a flag')).toBe('feat');
  });

  it('reads no type from a title without a subject', () => {
    expect(titleType('docs: ')).toBeUndefined();
  });
});
