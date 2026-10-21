/**
 * Job-level rules: which jobs a workflow lost, and what changed in the ones it
 * kept — `needs:`, the build matrix, `runs-on:`, `permissions:`, and the shared
 * field guards.
 */
import { ambiguousIndicator, looseningIndicator, type Indicator } from './indicators.js';
import { guardIndicators } from './common-rules.js';
import { stepIndicators } from './step-rules.js';
import {
  asArray,
  asNameList,
  asRecord,
  deepEqual,
  missingEntries,
  type Node,
} from './structure.js';

/** The `jobs:` mapping of a workflow document, or `{}` when it declares none. */
export function jobsOf(doc: Node): Record<string, Node> {
  return asRecord(asRecord(doc)?.jobs) ?? {};
}

/** `needs:` entries a job no longer waits on — each one is a dropped dependency. */
function needsIndicators(file: string, jobId: string, base: Node, head: Node): Indicator[] {
  const before = asNameList(asRecord(base)?.needs);
  const after = new Set(asNameList(asRecord(head)?.needs));
  const dropped = before.filter((dependency) => !after.has(dependency));
  if (dropped.length === 0) return [];
  return [
    looseningIndicator(
      'needs-reduced',
      file,
      `jobs.${jobId}.needs`,
      `${dropped.map((name) => `\`${name}\``).join(', ')} removed from \`needs\`, so the job no longer waits on it.`,
    ),
  ];
}

/**
 * Matrix shrinkage. Three distinct ways a matrix covers less ground: a whole
 * dimension disappears, a dimension loses values, or `exclude` gains an entry
 * (which removes a combination without touching any dimension).
 */
function matrixIndicators(file: string, jobId: string, base: Node, head: Node): Indicator[] {
  const before = asRecord(asRecord(base)?.strategy)?.matrix;
  if (before === undefined) return [];
  const beforeMap = asRecord(before);
  const afterMap = asRecord(asRecord(asRecord(head)?.strategy)?.matrix);
  const at = `jobs.${jobId}.strategy.matrix`;

  if (!beforeMap) return [];
  if (!afterMap) {
    return [
      looseningIndicator('matrix-reduced', file, at, 'The build matrix was removed entirely.'),
    ];
  }

  const found: Indicator[] = [];
  for (const [dimension, values] of Object.entries(beforeMap)) {
    if (dimension === 'exclude') continue;
    if (!(dimension in afterMap)) {
      found.push(
        looseningIndicator(
          'matrix-reduced',
          file,
          `${at}.${dimension}`,
          `Matrix dimension \`${dimension}\` was removed.`,
        ),
      );
      continue;
    }
    const beforeValues = asArray(values);
    if (!beforeValues) continue;
    const dropped = missingEntries(beforeValues, asArray(afterMap[dimension]) ?? []);
    if (dropped.length > 0) {
      found.push(
        looseningIndicator(
          'matrix-reduced',
          file,
          `${at}.${dimension}`,
          `${dropped.length} value${dropped.length === 1 ? '' : 's'} removed from matrix dimension \`${dimension}\`.`,
        ),
      );
    }
  }

  const addedExclusions = missingEntries(
    asArray(afterMap.exclude) ?? [],
    asArray(beforeMap.exclude) ?? [],
  );
  if (addedExclusions.length > 0) {
    found.push(
      looseningIndicator(
        'matrix-reduced',
        file,
        `${at}.exclude`,
        `${addedExclusions.length} combination${addedExclusions.length === 1 ? '' : 's'} added to \`exclude\`.`,
      ),
    );
  }

  return found;
}

/** `runs-on:` and job-level `permissions:` — both ambiguous per the CI directive. */
function jobSurfaceIndicators(file: string, jobId: string, base: Node, head: Node): Indicator[] {
  const before = asRecord(base) ?? {};
  const after = asRecord(head) ?? {};
  const found: Indicator[] = [];
  if (!deepEqual(before['runs-on'], after['runs-on'])) {
    found.push(
      ambiguousIndicator(
        'runs-on-changed',
        file,
        `jobs.${jobId}.runs-on`,
        `\`runs-on\` changed, so the job runs on a different runner.`,
      ),
    );
  }
  if (!deepEqual(before.permissions, after.permissions)) {
    found.push(
      ambiguousIndicator(
        'permissions-changed',
        file,
        `jobs.${jobId}.permissions`,
        `Job-level \`permissions\` changed.`,
      ),
    );
  }
  return found;
}

/** Every job- and step-level indicator between two parsed workflow documents. */
export function jobIndicators(file: string, base: Node, head: Node): Indicator[] {
  const before = jobsOf(base);
  const after = jobsOf(head);
  const found: Indicator[] = [];

  for (const [jobId, job] of Object.entries(before)) {
    const counterpart = after[jobId];
    if (counterpart === undefined) {
      found.push(
        looseningIndicator('job-removed', file, `jobs.${jobId}`, `Job \`${jobId}\` was removed.`),
      );
      continue;
    }
    found.push(
      ...guardIndicators(file, `jobs.${jobId}`, job, counterpart),
      ...jobSurfaceIndicators(file, jobId, job, counterpart),
      ...needsIndicators(file, jobId, job, counterpart),
      ...matrixIndicators(file, jobId, job, counterpart),
      ...stepIndicators(file, jobId, job, counterpart),
    );
  }

  return found;
}
