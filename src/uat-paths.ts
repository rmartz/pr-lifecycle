import type { FileChange } from './facts.js';

/**
 * Which PRs can't need UAT, judged from their changed paths alone: the fallback
 * for a title that doesn't exempt the PR (docs/uat.md). Ported from pr-policy's
 * trivial-path rules (`src/checks/uat/trivial.ts` there). These rules only ever
 * **exempt**: a PR is trivial when every path falls in an exempt category, and a
 * single path outside them leaves it needing UAT.
 *
 * One deliberate narrowing: workflow and composite-action files are never
 * exempt here. pr-policy tells a repo's own CI from a shipped reusable workflow
 * by parsing the YAML; this package doesn't, and a `ci:` title already exempts
 * the routine CI change.
 *
 * Separate from any "safe to approve without review" predicate on purpose: a
 * change can need review and not UAT, and the two questions must not share an
 * answer.
 */

export const TRIVIAL_CATEGORIES = ['docs', 'tests', 'dependencies', 'metadata'] as const;
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

function categoryOf(path: string, manifests: readonly FileChange[]): TrivialCategory | undefined {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  if (name.endsWith('.md') || parts[0] === 'docs') {
    return 'docs';
  }
  if (isTestPath(path)) {
    return 'tests';
  }
  // CI or a shipped workflow? Telling them apart needs the YAML (see above).
  if (path.startsWith('.github/workflows/') || path.startsWith('.github/actions/')) {
    return undefined;
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
 * The exempt categories the PR's paths fall in, or `undefined` when any path
 * falls outside them or the paths are unknown. A PR that touches no files is
 * trivially exempt.
 */
export function trivialCategories(
  paths: readonly string[] | undefined,
  manifests: readonly FileChange[] = [],
): TrivialCategory[] | undefined {
  if (paths === undefined) {
    return undefined;
  }
  const found = new Set<TrivialCategory>();
  for (const path of paths) {
    const category = categoryOf(path, manifests);
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
