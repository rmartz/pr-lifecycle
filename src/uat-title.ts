/**
 * Which PR titles exempt a PR from UAT. The title is parsed with pr-policy's
 * Conventional-Commit grammar (`src/checks/title/conventional.ts` there), so the
 * two packages agree on what a title's type is. See docs/uat.md §Which PRs can't
 * be user-facing.
 */

/** The Conventional-Commit types pr-policy's title grammar accepts. */
export const COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'chore',
  'refactor',
  'test',
  'style',
  'perf',
  'ci',
  'build',
  'revert',
] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];

/**
 * The types that exempt a PR from UAT by title alone. An allowlist on purpose:
 * every other type, and a title that doesn't parse, needs UAT unless its paths
 * exempt it. pr-policy's title check holds `docs`, `test`, and `refactor` to their
 * paths, so a false promise can't merge.
 */
export const UAT_EXEMPT_TYPES = [
  'docs',
  'test',
  'refactor',
  'chore',
  'ci',
] as const satisfies readonly CommitType[];

// `<type>[(<scope>)][!]: <subject>`, exactly as pr-policy and the fleet's
// commit-convention tripwire read it. No overlapping quantifiers: titles are
// author-controlled.
const TITLE = /^([a-z]+)(?:\(([^)]+)\))?(!)?: (\S.*)$/;

function isCommitType(value: string): value is CommitType {
  return COMMIT_TYPES.some((type) => type === value);
}

/** The title's Conventional-Commit type, or undefined when it doesn't parse. */
export function titleType(title: string): CommitType | undefined {
  const type = TITLE.exec(title)?.[1];
  return type !== undefined && isCommitType(type) ? type : undefined;
}

/** Whether the title alone exempts the PR from UAT. */
export function isUatExemptTitle(title: string): boolean {
  const type = titleType(title);
  return type !== undefined && UAT_EXEMPT_TYPES.some((exempt) => exempt === type);
}
