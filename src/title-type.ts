/**
 * A PR title's Conventional-Commit type, parsed with pr-policy's grammar
 * (`src/checks/title/conventional.ts` there), so the two packages agree on what
 * a title's type is. Only the CI classification reads it: a `ci:` title is a CI
 * change (docs/sign-off-status.md). No title exempts a PR from UAT (docs/uat.md).
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
