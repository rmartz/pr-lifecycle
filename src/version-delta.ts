import type { DependabotUpdateType } from './dependabot-versions.js';
import type { ChangedFile } from './release-diff.js';

/**
 * Version arithmetic and diff evidence for a dependency bump whose update type
 * Dependabot didn't state (a security update, #92): the semver delta between two
 * versions, and whether the PR's diff actually shows them. Diffs are untrusted
 * input, so the scans use plain string operations. FAIL-SAFE: anything uncertain
 * yields no type or no corroboration. See docs/bot-eligibility.md.
 */

/** A dependency's from → to versions, as Dependabot's prose states them. */
export interface ClaimedBump {
  from: string;
  to: string;
}

function isDigits(part: string): boolean {
  return part !== '' && [...part].every((char) => char >= '0' && char <= '9');
}

/** A plain `major[.minor[.patch]]` version as numbers, or undefined (pre-release, SHA, …). */
function numericVersion(version: string): number[] | undefined {
  const bare = version.startsWith('v') ? version.slice(1) : version;
  const parts = bare.split('.');
  if (parts.length > 3 || !parts.every(isDigits)) {
    return undefined;
  }
  const numbers = parts.map(Number);
  while (numbers.length < 3) {
    numbers.push(0);
  }
  return numbers;
}

/** Update types by the index of the first differing version component. */
const DELTA_BY_COMPONENT: readonly DependabotUpdateType[] = [
  'version-update:semver-major',
  'version-update:semver-minor',
  'version-update:semver-patch',
];

/**
 * The update type of a `from → to` bump, by the first differing component's literal
 * position, as Dependabot computes it. Undefined for anything but a plain numeric
 * upgrade: a pre-release or build suffix, a non-numeric version, no change, or a
 * downgrade.
 */
export function semverDelta(from: string, to: string): DependabotUpdateType | undefined {
  const before = numericVersion(from);
  const after = numericVersion(to);
  if (before === undefined || after === undefined) {
    return undefined;
  }
  for (let index = 0; index < 3; index += 1) {
    const a = before[index] ?? 0;
    const b = after[index] ?? 0;
    if (b !== a) {
      return b > a ? DELTA_BY_COMPONENT[index] : undefined;
    }
  }
  return undefined;
}

function isVersionChar(char: string | undefined): boolean {
  if (char === undefined) {
    return false;
  }
  const code = char.charCodeAt(0);
  const isDigit = code >= 48 && code <= 57;
  const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  return char === '.' || isDigit || isLetter;
}

/**
 * Whether the text before index `at` ends a token boundary for a version: no
 * version character, or a single `v` prefix that is itself on a boundary. The
 * prefix lets `4.1.0` match an action pin's `# v4.1.0` comment, as `semverDelta`
 * already accepts `v4.1.0`, while `xv4.1.0` or `14.1.0` still don't match.
 */
function startsToken(line: string, at: number): boolean {
  const before = line[at - 1];
  if (before === 'v') {
    return !isVersionChar(line[at - 2]);
  }
  return !isVersionChar(before);
}

/** Whether `version` occurs in `line` as a whole token, not inside a longer version. */
function hasVersionToken(line: string, version: string): boolean {
  let from = 0;
  for (;;) {
    const at = line.indexOf(version, from);
    if (at === -1) {
      return false;
    }
    if (startsToken(line, at) && !isVersionChar(line[at + version.length])) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * Whether the PR's diff corroborates a claimed bump: some changed line removes the
 * from-version and some changed line adds the to-version. Dependabot has misstated
 * a from-version before, and pr-policy verifies only the target, so this keeps a
 * misstated `from` from hiding a larger jump. A file whose patch GitHub omitted
 * (a very large lockfile) adds no evidence either way; no files fails closed.
 */
export function diffCorroborates(
  files: readonly ChangedFile[] | undefined,
  bump: ClaimedBump,
): boolean {
  let removed = false;
  let added = false;
  for (const file of files ?? []) {
    for (const line of (file.patch ?? '').split('\n')) {
      if (line.startsWith('-') && !line.startsWith('---') && hasVersionToken(line, bump.from)) {
        removed = true;
      } else if (
        line.startsWith('+') &&
        !line.startsWith('+++') &&
        hasVersionToken(line, bump.to)
      ) {
        added = true;
      }
    }
  }
  return removed && added;
}
