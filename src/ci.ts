import { UAT_CHECK_NAME } from './uat.js';

/**
 * The CI gate: is the PR's required CI passing, failing, or still running?
 * Pure — the edge layer gathers the raw check results; this decides. See
 * docs/reconciler-design.md §CI gate.
 *
 * "CI" is the base branch's required checks, with two kinds of exception:
 * - **hold checks** (e.g. `pr-policy`) report *pending* while they wait on a human
 *   act, which is a hold, not a running build — so their pending is ignored, but
 *   their failure (a fixable problem) still counts;
 * - **ignored checks** (e.g. `merge-safety`, whose failures mean "update needed"
 *   or "base is red", handled by other states) never count at all.
 */

export const CI_STATUSES = ['failing', 'passing', 'pending'] as const;
export type CiStatus = (typeof CI_STATUSES)[number];

export const DEFAULT_HOLD_CHECKS: readonly string[] = ['pr-policy'];
export const DEFAULT_IGNORED_CHECKS: readonly string[] = ['merge-safety'];

/** One check result on a commit: a check-run, or a commit status. */
export interface CheckResult {
  name: string;
  /** Normalized outcome of this one result. */
  outcome: CheckOutcome;
}

export type CheckOutcome = 'failed' | 'passed' | 'running';

export interface CiCheckPolicy {
  holdChecks?: readonly string[];
  ignoredChecks?: readonly string[];
}

const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(['neutral', 'skipped', 'success']);
const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  'action_required',
  'cancelled',
  'failure',
  'startup_failure',
  'timed_out',
]);

/**
 * Normalize a check-run. A run whose status still reads in-progress but whose
 * `completed_at` is set has actually concluded (GitHub sometimes leaves the status
 * stale); it is judged by its conclusion. `stale` (incomplete for 14 days) and any
 * unrecognized conclusion count as still running — never as a pass.
 */
export function checkRunOutcome(run: {
  status: string;
  conclusion: string | null;
  completedAt: string | null;
}): CheckOutcome {
  const concluded = run.status === 'completed' || run.completedAt !== null;
  if (!concluded || run.conclusion === null) {
    return 'running';
  }
  if (PASSING_CONCLUSIONS.has(run.conclusion)) {
    return 'passed';
  }
  return FAILING_CONCLUSIONS.has(run.conclusion) ? 'failed' : 'running';
}

/** Normalize a commit status (`success` / `failure` / `error` / `pending`). */
export function commitStatusOutcome(state: string): CheckOutcome {
  if (state === 'success') {
    return 'passed';
  }
  return state === 'failure' || state === 'error' ? 'failed' : 'running';
}

/**
 * The gate verdict over the required checks. Any counted failure makes it
 * `failing` immediately, even with others still running; otherwise any counted
 * check still running, or not reported at all, makes it `pending`. With no
 * required checks configured, the gate is inactive (`passing`).
 */
export function computeCiStatus(
  results: readonly CheckResult[],
  requiredChecks: readonly string[],
  policy: CiCheckPolicy = {},
): CiStatus {
  // This package's own `uat` check is always a hold: it is pending while it waits
  // for a person, and counting that as running CI would keep a PR from ever
  // reaching review (the review decides whether UAT is needed at all).
  const holds = new Set([...(policy.holdChecks ?? DEFAULT_HOLD_CHECKS), UAT_CHECK_NAME]);
  const ignored = new Set(policy.ignoredChecks ?? DEFAULT_IGNORED_CHECKS);
  let pending = false;
  for (const name of new Set(requiredChecks)) {
    if (ignored.has(name)) {
      continue;
    }
    const outcomes = results.filter((result) => result.name === name).map((r) => r.outcome);
    if (outcomes.includes('failed')) {
      return 'failing';
    }
    const reported = outcomes.length > 0;
    const running = outcomes.includes('running');
    // A hold check's pending is a wait on a human, not a build still running.
    if (!holds.has(name) && (!reported || running)) {
      pending = true;
    }
  }
  return pending ? 'pending' : 'passing';
}
