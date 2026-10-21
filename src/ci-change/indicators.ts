/**
 * The indicator vocabulary — the classifier's whole output surface.
 *
 * Each indicator names one recognised change to a workflow document and the
 * class it falls in. The two classes are asymmetric on purpose: `loosening` is a
 * change the CI directive requires a human to sign off, and `ambiguous` is a
 * change the directive says to *treat as* a loosening because it cannot be shown
 * to be benign. Both produce the same verdict; they are kept apart so the
 * check-run output can tell a reader which it saw.
 */

/** Changes that reduce CI coverage outright (review.md Step 5, "loosening indicators"). */
export const LOOSENING_INDICATORS = [
  'workflow-removed',
  'job-removed',
  'step-removed',
  'continue-on-error-added',
  'if-added',
  'trigger-narrowed',
  'matrix-reduced',
  'needs-reduced',
] as const;

/** Changes the directive says to treat as loosening because they are not clearly tightening. */
export const AMBIGUOUS_INDICATORS = [
  'runs-on-changed',
  'permissions-changed',
  'env-changed',
  'timeout-changed',
  'unparseable',
  'unclassified-change',
] as const;

export type LooseningIndicator = (typeof LOOSENING_INDICATORS)[number];
export type AmbiguousIndicator = (typeof AMBIGUOUS_INDICATORS)[number];
export type IndicatorKind = LooseningIndicator | AmbiguousIndicator;

/** Which bucket an indicator falls in. Both hold the merge; only the wording differs. */
export type IndicatorClass = 'loosening' | 'ambiguous';

/** One recognised change, bound to the file and the place in it that produced it. */
export interface Indicator {
  kind: IndicatorKind;
  class: IndicatorClass;
  /** Repo-relative path of the workflow file. */
  file: string;
  /** Where in the document — e.g. `jobs.build.steps[install]`, `on.pull_request.branches`. */
  location: string;
  /** One human-readable sentence naming what changed. */
  detail: string;
}

export function looseningIndicator(
  kind: LooseningIndicator,
  file: string,
  location: string,
  detail: string,
): Indicator {
  return { kind, class: 'loosening', file, location, detail };
}

export function ambiguousIndicator(
  kind: AmbiguousIndicator,
  file: string,
  location: string,
  detail: string,
): Indicator {
  return { kind, class: 'ambiguous', file, location, detail };
}

/**
 * The verdict for a whole pull request.
 *
 * - `no-change` — the diff touches no CI workflow file. Nothing to report.
 * - `tightening` — every recognised change adds coverage or is maintenance.
 * - `loosening` — at least one loosening *or* ambiguous indicator fired, so the
 *   `CI approval needed` merge gate applies.
 */
export const CI_CHANGE_VERDICTS = ['no-change', 'tightening', 'loosening'] as const;

export type CiChangeVerdict = (typeof CI_CHANGE_VERDICTS)[number];
