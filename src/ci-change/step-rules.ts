/**
 * Step-level rules: which steps a job lost, and the per-step guards.
 */
import { looseningIndicator, type Indicator } from './indicators.js';
import { guardIndicators } from './common-rules.js';
import { asArray, asRecord, stripActionRef, type Node } from './structure.js';

/** The `steps:` sequence of a job, or `[]` when the job declares none. */
export function stepsOf(job: Node): Node[] {
  return asArray(asRecord(job)?.steps) ?? [];
}

/**
 * A stable identity for a step, used to pair base and head steps.
 *
 * Index is deliberately *not* part of the identity: reordering steps is not a
 * loosening, and an index-based pairing would report every step after an
 * insertion as removed. The fallbacks descend from most to least explicit, and a
 * step with none of them falls back to its own serialized content — which pairs
 * an untouched step with itself and treats an edited one as a replacement (the
 * containment backstop then reports the edit as unclassified).
 */
export function stepKey(step: Node): string {
  const map = asRecord(step);
  if (!map) return JSON.stringify(step ?? null);
  const { id, name, uses, run } = map;
  if (typeof id === 'string') return `id:${id}`;
  if (typeof name === 'string') return `name:${name}`;
  if (typeof uses === 'string') return `uses:${stripActionRef(uses)}`;
  if (typeof run === 'string') return `run:${run}`;
  return `step:${JSON.stringify(map)}`;
}

function byKey(steps: readonly Node[]): Map<string, Node> {
  const index = new Map<string, Node>();
  for (const step of steps) {
    const key = stepKey(step);
    // First occurrence wins: a duplicated key is pathological, and pairing the
    // first of each side keeps the comparison deterministic.
    if (!index.has(key)) index.set(key, step);
  }
  return index;
}

/** Removed steps plus the per-step guards, for one job present on both sides. */
export function stepIndicators(file: string, jobId: string, base: Node, head: Node): Indicator[] {
  const before = byKey(stepsOf(base));
  const after = byKey(stepsOf(head));
  const found: Indicator[] = [];

  for (const [key, step] of before) {
    const location = `jobs.${jobId}.steps[${key}]`;
    const counterpart = after.get(key);
    if (counterpart === undefined) {
      found.push(
        looseningIndicator('step-removed', file, location, `Step \`${key}\` was removed.`),
      );
      continue;
    }
    found.push(...guardIndicators(file, location, step, counterpart));
  }

  return found;
}
