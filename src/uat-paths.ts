import { isShippedReusableWorkflow } from './ci-change/reusable-workflow.js';
import type { FileChange } from './facts.js';

/**
 * Which changed paths are statically safe, for the CI classification
 * (docs/sign-off-status.md#the-classification): a PR whose paths are all CI or
 * statically safe, at least one of them CI, is a CI change. Ported from
 * pr-policy's trivial-path rules (`src/checks/uat/trivial.ts` there). A PR is
 * trivial when every path falls in one of these categories; a single path
 * outside them makes it not a CI change. No path exempts a PR from UAT
 * (docs/uat.md#who-decides).
 *
 * CI paths (the repo's own workflows and composite actions) are a category of
 * their own: `ci`. A shipped reusable workflow is product code, not CI, so it
 * falls in no category.
 *
 * Separate from any "safe to approve without review" predicate on purpose: the
 * two questions must not share an answer.
 */

export const TRIVIAL_CATEGORIES = ['docs', 'tests', 'ci', 'dependencies', 'metadata'] as const;
export type TrivialCategory = (typeof TRIVIAL_CATEGORIES)[number];

export const LOCKFILES: ReadonlySet<string> = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'go.sum',
]);

/** The `package.json` blocks a dependency-only change may touch, plus `packageManager`. */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'packageManager',
] as const;

const ROOT_METADATA =
  /^(LICEN[CS]E|COPYING)(\..+)?$|^CODEOWNERS$|^\.(gitignore|gitattributes|editorconfig)$/;

const TEST_DIRS: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
  '__snapshots__',
  '__mocks__',
  'e2e',
]);
// Storybook stories are tests: a story never ships in the app.
const TEST_FILE =
  /\.(test|spec)\.[cm]?[jt]sx?$|\.stories\.([cm]?[jt]sx?|mdx)$|^test_.*\.py$|_test\.(py|go)$|^conftest\.py$/;

const REQUIREMENTS_FILE = /^requirements[\w.-]*\.txt$/;

/** Whether a changed path is a test, fixture, snapshot, mock, or Storybook story. */
export function isTestPath(path: string): boolean {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  return parts.slice(0, -1).some((dir) => TEST_DIRS.has(dir)) || TEST_FILE.test(name);
}

function isManifestPath(parts: readonly string[], name: string): boolean {
  return (
    !parts.includes('node_modules') && (name === 'package.json' || REQUIREMENTS_FILE.test(name))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural equality over parsed JSON. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => jsonEqual(entry, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
    );
  }
  return false;
}

/** The manifest without its dependency fields, or undefined when it isn't a JSON object. */
function withoutDependencies(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const rest = { ...parsed };
  for (const field of DEPENDENCY_FIELDS) {
    delete rest[field];
  }
  return rest;
}

/**
 * Whether a `package.json` change touches only dependency versions. A change to
 * `scripts`, `exports`, or `pnpm.overrides` can change what ships, so it doesn't
 * qualify. An added, deleted, unread, or unparseable manifest doesn't either.
 */
function isDependencyOnlyManifest(change: FileChange | undefined): boolean {
  if (change?.baseText === undefined || change.headText === undefined) {
    return false;
  }
  const before = withoutDependencies(change.baseText);
  const after = withoutDependencies(change.headText);
  return before !== undefined && after !== undefined && jsonEqual(before, after);
}

function categoryOf(
  path: string,
  manifests: readonly FileChange[],
  workflows: readonly FileChange[],
): TrivialCategory | undefined {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  if (name.endsWith('.md') || parts[0] === 'docs') {
    return 'docs';
  }
  if (isTestPath(path)) {
    return 'tests';
  }
  if (path.startsWith('.github/workflows/') || path.startsWith('.github/actions/')) {
    // An unread workflow counts as CI: the loosening rules fail closed on it.
    const change = workflows.find((file) => file.path === path);
    return change !== undefined && isShippedReusableWorkflow(change) ? undefined : 'ci';
  }
  if (LOCKFILES.has(name)) {
    return 'dependencies';
  }
  if (isManifestPath(parts, name)) {
    if (name !== 'package.json') {
      return 'dependencies'; // requirements*.txt holds only pins
    }
    const change = manifests.find((file) => file.path === path);
    return isDependencyOnlyManifest(change) ? 'dependencies' : undefined;
  }
  if (parts[0] === '.github' || parts[0] === '.vscode') {
    return 'metadata';
  }
  if (parts.length === 1 && ROOT_METADATA.test(name)) {
    return 'metadata';
  }
  return undefined;
}

/**
 * The statically safe categories the PR's paths fall in, or `undefined` when
 * any path falls outside them or the paths are unknown. A PR that touches no
 * files falls in none and is trivially safe. `workflows` is the changed workflows' text, which tells a
 * shipped reusable workflow from CI.
 */
export function trivialCategories(
  paths: readonly string[] | undefined,
  manifests: readonly FileChange[] = [],
  workflows: readonly FileChange[] = [],
): TrivialCategory[] | undefined {
  if (paths === undefined) {
    return undefined;
  }
  const found = new Set<TrivialCategory>();
  for (const path of paths) {
    const category = categoryOf(path, manifests, workflows);
    if (category === undefined) {
      return undefined;
    }
    found.add(category);
  }
  return TRIVIAL_CATEGORIES.filter((category) => found.has(category));
}

/** Whether `path` is a `package.json` whose content the path rules need. */
export function isPackageManifest(path: string): boolean {
  const parts = path.split('/');
  return !parts.includes('node_modules') && parts.at(-1) === 'package.json';
}
