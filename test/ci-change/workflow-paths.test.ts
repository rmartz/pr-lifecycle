import { describe, expect, it } from 'vitest';
import { isWorkflowPath } from '../../src/ci-change/workflow-paths.js';

describe('isWorkflowPath', () => {
  it('matches a .yml workflow', () => {
    expect(isWorkflowPath('.github/workflows/ci.yml')).toBe(true);
  });

  it('matches a .yaml workflow', () => {
    expect(isWorkflowPath('.github/workflows/release.yaml')).toBe(true);
  });

  it('matches a workflow in a subdirectory', () => {
    expect(isWorkflowPath('.github/workflows/nested/ci.yml')).toBe(true);
  });

  it('rejects a composite action definition', () => {
    expect(isWorkflowPath('.github/actions/setup/action.yml')).toBe(false);
  });

  it('rejects a non-YAML file in the workflows directory', () => {
    expect(isWorkflowPath('.github/workflows/README.md')).toBe(false);
  });

  it('rejects a workflows directory nested under another path', () => {
    expect(isWorkflowPath('vendor/.github/workflows/ci.yml')).toBe(false);
  });
});
