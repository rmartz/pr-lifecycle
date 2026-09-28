/**
 * Which files are prose for approval carry-over: a clean base merge in which both
 * sides edited the same prose file doesn't carry an approval over, because no CI
 * check can tell whether two concurrent edits to a page still read correctly
 * together (docs/reconciler-design.md §Approval carry-over).
 *
 * Patterns match a file's **basename** with `*` as the only wildcard; a leading
 * `!` excludes. A file is prose when it matches some pattern and no exclusion.
 */

/** Every Markdown file except index pages, which take routine concurrent appends. */
export const DEFAULT_PROSE_PATTERNS: readonly string[] = ['*.md', '!index.md'];

function compile(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
}

export type ProseMatcher = (path: string) => boolean;

export function proseMatcher(patterns: readonly string[]): ProseMatcher {
  const include = patterns.filter((pattern) => !pattern.startsWith('!')).map(compile);
  const exclude = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => compile(pattern.slice(1)));
  return (path) => {
    const basename = path.slice(path.lastIndexOf('/') + 1);
    return (
      include.some((regex) => regex.test(basename)) &&
      !exclude.some((regex) => regex.test(basename))
    );
  };
}

/** Prose paths changed on both sides of a merge, sorted. */
export function overlappingProse(
  ours: readonly string[],
  theirs: readonly string[],
  isProse: ProseMatcher,
): string[] {
  const theirSet = new Set(theirs);
  return ours.filter((path) => theirSet.has(path) && isProse(path)).sort();
}
