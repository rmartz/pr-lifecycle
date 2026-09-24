import { describe, expect, it } from 'vitest';

import type { CheckOutcome, CheckResult } from '../src/ci.js';
import { checkRunOutcome, commitStatusOutcome, computeCiStatus } from '../src/ci.js';

function makeResult(name: string, outcome: CheckOutcome): CheckResult {
  return { name, outcome };
}

describe('checkRunOutcome', () => {
  it.each(['success', 'neutral', 'skipped'])('passes a completed %s run', (conclusion) => {
    expect(checkRunOutcome({ status: 'completed', conclusion, completedAt: 'x' })).toBe('passed');
  });

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'])(
    'fails a completed %s run',
    (conclusion) => {
      expect(checkRunOutcome({ status: 'completed', conclusion, completedAt: 'x' })).toBe('failed');
    },
  );

  it.each(['queued', 'in_progress', 'waiting', 'pending'])(
    'treats a %s run with no completion as running',
    (status) => {
      expect(checkRunOutcome({ status, conclusion: null, completedAt: null })).toBe('running');
    },
  );

  it('judges a status-stale run (in_progress but completed_at set) by its conclusion', () => {
    expect(
      checkRunOutcome({ status: 'in_progress', conclusion: 'failure', completedAt: 'x' }),
    ).toBe('failed');
  });

  it('never passes a stale (14-day) or unrecognized conclusion', () => {
    expect(checkRunOutcome({ status: 'completed', conclusion: 'stale', completedAt: 'x' })).toBe(
      'running',
    );
  });

  it('treats a completed run with no conclusion as running', () => {
    expect(checkRunOutcome({ status: 'completed', conclusion: null, completedAt: 'x' })).toBe(
      'running',
    );
  });
});

describe('commitStatusOutcome', () => {
  it.each([
    ['success', 'passed'],
    ['failure', 'failed'],
    ['error', 'failed'],
    ['pending', 'running'],
  ] as const)('maps %s to %s', (state, outcome) => {
    expect(commitStatusOutcome(state)).toBe(outcome);
  });
});

describe('computeCiStatus', () => {
  const REQUIRED = ['Build', 'Test'];

  it('is passing when every required check passed', () => {
    const results = [makeResult('Build', 'passed'), makeResult('Test', 'passed')];

    expect(computeCiStatus(results, REQUIRED)).toBe('passing');
  });

  it('is failing as soon as one required check fails, even with others running', () => {
    const results = [makeResult('Build', 'running'), makeResult('Test', 'failed')];

    expect(computeCiStatus(results, REQUIRED)).toBe('failing');
  });

  it('is pending while a required check is running', () => {
    const results = [makeResult('Build', 'passed'), makeResult('Test', 'running')];

    expect(computeCiStatus(results, REQUIRED)).toBe('pending');
  });

  it('is pending while a required check has not reported at all', () => {
    expect(computeCiStatus([makeResult('Build', 'passed')], REQUIRED)).toBe('pending');
  });

  it('ignores failures of checks that are not required', () => {
    const results = [
      makeResult('Build', 'passed'),
      makeResult('Test', 'passed'),
      makeResult('CodeQL', 'failed'),
    ];

    expect(computeCiStatus(results, REQUIRED)).toBe('passing');
  });

  it('is passing (gate inactive) when no checks are required', () => {
    expect(computeCiStatus([makeResult('Build', 'failed')], [])).toBe('passing');
  });

  it("ignores a hold check's pending, so a sign-off wait is not a running build", () => {
    const results = [makeResult('Build', 'passed'), makeResult('pr-policy', 'running')];

    expect(computeCiStatus(results, ['Build', 'pr-policy'])).toBe('passing');
  });

  it('ignores a hold check that has not reported yet', () => {
    expect(computeCiStatus([makeResult('Build', 'passed')], ['Build', 'pr-policy'])).toBe(
      'passing',
    );
  });

  it("counts a hold check's failure, since that is a fixable problem", () => {
    const results = [makeResult('Build', 'passed'), makeResult('pr-policy', 'failed')];

    expect(computeCiStatus(results, ['Build', 'pr-policy'])).toBe('failing');
  });

  it('never counts an ignored check, failing or pending', () => {
    const results = [makeResult('Build', 'passed'), makeResult('merge-safety', 'failed')];

    expect(computeCiStatus(results, ['Build', 'merge-safety'])).toBe('passing');
  });

  it('uses the policy lists instead of the defaults when given', () => {
    const results = [makeResult('merge-safety', 'failed'), makeResult('uat', 'running')];

    expect(
      computeCiStatus(results, ['merge-safety', 'uat'], {
        holdChecks: ['uat'],
        ignoredChecks: [],
      }),
    ).toBe('failing');
  });

  it('counts a check reported as both a check-run and a commit status once', () => {
    const results = [makeResult('Build', 'passed'), makeResult('Build', 'passed')];

    expect(computeCiStatus(results, ['Build'])).toBe('passing');
  });
});
