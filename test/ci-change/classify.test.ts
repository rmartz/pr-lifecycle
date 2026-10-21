import { describe, expect, it } from 'vitest';
import { classifyWorkflowChanges } from '../../src/ci-change/classify.js';
import { BASE_WORKFLOW, WORKFLOW_PATH, edited } from './fixtures/workflow.js';

describe('classifyWorkflowChanges', () => {
  it('returns no-change when the PR touches no workflow file', () => {
    expect(classifyWorkflowChanges([])).toEqual({ verdict: 'no-change', indicators: [] });
  });

  it('returns tightening when every touched file only gains coverage', () => {
    const result = classifyWorkflowChanges([
      { path: WORKFLOW_PATH, baseText: undefined, headText: BASE_WORKFLOW },
      {
        path: '.github/workflows/lint.yml',
        baseText: BASE_WORKFLOW,
        headText: edited('        node: [20, 22]', '        node: [20, 22, 24]'),
      },
    ]);
    expect(result).toEqual({ verdict: 'tightening', indicators: [] });
  });

  it('returns loosening when any one file loosens, even alongside tightening files', () => {
    const result = classifyWorkflowChanges([
      { path: WORKFLOW_PATH, baseText: undefined, headText: BASE_WORKFLOW },
      {
        path: '.github/workflows/lint.yml',
        baseText: BASE_WORKFLOW,
        headText: edited('        node: [20, 22]', '        node: [22]'),
      },
    ]);
    expect(result.verdict).toBe('loosening');
  });

  it('attributes each indicator to the file it came from', () => {
    const result = classifyWorkflowChanges([
      {
        path: '.github/workflows/lint.yml',
        baseText: BASE_WORKFLOW,
        headText: edited('        node: [20, 22]', '        node: [22]'),
      },
    ]);
    expect(result.indicators.map((i) => i.file)).toEqual(['.github/workflows/lint.yml']);
  });

  it('reads a renamed job as a removal of the old one', () => {
    const result = classifyWorkflowChanges([
      {
        path: WORKFLOW_PATH,
        baseText: BASE_WORKFLOW,
        headText: edited('  deploy:\n', '  publish:\n'),
      },
    ]);
    expect(result.indicators.map((i) => i.kind)).toEqual(['job-removed']);
  });
});
