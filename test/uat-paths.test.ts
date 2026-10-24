import { describe, expect, it } from 'vitest';

import { isTestPath, trivialCategories } from '../src/uat-paths.js';

const BASE_MANIFEST = JSON.stringify(
  { name: 'demo', version: '1.0.0', scripts: { build: 'tsup' }, dependencies: { a: '^1.0.0' } },
  null,
  2,
);

function manifest(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(BASE_MANIFEST) as object), ...overrides }, null, 2);
}

describe('trivialCategories — exempt paths', () => {
  it.each([
    [['pnpm-lock.yaml'], ['dependencies']],
    [['packages/x/yarn.lock', 'go.sum'], ['dependencies']],
    [['requirements-dev.txt'], ['dependencies']],
    [['README.md', 'docs/guide.txt'], ['docs']],
    [['test/a.test.ts', 'src/b.spec.tsx', 'src/c.stories.tsx'], ['tests']],
    [['tests/fixtures/data.json', 'pkg/test_thing.py', 'pkg/thing_test.go'], ['tests']],
    [['.github/dependabot.yml', '.vscode/settings.json'], ['metadata']],
    [['LICENSE', 'CODEOWNERS', '.gitignore', '.editorconfig'], ['metadata']],
    [['.github/workflows/ci.yml'], ['ci']],
    [['.github/actions/setup/action.yml'], ['ci']],
    [
      ['README.md', 'pnpm-lock.yaml'],
      ['docs', 'dependencies'],
    ],
    [[], []],
  ])('exempts %j as %j', (paths, categories) => {
    expect(trivialCategories(paths)).toEqual(categories);
  });

  it('exempts a package.json that changes only dependency versions', () => {
    const change = {
      path: 'package.json',
      baseText: BASE_MANIFEST,
      headText: manifest({ dependencies: { a: '^1.1.0' }, packageManager: 'pnpm@11.0.0' }),
    };

    expect(trivialCategories(['package.json', 'pnpm-lock.yaml'], [change])).toEqual([
      'dependencies',
    ]);
  });
});

const REUSABLE_WORKFLOW = `on:
  workflow_call:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`;

describe('trivialCategories — CI paths', () => {
  it('exempts a workflow whose text was not read as CI', () => {
    expect(trivialCategories(['.github/workflows/ci.yml'], [], [])).toEqual(['ci']);
  });

  it('exempts a workflow with another trigger beside workflow_call as CI', () => {
    const change = {
      path: '.github/workflows/deploy.yml',
      headText: REUSABLE_WORKFLOW.replace('  workflow_call:', '  workflow_call:\n  push:'),
    };

    expect(trivialCategories([change.path], [], [change])).toEqual(['ci']);
  });

  it('does not exempt a shipped reusable workflow', () => {
    const change = { path: '.github/workflows/deploy.yml', headText: REUSABLE_WORKFLOW };

    expect(trivialCategories([change.path], [], [change])).toBeUndefined();
  });

  it('does not exempt a deleted shipped reusable workflow', () => {
    const change = { path: '.github/workflows/deploy.yml', baseText: REUSABLE_WORKFLOW };

    expect(trivialCategories([change.path], [], [change])).toBeUndefined();
  });

  it('exempts an unparseable workflow as CI', () => {
    const change = { path: '.github/workflows/ci.yml', headText: 'on: [' };

    expect(trivialCategories([change.path], [], [change])).toEqual(['ci']);
  });
});

describe('trivialCategories — paths that need UAT', () => {
  it.each([[['src/index.ts']], [['pnpm-lock.yaml', 'src/index.ts']], [['nested/LICENSE']]])(
    'does not exempt %j',
    (paths) => {
      expect(trivialCategories(paths)).toBeUndefined();
    },
  );

  it('does not exempt unknown paths (an incomplete listing)', () => {
    expect(trivialCategories(undefined)).toBeUndefined();
  });

  it('does not exempt a package.json whose scripts changed', () => {
    const change = {
      path: 'package.json',
      baseText: BASE_MANIFEST,
      headText: manifest({ scripts: { build: 'tsup && node evil.js' } }),
    };

    expect(trivialCategories(['package.json'], [change])).toBeUndefined();
  });

  it('does not exempt a package.json whose content was not read', () => {
    expect(trivialCategories(['package.json'])).toBeUndefined();
  });

  it('does not exempt an added package.json', () => {
    const change = { path: 'package.json', headText: BASE_MANIFEST };

    expect(trivialCategories(['package.json'], [change])).toBeUndefined();
  });

  it('does not exempt an unparseable package.json', () => {
    const change = { path: 'package.json', baseText: BASE_MANIFEST, headText: '{ not json' };

    expect(trivialCategories(['package.json'], [change])).toBeUndefined();
  });

  it('does not exempt a package.json that is not an object', () => {
    const change = { path: 'package.json', baseText: BASE_MANIFEST, headText: '[]' };

    expect(trivialCategories(['package.json'], [change])).toBeUndefined();
  });

  it('does not exempt a package.json whose nested field changed', () => {
    const change = {
      path: 'package.json',
      baseText: manifest({ pnpm: { overrides: { a: '1.0.0' } }, files: ['dist'] }),
      headText: manifest({ pnpm: { overrides: { a: '1.0.1' } }, files: ['dist'] }),
    };

    expect(trivialCategories(['package.json'], [change])).toBeUndefined();
  });

  it('does not exempt a package.json whose array field changed', () => {
    const change = {
      path: 'package.json',
      baseText: manifest({ files: ['dist'] }),
      headText: manifest({ files: ['dist', 'src'] }),
    };

    expect(trivialCategories(['package.json'], [change])).toBeUndefined();
  });

  it('does not exempt a package.json that gained a field', () => {
    const change = {
      path: 'package.json',
      baseText: BASE_MANIFEST,
      headText: manifest({ bin: { demo: 'dist/cli.js' } }),
    };

    expect(trivialCategories(['package.json'], [change])).toBeUndefined();
  });

  it('does not exempt a package.json whose array entry changed in place', () => {
    const change = {
      path: 'package.json',
      baseText: manifest({ files: ['dist'] }),
      headText: manifest({ files: ['src'] }),
    };

    expect(trivialCategories(['package.json'], [change])).toBeUndefined();
  });

  it('exempts a package.json whose unchanged arrays and objects match', () => {
    const extra = { files: ['dist'], exports: { '.': './dist/index.js' } };
    const change = {
      path: 'package.json',
      baseText: manifest(extra),
      headText: manifest({ ...extra, dependencies: { a: '^2.0.0' } }),
    };

    expect(trivialCategories(['package.json'], [change])).toEqual(['dependencies']);
  });
});

describe('isTestPath', () => {
  it.each(['__snapshots__/a.snap', 'src/__mocks__/fs.ts', 'e2e/login.ts', 'conftest.py'])(
    'treats %j as a test',
    (path) => {
      expect(isTestPath(path)).toBe(true);
    },
  );

  it('treats a source file named like a test directory as code', () => {
    expect(isTestPath('src/test.ts')).toBe(false);
  });
});
