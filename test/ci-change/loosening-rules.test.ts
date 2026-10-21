import { describe, expect, it } from 'vitest';
import { classifyWorkflowFile } from '../../src/ci-change/classify.js';
import { BASE_WORKFLOW, WORKFLOW_PATH, edited, kindsFor } from './fixtures/workflow.js';

describe('loosening indicators', () => {
  it('flags a deleted workflow file as workflow-removed', () => {
    const found = classifyWorkflowFile({
      path: WORKFLOW_PATH,
      baseText: BASE_WORKFLOW,
      headText: undefined,
    });
    expect(found.map((i) => i.kind)).toEqual(['workflow-removed']);
  });

  it('flags a removed job as job-removed', () => {
    const head = BASE_WORKFLOW.slice(0, BASE_WORKFLOW.indexOf('  deploy:'));
    expect(kindsFor(head)).toEqual(['job-removed']);
  });

  it('flags a removed step as step-removed', () => {
    const head = edited('      - name: Test\n        run: pnpm test\n', '');
    expect(kindsFor(head)).toEqual(['step-removed']);
  });

  it('names the removed step in the indicator location', () => {
    const head = edited('      - name: Test\n        run: pnpm test\n', '');
    const [found] = classifyWorkflowFile({
      path: WORKFLOW_PATH,
      baseText: BASE_WORKFLOW,
      headText: head,
    });
    expect(found?.location).toBe('jobs.build.steps[name:Test]');
  });

  it('flags continue-on-error added to a step', () => {
    const head = edited(
      '      - name: Test\n        run: pnpm test\n',
      '      - name: Test\n        continue-on-error: true\n        run: pnpm test\n',
    );
    expect(kindsFor(head)).toEqual(['continue-on-error-added']);
  });

  it('ignores continue-on-error explicitly set to false', () => {
    const head = edited(
      '      - name: Test\n        run: pnpm test\n',
      '      - name: Test\n        continue-on-error: false\n        run: pnpm test\n',
    );
    expect(kindsFor(head)).toEqual([]);
  });

  it('treats a continue-on-error expression as enabled, since its value is unknowable', () => {
    const head = edited(
      '      - name: Test\n        run: pnpm test\n',
      '      - name: Test\n        continue-on-error: "${{ github.actor == \'dependabot[bot]\' }}"\n        run: pnpm test\n',
    );
    expect(kindsFor(head)).toEqual(['continue-on-error-added']);
  });

  it('flags an if: added to a previously unconditional step', () => {
    const head = edited(
      '      - name: Test\n        run: pnpm test\n',
      "      - name: Test\n        if: github.ref == 'refs/heads/main'\n        run: pnpm test\n",
    );
    expect(kindsFor(head)).toEqual(['if-added']);
  });

  it('flags an if: added to a previously unconditional job', () => {
    const head = edited(
      '  deploy:\n    needs: [build]\n',
      "  deploy:\n    if: github.event_name == 'push'\n    needs: [build]\n",
    );
    expect(kindsFor(head)).toEqual(['if-added']);
  });

  it('flags a removed trigger event as trigger-narrowed', () => {
    const head = edited('  push:\n    branches: [main]\n', '');
    expect(kindsFor(head)).toEqual(['trigger-narrowed']);
  });

  it('flags a branch dropped from a trigger filter', () => {
    const head = edited("    branches: [main, 'release/**']", '    branches: [main]');
    expect(kindsFor(head)).toEqual(['trigger-narrowed']);
  });

  it('flags a paths filter added where the event previously matched everything', () => {
    const head = edited('  push:\n    branches: [main]\n', '  push:\n    paths: [src/**]\n');
    // The branches filter also disappears, so both narrowings are reported.
    expect(kindsFor(head)).toContain('trigger-narrowed');
  });

  it('flags an entry added to paths-ignore, which excludes more runs', () => {
    const head = edited(
      '  push:\n    branches: [main]\n',
      '  push:\n    branches: [main]\n    paths-ignore: [docs/**]\n',
    );
    expect(kindsFor(head)).toEqual(['trigger-narrowed']);
  });

  it('flags a matrix dimension losing a value', () => {
    const head = edited('        node: [20, 22]', '        node: [22]');
    expect(kindsFor(head)).toEqual(['matrix-reduced']);
  });

  it('flags a whole matrix dimension being removed', () => {
    const head = edited('        os: [ubuntu-latest]\n', '');
    expect(kindsFor(head)).toEqual(['matrix-reduced']);
  });

  it('flags a combination added to matrix exclude', () => {
    const head = edited(
      '        os: [ubuntu-latest]\n',
      '        os: [ubuntu-latest]\n        exclude:\n          - node: 20\n',
    );
    expect(kindsFor(head)).toEqual(['matrix-reduced']);
  });

  it('flags a dependency dropped from needs', () => {
    const head = edited('    needs: [build]\n', '');
    expect(kindsFor(head)).toEqual(['needs-reduced']);
  });

  it('reads a scalar needs the same as a single-entry sequence', () => {
    const base = BASE_WORKFLOW.replace('    needs: [build]', '    needs: build');
    const found = classifyWorkflowFile({
      path: WORKFLOW_PATH,
      baseText: base,
      headText: base.replace('    needs: build\n', ''),
    });
    expect(found.map((i) => i.kind)).toEqual(['needs-reduced']);
  });
});
