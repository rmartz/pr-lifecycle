import { describe, expect, it } from 'vitest';

import { DEFAULT_PROSE_PATTERNS, overlappingProse, proseMatcher } from '../../src/lineage/prose.js';

describe('proseMatcher — default patterns', () => {
  const isProse = proseMatcher(DEFAULT_PROSE_PATTERNS);

  it.each(['README.md', 'docs/overview.md', 'a/b/c/AGENTS.md'])('treats %s as prose', (path) => {
    expect(isProse(path)).toBe(true);
  });

  it.each(['index.md', 'docs/index.md', 'src/state.ts', 'docs/notes.mdx', 'md'])(
    'does not treat %s as prose',
    (path) => {
      expect(isProse(path)).toBe(false);
    },
  );
});

describe('proseMatcher — custom patterns', () => {
  it('matches the basename, not the directory', () => {
    expect(proseMatcher(['*.md'])('docs.md/code.ts')).toBe(false);
  });

  it('treats regex metacharacters in a pattern literally', () => {
    expect(proseMatcher(['a+b.txt'])('aab.txt')).toBe(false);
  });

  it('lets an exclusion override an inclusion', () => {
    expect(proseMatcher(['*.md', '*.txt', '!CHANGELOG.md'])('CHANGELOG.md')).toBe(false);
  });

  it('treats nothing as prose with only exclusions', () => {
    expect(proseMatcher(['!index.md'])('guide.md')).toBe(false);
  });
});

describe('overlappingProse', () => {
  const isProse = proseMatcher(DEFAULT_PROSE_PATTERNS);

  it('returns the prose paths both sides changed, sorted', () => {
    expect(
      overlappingProse(
        ['docs/z.md', 'src/a.ts', 'docs/a.md', 'docs/index.md', 'only-ours.md'],
        ['docs/index.md', 'docs/a.md', 'src/a.ts', 'docs/z.md', 'only-theirs.md'],
        isProse,
      ),
    ).toEqual(['docs/a.md', 'docs/z.md']);
  });

  it('is empty when the sides changed different prose', () => {
    expect(overlappingProse(['a.md'], ['b.md'], isProse)).toEqual([]);
  });
});
