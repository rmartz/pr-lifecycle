/**
 * Is a release-please PR's diff a pure release: only the files release-please
 * writes, with `package.json` changed in its `version` line and nowhere else?
 * The branch name alone can't say (any write user can push a `release-please--`
 * branch with arbitrary code), and release-please commits as whoever owns its
 * token, so its commit authors can't either. See docs/bot-eligibility.md.
 *
 * FAIL-SAFE: a file outside the release set, a status other than added or
 * modified, a missing patch, or any doubt about a `package.json` line means the
 * diff is not a release.
 */

/** One changed file, as the PR files API reports it. */
export interface ChangedFile {
  /** Repository-relative path. */
  filename: string;
  /** `added`, `modified`, `removed`, `renamed`, `copied`, `changed`, or `unchanged`. */
  status: string;
  /** The unified-diff hunk text; undefined when GitHub omits it (e.g. a large diff). */
  patch: string | undefined;
}

export type ReleaseDiffVerdict = { release: true } | { release: false; reason: string };

const MANIFEST = '.release-please-manifest.json';
const CHANGELOG = 'CHANGELOG.md';
const PACKAGE_JSON = 'package.json';

// A release only writes files; it never deletes, renames, or copies one.
const RELEASE_STATUSES: ReadonlySet<string> = new Set(['added', 'modified']);

// One `"version": "…"` member on a line of its own. Patches are untrusted input,
// so this has no overlapping quantifiers (no backtracking blowup).
const VERSION_LINE = /^[ \t]*"version"[ \t]*:[ \t]*"[^"\\\n]*"[ \t]*,?[ \t]*$/;

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Whether a `package.json` patch changes exactly one line, its `version`: one
 * removed and one added line, both a bare `"version"` member. Context lines,
 * hunk headers, and the no-newline marker are ignored.
 */
export function isVersionOnlyPatch(patch: string): boolean {
  let removed = 0;
  let added = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('\\') || line.startsWith(' ') || line === '') {
      continue;
    }
    const sign = line[0];
    if ((sign !== '+' && sign !== '-') || !VERSION_LINE.test(line.slice(1))) {
      return false;
    }
    if (sign === '+') {
      added += 1;
    } else {
      removed += 1;
    }
  }
  return added === 1 && removed === 1;
}

function checkFile(file: ChangedFile): string | undefined {
  if (!RELEASE_STATUSES.has(file.status)) {
    return `${file.filename} was ${file.status}`;
  }
  const name = basename(file.filename);
  if (file.filename === MANIFEST || name === CHANGELOG) {
    return undefined;
  }
  if (name !== PACKAGE_JSON) {
    return `${file.filename} is not a release file`;
  }
  if (file.patch === undefined) {
    return `${file.filename} has no patch to verify`;
  }
  return isVersionOnlyPatch(file.patch)
    ? undefined
    : `${file.filename} changes more than its version`;
}

/**
 * The verdict over a PR's changed files. `undefined` means the list couldn't be
 * read in full (truncated or not fetched), which is never a release.
 */
export function classifyReleaseDiff(files: readonly ChangedFile[] | undefined): ReleaseDiffVerdict {
  if (files === undefined) {
    return { release: false, reason: 'changed files unavailable' };
  }
  if (files.length === 0) {
    return { release: false, reason: 'no changed files' };
  }
  for (const file of files) {
    const problem = checkFile(file);
    if (problem !== undefined) {
      return { release: false, reason: problem };
    }
  }
  return { release: true };
}
