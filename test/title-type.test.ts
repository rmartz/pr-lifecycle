import { describe, expect, it } from 'vitest';

import { titleType } from '../src/title-type.js';

describe('titleType', () => {
  it('reads the type through a scope and a breaking marker', () => {
    expect(titleType('feat(cli)!: drop a flag')).toBe('feat');
  });

  it('reads the ci type', () => {
    expect(titleType('ci: pin the setup action')).toBe('ci');
  });

  it('reads no type from a title without a subject', () => {
    expect(titleType('docs: ')).toBeUndefined();
  });

  it.each(['Add a thing', 'docs:missing space', 'Docs: wrong case', 'wip: unknown type', ''])(
    'reads no type from the unparseable title %j',
    (title) => {
      expect(titleType(title)).toBeUndefined();
    },
  );
});
