/**
 * Workflow-level rules: the `on:` trigger surface, plus the top-level
 * `permissions` and `env` blocks the CI directive calls out as ambiguous.
 */
import { ambiguousIndicator, looseningIndicator, type Indicator } from './indicators.js';
import { asArray, asRecord, deepEqual, missingEntries, type Node } from './structure.js';

/**
 * Filter keys that *widen* what triggers CI, so losing an entry narrows the
 * trigger — and so does gaining the key at all, since an absent key means "no
 * filter", i.e. everything matches.
 */
const INCLUSIVE_FILTERS = ['branches', 'tags', 'paths', 'types'] as const;

/** Filter keys that *exclude*, so gaining an entry narrows the trigger. */
const EXCLUSIVE_FILTERS = ['branches-ignore', 'tags-ignore', 'paths-ignore'] as const;

/**
 * Read the `on:` block as a map of event name → filter mapping.
 *
 * GitHub accepts three spellings (`on: push`, `on: [push, pull_request]`, and the
 * mapping form), and a YAML 1.1 parser folds the key `on` to the boolean `true`,
 * which lands in a JS object as the key `"true"`. Normalising all four here keeps
 * every caller on one shape.
 */
export function triggersOf(doc: Node): Record<string, Node> | undefined {
  const map = asRecord(doc);
  if (!map) return undefined;
  const on = 'on' in map ? map.on : map.true;
  if (on === undefined) return undefined;
  if (typeof on === 'string') return { [on]: {} };
  const seq = asArray(on);
  if (seq) {
    const out: Record<string, Node> = {};
    for (const event of seq) if (typeof event === 'string') out[event] = {};
    return out;
  }
  const onMap = asRecord(on);
  if (!onMap) return undefined;
  const out: Record<string, Node> = {};
  for (const [event, filters] of Object.entries(onMap)) out[event] = filters ?? {};
  return out;
}

function filterIndicators(file: string, event: string, base: Node, head: Node): Indicator[] {
  const found: Indicator[] = [];
  const at = (key: string) => `on.${event}.${key}`;

  // `schedule` (and any other sequence-valued event) narrows by losing entries.
  const baseSeq = asArray(base);
  const headSeq = asArray(head);
  if (baseSeq) {
    const dropped = missingEntries(baseSeq, headSeq ?? []);
    if (dropped.length > 0) {
      found.push(
        looseningIndicator(
          'trigger-narrowed',
          file,
          `on.${event}`,
          `${dropped.length} \`${event}\` entr${dropped.length === 1 ? 'y' : 'ies'} removed.`,
        ),
      );
    }
    return found;
  }

  const baseFilters = asRecord(base) ?? {};
  const headFilters = asRecord(head) ?? {};

  for (const key of INCLUSIVE_FILTERS) {
    const before = asArray(baseFilters[key]);
    const after = asArray(headFilters[key]);
    if (!before && after) {
      found.push(
        looseningIndicator(
          'trigger-narrowed',
          file,
          at(key),
          `\`${key}\` filter added to \`${event}\`, which previously matched everything.`,
        ),
      );
      continue;
    }
    if (!before) continue;
    const dropped = missingEntries(before, after ?? []);
    if (dropped.length > 0) {
      found.push(
        looseningIndicator(
          'trigger-narrowed',
          file,
          at(key),
          `${dropped.map((entry) => `\`${String(entry)}\``).join(', ')} removed from \`${key}\`.`,
        ),
      );
    }
  }

  for (const key of EXCLUSIVE_FILTERS) {
    const before = asArray(baseFilters[key]) ?? [];
    const after = asArray(headFilters[key]) ?? [];
    const added = missingEntries(after, before);
    if (added.length > 0) {
      found.push(
        looseningIndicator(
          'trigger-narrowed',
          file,
          at(key),
          `${added.map((entry) => `\`${String(entry)}\``).join(', ')} added to \`${key}\`, excluding more runs.`,
        ),
      );
    }
  }

  return found;
}

/** Every trigger-narrowing indicator between two parsed workflow documents. */
export function triggerIndicators(file: string, base: Node, head: Node): Indicator[] {
  const before = triggersOf(base);
  const after = triggersOf(head);
  if (!before) return [];
  const found: Indicator[] = [];
  for (const [event, filters] of Object.entries(before)) {
    if (!after || !(event in after)) {
      found.push(
        looseningIndicator(
          'trigger-narrowed',
          file,
          `on.${event}`,
          `The \`${event}\` trigger was removed.`,
        ),
      );
      continue;
    }
    found.push(...filterIndicators(file, event, filters, after[event]));
  }
  return found;
}

/**
 * Top-level `permissions` and `env` changes. The CI directive classes both as
 * ambiguous — a token scope or an environment value can change what a check
 * actually verifies without touching a single step.
 */
export function topLevelIndicators(file: string, base: Node, head: Node): Indicator[] {
  const baseMap = asRecord(base) ?? {};
  const headMap = asRecord(head) ?? {};
  const found: Indicator[] = [];
  for (const key of ['permissions', 'env'] as const) {
    const before = baseMap[key];
    const after = headMap[key];
    if (before === undefined && after === undefined) continue;
    if (deepEqual(before, after)) continue;
    found.push(
      ambiguousIndicator(
        key === 'permissions' ? 'permissions-changed' : 'env-changed',
        file,
        key,
        `Workflow-level \`${key}\` changed.`,
      ),
    );
  }
  return found;
}
