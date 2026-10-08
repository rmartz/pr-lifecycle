import type { ChangedFile } from './release-diff.js';
import type { ClaimedBump } from './version-delta.js';
import { diffCorroborates, semverDelta } from './version-delta.js';

/**
 * Reading a Dependabot commit's `updated-dependencies` metadata into an update
 * type. Version updates carry an `update-type:` line per dependency; security
 * updates leave it out, so for those the type is derived from the bump's versions
 * and corroborated by the diff (#92, the arithmetic in `version-delta.ts`). See
 * docs/bot-eligibility.md.
 *
 * Commit messages are untrusted input, so everything here scans line by line with
 * plain string operations: no backtracking regex runs over the input.
 * FAIL-SAFE: anything uncertain yields no type.
 */

export type { ClaimedBump } from './version-delta.js';

/** Dependabot's semver update types, lowest to highest risk. */
export const DEPENDABOT_UPDATE_TYPES = [
  'version-update:semver-patch',
  'version-update:semver-minor',
  'version-update:semver-major',
] as const;
export type DependabotUpdateType = (typeof DEPENDABOT_UPDATE_TYPES)[number];

export function isUpdateType(value: string): value is DependabotUpdateType {
  return DEPENDABOT_UPDATE_TYPES.some((type) => type === value);
}

export interface UpdatedDependency {
  name: string;
  /** `dependency-version:` (the version updated to), when present. */
  version: string | undefined;
  /** The raw `update-type:` value, when present. */
  updateType: string | undefined;
}

/**
 * The entries of a commit's `updated-dependencies` block, or undefined when the
 * block is missing. Each `- dependency-name:` line starts an entry; the fields
 * after it, up to the next entry or the closing `...`, belong to it.
 */
export function parseUpdatedDependencies(message: string): UpdatedDependency[] | undefined {
  const lines = message.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'updated-dependencies:');
  if (start === -1) {
    return undefined;
  }
  const entries: UpdatedDependency[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed === '...') {
      break;
    }
    if (trimmed.startsWith('- dependency-name:')) {
      entries.push({
        name: trimmed.slice('- dependency-name:'.length).trim(),
        version: undefined,
        updateType: undefined,
      });
      continue;
    }
    const current = entries.at(-1);
    if (current === undefined) {
      continue;
    }
    if (trimmed.startsWith('dependency-version:')) {
      current.version = trimmed.slice('dependency-version:'.length).trim();
    } else if (trimmed.startsWith('update-type:')) {
      current.updateType = trimmed.slice('update-type:'.length).trim();
    }
  }
  return entries;
}

/**
 * The highest update type a commit's metadata states explicitly, or undefined
 * when the block is missing or empty, or when any entry's type is missing or
 * unrecognized. A grouped update lists several dependencies; the riskiest one
 * decides.
 */
export function parseDependabotUpdateType(message: string): DependabotUpdateType | undefined {
  const entries = parseUpdatedDependencies(message);
  if (entries === undefined || entries.length === 0) {
    return undefined;
  }
  let highest = -1;
  for (const entry of entries) {
    if (entry.updateType === undefined || !isUpdateType(entry.updateType)) {
      return undefined;
    }
    highest = Math.max(highest, DEPENDABOT_UPDATE_TYPES.indexOf(entry.updateType));
  }
  return DEPENDABOT_UPDATE_TYPES[highest];
}

/** `from A to B` at the end of a claim line, with any trailing period dropped. */
function fromTo(rest: string): ClaimedBump | undefined {
  const fromAt = rest.lastIndexOf(' from ');
  const toAt = rest.lastIndexOf(' to ');
  if (fromAt === -1 || toAt < fromAt) {
    return undefined;
  }
  const from = rest.slice(fromAt + ' from '.length, toAt).trim();
  let to = rest.slice(toAt + ' to '.length).trim();
  if (to.endsWith('.')) {
    to = to.slice(0, -1);
  }
  return from === '' || to === '' || from.includes(' ') || to.includes(' ')
    ? undefined
    : { from, to };
}

/**
 * The from → to bumps Dependabot's prose claims, by dependency name. Reads the two
 * per-dependency forms pr-policy's `dependabot` check reads too:
 * `Bumps [name](url) from A to B.` (a single update) and
 * ``Updates `name` from A to B`` (each entry of a group).
 */
export function parseClaimedBumps(message: string): Map<string, ClaimedBump> {
  const bumps = new Map<string, ClaimedBump>();
  for (const line of message.split('\n')) {
    const trimmed = line.trim();
    let opener: string | undefined;
    let closer = '';
    if (trimmed.startsWith('Bumps [')) {
      opener = 'Bumps [';
      closer = ']';
    } else if (trimmed.startsWith('Updates `')) {
      opener = 'Updates `';
      closer = '`';
    }
    if (opener === undefined) {
      continue;
    }
    const close = trimmed.indexOf(closer, opener.length);
    if (close === -1) {
      continue;
    }
    const name = trimmed.slice(opener.length, close);
    const bump = fromTo(trimmed.slice(close));
    if (bump !== undefined && !bumps.has(name)) {
      bumps.set(name, bump);
    }
  }
  return bumps;
}

/** A commit's update type, and whether it had to be derived; or why it has none. */
export type CommitUpdateType =
  { type: DependabotUpdateType; derived: boolean } | { type: undefined; reason: string };

/**
 * The highest update type across one Dependabot commit's dependencies. An entry
 * with an explicit `update-type` uses it. An entry without one (a security update)
 * has its type derived: its prose bump must name the same `to` as its
 * `dependency-version`, the delta must be a plain numeric upgrade, and the diff
 * must corroborate the versions. Any entry that can't be classified leaves the
 * whole commit without a type.
 */
export function commitUpdateType(
  message: string,
  files: readonly ChangedFile[] | undefined,
): CommitUpdateType {
  const entries = parseUpdatedDependencies(message);
  if (entries === undefined || entries.length === 0) {
    return { type: undefined, reason: 'no updated-dependencies metadata' };
  }
  const bumps = parseClaimedBumps(message);
  let highest = -1;
  let derived = false;
  for (const entry of entries) {
    if (entry.updateType !== undefined) {
      if (!isUpdateType(entry.updateType)) {
        return { type: undefined, reason: `unrecognized update type for ${entry.name}` };
      }
      highest = Math.max(highest, DEPENDABOT_UPDATE_TYPES.indexOf(entry.updateType));
      continue;
    }
    const bump = bumps.get(entry.name);
    if (bump === undefined || entry.version === undefined || bump.to !== entry.version) {
      return { type: undefined, reason: `no versions stated for ${entry.name}` };
    }
    const type = semverDelta(bump.from, bump.to);
    if (type === undefined) {
      return {
        type: undefined,
        reason: `${entry.name} ${bump.from} → ${bump.to} isn't a plain upgrade`,
      };
    }
    if (!diffCorroborates(files, bump)) {
      return {
        type: undefined,
        reason: `the diff doesn't show ${entry.name} ${bump.from} → ${bump.to}`,
      };
    }
    highest = Math.max(highest, DEPENDABOT_UPDATE_TYPES.indexOf(type));
    derived = true;
  }
  const type = DEPENDABOT_UPDATE_TYPES[highest];
  return type === undefined
    ? { type: undefined, reason: 'no updated-dependencies metadata' }
    : { type, derived };
}
