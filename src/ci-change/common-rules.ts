/**
 * Rules that read identically on a job and on a step: the two loosening guards
 * (`continue-on-error`, a newly-added `if:`) and the two ambiguous ones
 * (`env`, `timeout-minutes`).
 *
 * Jobs and steps are different nodes in the document, but the directive treats
 * these four fields the same way at either level, so they live here once rather
 * than being duplicated — and drifting — across the job and step rule sets.
 */
import { ambiguousIndicator, looseningIndicator, type Indicator } from './indicators.js';
import { asRecord, deepEqual, type Node } from './structure.js';

/**
 * True when `continue-on-error` is switched on. Anything that is not absent and
 * not literal `false` counts — including a `${{ }}` expression, whose value is
 * unknowable statically and must not be read as "off".
 */
function continuesOnError(node: Record<string, Node>): boolean {
  const value = node['continue-on-error'];
  return value !== undefined && value !== false;
}

/**
 * The four field-level rules for one job or step. `location` is the document
 * path the indicators are reported against (e.g. `jobs.build`).
 */
export function guardIndicators(
  file: string,
  location: string,
  base: Node,
  head: Node,
): Indicator[] {
  const before = asRecord(base);
  const after = asRecord(head);
  if (!before || !after) return [];
  const found: Indicator[] = [];

  if (!continuesOnError(before) && continuesOnError(after)) {
    found.push(
      looseningIndicator(
        'continue-on-error-added',
        file,
        `${location}.continue-on-error`,
        `\`continue-on-error\` was enabled, so a failure here no longer fails the run.`,
      ),
    );
  }

  if (before.if === undefined && after.if !== undefined) {
    found.push(
      looseningIndicator(
        'if-added',
        file,
        `${location}.if`,
        `An \`if:\` condition was added to something that previously always ran.`,
      ),
    );
  }

  if (!deepEqual(before.env, after.env)) {
    found.push(ambiguousIndicator('env-changed', file, `${location}.env`, `\`env\` changed.`));
  }

  if (!deepEqual(before['timeout-minutes'], after['timeout-minutes'])) {
    found.push(
      ambiguousIndicator(
        'timeout-changed',
        file,
        `${location}.timeout-minutes`,
        `\`timeout-minutes\` changed from ${JSON.stringify(before['timeout-minutes']) ?? 'unset'} to ${JSON.stringify(after['timeout-minutes']) ?? 'unset'}.`,
      ),
    );
  }

  return found;
}
