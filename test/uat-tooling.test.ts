import { describe, expect, it } from 'vitest';

import type { FileChange } from '../src/facts.js';
import {
  isShippedReusableWorkflow,
  isToolingPath,
  onlyNonUserFacingPaths,
} from '../src/uat-tooling.js';

const CI_WORKFLOW = 'on: [push, pull_request]\njobs: {}\n';

function workflow(text: string | undefined, path = '.github/workflows/ci.yml'): FileChange {
  return text === undefined ? { path } : { path, baseText: text, headText: text };
}

describe('isToolingPath', () => {
  it.each([
    'scripts/dependabot-audit.mjs',
    'scripts/ci/check.sh',
    'eslint.config.js',
    'packages/app/vitest.config.ts',
    '.repo-hygiene.yml',
    '.prettierrc.json',
    '.github/actions/setup/action.yml',
  ])('counts %j as tooling', (path) => {
    expect(isToolingPath(path)).toBe(true);
  });

  it.each([
    'src/index.ts',
    'packages/app/scripts/build.mjs',
    'scripts',
    'tsconfig.json',
    'next.config.ts',
    'vercel.json',
  ])('counts %j as product', (path) => {
    expect(isToolingPath(path)).toBe(false);
  });

  it("counts the repo's own CI workflow as tooling", () => {
    const change = workflow(CI_WORKFLOW);

    expect(isToolingPath(change.path, [change])).toBe(true);
  });

  it('counts a shipped reusable workflow as product', () => {
    const change = workflow('on: workflow_call\njobs: {}\n');

    expect(isToolingPath(change.path, [change])).toBe(false);
  });

  it('counts a workflow whose text it never read as product', () => {
    expect(isToolingPath('.github/workflows/ci.yml')).toBe(false);
  });
});

describe('isShippedReusableWorkflow', () => {
  it.each([
    ['a scalar trigger', 'on: workflow_call\n'],
    ['a sequence', 'on: [workflow_call]\n'],
    ['a mapping', 'on:\n  workflow_call:\n    inputs: {}\n'],
  ])('recognises %s', (_shape, text) => {
    expect(isShippedReusableWorkflow(workflow(text))).toBe(true);
  });

  it('does not count a workflow that is also triggered by push', () => {
    const text = 'on:\n  workflow_call: {}\n  push: {}\n';

    expect(isShippedReusableWorkflow(workflow(text))).toBe(false);
  });

  it('judges a deleted workflow by its base side', () => {
    const deleted = { path: '.github/workflows/ci.yml', baseText: 'on: workflow_call\n' };

    expect(isShippedReusableWorkflow(deleted)).toBe(true);
  });

  it('cannot tell for an unparseable workflow', () => {
    expect(isShippedReusableWorkflow(workflow('on: [unclosed\n'))).toBeUndefined();
  });

  it('cannot tell for a workflow it never read', () => {
    expect(isShippedReusableWorkflow(workflow(undefined))).toBeUndefined();
  });
});

describe('onlyNonUserFacingPaths', () => {
  it('holds for a chore mixing tooling, metadata, and tests', () => {
    const paths = [
      '.github/dependabot.yml',
      'scripts/dependabot-audit.mjs',
      'src/scripts/dependabot-audit.spec.ts',
    ];

    expect(onlyNonUserFacingPaths(paths)).toBe(true);
  });

  it('holds for a CI workflow beside docs', () => {
    const change = workflow(CI_WORKFLOW);

    expect(onlyNonUserFacingPaths([change.path, 'README.md'], [], [change])).toBe(true);
  });

  it('fails for tooling beside product code', () => {
    expect(onlyNonUserFacingPaths(['scripts/a.mjs', 'src/a.ts'])).toBe(false);
  });

  it('fails for an incomplete listing', () => {
    expect(onlyNonUserFacingPaths(undefined)).toBe(false);
  });
});
