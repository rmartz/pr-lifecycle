/**
 * Structural helpers shared by every classification rule.
 *
 * Every rule in this package reads a *parsed* workflow document, never the raw
 * diff text: "a step was removed" and "a matrix dimension shrank" are facts about
 * the document tree, and a line-regex over a unified diff cannot see either
 * reliably. These helpers are the narrow vocabulary the rules use to walk that
 * tree without reaching for `any`.
 */

/** A parsed YAML document node of unknown shape. */
export type Node = unknown;

/** Narrow a node to a plain mapping, or `undefined` when it is not one. */
export function asRecord(node: Node): Record<string, Node> | undefined {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
  return node as Record<string, Node>;
}

/** Narrow a node to a sequence, or `undefined` when it is not one. */
export function asArray(node: Node): Node[] | undefined {
  return Array.isArray(node) ? node : undefined;
}

/**
 * Coerce a node to the list of names it denotes. GitHub workflow syntax lets the
 * same field be a bare scalar or a sequence (`needs: build` / `needs: [build,
 * test]`), and a rule that only understood the sequence form would read a scalar
 * as "no entries" and mis-detect a removal.
 */
export function asNameList(node: Node): string[] {
  if (typeof node === 'string') return [node];
  const seq = asArray(node);
  if (!seq) return [];
  return seq.filter((entry): entry is string => typeof entry === 'string');
}

/** Structural equality over parsed YAML values (order-sensitive for sequences). */
export function deepEqual(a: Node, b: Node): boolean {
  if (a === b) return true;
  const aSeq = asArray(a);
  const bSeq = asArray(b);
  if (aSeq && bSeq) {
    return aSeq.length === bSeq.length && aSeq.every((entry, i) => deepEqual(entry, bSeq[i]));
  }
  if (aSeq || bSeq) return false;
  const aMap = asRecord(a);
  const bMap = asRecord(b);
  if (aMap && bMap) {
    const aKeys = Object.keys(aMap);
    const bKeys = Object.keys(bMap);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => key in bMap && deepEqual(aMap[key], bMap[key]));
  }
  return false;
}

/** The entries of `base` that no longer appear in `head` (multiset difference). */
export function missingEntries(base: readonly Node[], head: readonly Node[]): Node[] {
  const remaining = [...head];
  const missing: Node[] = [];
  for (const entry of base) {
    const at = remaining.findIndex((candidate) => deepEqual(candidate, entry));
    if (at === -1) missing.push(entry);
    else remaining.splice(at, 1);
  }
  return missing;
}

/**
 * True when `head` contains everything `base` did — the *pure-addition* relation.
 *
 * This is the backstop that makes the classifier deliberately trigger-happy: a
 * change that satisfies containment added things and removed nothing, so it is
 * maintenance or tightening. Anything else is a structural edit the named rules
 * did not recognise, and {@link ../classify.ts} reports it as ambiguous rather
 * than assuming it is benign. A false positive costs a human one label; a false
 * negative bypasses the sign-off gate entirely.
 */
export function containsAll(base: Node, head: Node): boolean {
  if (deepEqual(base, head)) return true;
  const baseSeq = asArray(base);
  const headSeq = asArray(head);
  if (baseSeq && headSeq) {
    // Greedy containment, not equality: a step that merely *gained* a field is
    // still the same step grown, which is an addition. Matching on deep equality
    // instead would report every such edit as a removal-plus-addition.
    const remaining = [...headSeq];
    for (const entry of baseSeq) {
      const at = remaining.findIndex((candidate) => containsAll(entry, candidate));
      if (at === -1) return false;
      remaining.splice(at, 1);
    }
    return true;
  }
  const baseMap = asRecord(base);
  const headMap = asRecord(head);
  if (baseMap && headMap) {
    return Object.keys(baseMap).every(
      (key) => key in headMap && containsAll(baseMap[key], headMap[key]),
    );
  }
  return false;
}

/** `owner/repo/path@ref` → `owner/repo/path`, so a version bump is not a structural change. */
export function stripActionRef(uses: string): string {
  const at = uses.lastIndexOf('@');
  return at === -1 ? uses : uses.slice(0, at);
}

/**
 * Deep-copy a parsed document with every `uses:` value stripped of its `@ref`.
 *
 * Action version bumps are explicitly *maintenance*, so they must not disturb the
 * containment backstop — `uses: actions/checkout@v4` → `@v5` would otherwise read
 * as a changed scalar and be reported ambiguous on every Dependabot PR.
 */
export function normalizeUses(node: Node): Node {
  const seq = asArray(node);
  if (seq) return seq.map(normalizeUses);
  const map = asRecord(node);
  if (!map) return node;
  const out: Record<string, Node> = {};
  for (const [key, value] of Object.entries(map)) {
    out[key] =
      key === 'uses' && typeof value === 'string' ? stripActionRef(value) : normalizeUses(value);
  }
  return out;
}
