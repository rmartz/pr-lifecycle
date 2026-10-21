import { describe, expect, it } from 'vitest';
import { classifyWorkflowFile } from '../../src/ci-change/classify.js';
import { BASE_WORKFLOW, WORKFLOW_PATH, edited, kindsFor } from './fixtures/workflow.js';

describe('ambiguous indicators', () => {
  it('flags a changed runner target', () => {
    const head = edited(
      '  build:\n    runs-on: ubuntu-latest',
      '  build:\n    runs-on: ubuntu-22.04',
    );
    expect(kindsFor(head)).toEqual(['runs-on-changed']);
  });

  it('flags a workflow-level permissions change', () => {
    const head = edited('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n');
    expect(kindsFor(head)).toEqual(['permissions-changed']);
  });

  it('flags a job-level permissions change', () => {
    const head = edited(
      '    permissions:\n      contents: read\n',
      '    permissions:\n      contents: read\n      checks: write\n',
    );
    expect(kindsFor(head)).toEqual(['permissions-changed']);
  });

  it('flags a workflow-level env change', () => {
    const head = edited("env:\n  CI: 'true'\n", "env:\n  CI: 'false'\n");
    expect(kindsFor(head)).toEqual(['env-changed']);
  });

  it('flags a timeout change in either direction', () => {
    const head = edited('    timeout-minutes: 5', '    timeout-minutes: 30');
    expect(kindsFor(head)).toEqual(['timeout-changed']);
  });

  it('flags an unparseable head document rather than guessing', () => {
    const found = classifyWorkflowFile({
      path: WORKFLOW_PATH,
      baseText: BASE_WORKFLOW,
      headText: 'jobs:\n  build:\n   - [unbalanced\n',
    });
    expect(found.map((i) => i.kind)).toEqual(['unparseable']);
  });

  it('flags a structural edit no named rule recognises as unclassified-change', () => {
    // A rewritten `run:` body changes what a step actually verifies, but no named
    // rule covers it — only the containment backstop can catch it.
    const head = edited('        run: pnpm test', '        run: pnpm test --silent');
    expect(kindsFor(head)).toEqual(['unclassified-change']);
  });

  it('flags a removed top-level block through the rule that owns it', () => {
    const head = edited("env:\n  CI: 'true'\n", '');
    expect(kindsFor(head)).toEqual(['env-changed']);
  });
});

describe('tightening and maintenance', () => {
  it('reports nothing for a newly added workflow file', () => {
    const found = classifyWorkflowFile({
      path: WORKFLOW_PATH,
      baseText: undefined,
      headText: BASE_WORKFLOW,
    });
    expect(found).toEqual([]);
  });

  it('reports nothing when a job is added', () => {
    const head = `${BASE_WORKFLOW}  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm lint\n`;
    expect(kindsFor(head)).toEqual([]);
  });

  it('reports nothing when a step is added', () => {
    const head = edited(
      '      - name: Test\n        run: pnpm test\n',
      '      - name: Test\n        run: pnpm test\n      - name: Typecheck\n        run: pnpm typecheck\n',
    );
    expect(kindsFor(head)).toEqual([]);
  });

  it('reports nothing for an action version bump', () => {
    const head = edited('      - uses: actions/checkout@v4', '      - uses: actions/checkout@v5');
    expect(kindsFor(head)).toEqual([]);
  });

  it('reports nothing when a matrix dimension gains a value', () => {
    const head = edited('        node: [20, 22]', '        node: [20, 22, 24]');
    expect(kindsFor(head)).toEqual([]);
  });

  it('reports nothing when a trigger event is added', () => {
    const head = edited(
      '  push:\n    branches: [main]\n',
      '  push:\n    branches: [main]\n  workflow_dispatch:\n',
    );
    expect(kindsFor(head)).toEqual([]);
  });

  it('reports nothing for a comment-only edit', () => {
    const head = `# Runs the pull-request gate.\n${BASE_WORKFLOW}`;
    expect(kindsFor(head)).toEqual([]);
  });

  it('reports nothing when steps are only reordered', () => {
    const head = edited(
      '      - name: Install\n        run: pnpm install --frozen-lockfile\n      - name: Test\n        run: pnpm test\n',
      '      - name: Test\n        run: pnpm test\n      - name: Install\n        run: pnpm install --frozen-lockfile\n',
    );
    expect(kindsFor(head)).toEqual([]);
  });
});
