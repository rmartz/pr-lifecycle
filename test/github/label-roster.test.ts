import { describe, expect, it } from 'vitest';

import { labelDefinition, OWNED_LABEL_DEFINITIONS } from '../../src/github/label-roster.js';
import { AUTO_MERGE_LABEL, DEPENDABOT_REBASING_LABEL, LIFECYCLE_LABELS } from '../../src/plan.js';
import { CI_APPROVAL_NEEDED_LABEL } from '../../src/sign-off-plan.js';
import { UAT_LABELS } from '../../src/uat.js';

describe('label roster', () => {
  it('defines every label the core can write', () => {
    const defined = Object.values(OWNED_LABEL_DEFINITIONS).map((label) => label.name);

    expect(defined.sort()).toEqual(
      [
        ...LIFECYCLE_LABELS,
        ...UAT_LABELS,
        AUTO_MERGE_LABEL,
        CI_APPROVAL_NEEDED_LABEL,
        DEPENDABOT_REBASING_LABEL,
      ].sort(),
    );
  });

  it('mirrors the fleet roster for the UAT labels', () => {
    expect(labelDefinition('UAT pending')).toEqual({
      name: 'UAT pending',
      color: '0891B2',
      description: 'UAT required but PR has outstanding issues blocking testing.',
    });
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
