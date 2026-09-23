import { describe, expect, it } from 'vitest';

import { labelDefinition, OWNED_LABEL_DEFINITIONS } from '../../src/github/label-roster.js';
import { AUTO_MERGE_LABEL, LIFECYCLE_LABELS } from '../../src/plan.js';

describe('label roster', () => {
  it('defines every label the core can write', () => {
    const defined = Object.values(OWNED_LABEL_DEFINITIONS).map((label) => label.name);

    expect(defined.sort()).toEqual([...LIFECYCLE_LABELS, AUTO_MERGE_LABEL].sort());
  });

  it('returns the roster definition for an owned label', () => {
    expect(labelDefinition('changes requested').color).toBe('DA3633');
  });

  it('falls back to a plain definition for an unknown label', () => {
    expect(labelDefinition('mystery')).toEqual({
      name: 'mystery',
      color: 'EDEDED',
      description: '',
    });
  });
});
