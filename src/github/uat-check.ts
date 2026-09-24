import type { UatGate } from '../uat.js';
import { UAT_CHECK_NAME } from '../uat.js';
import type { CheckRunData, CheckRunWrite } from './client.js';

/**
 * The `uat` check-run a gate result is posted as: `success` when it passes, else
 * `in_progress` (a hold, never a failure), with text saying why. See
 * docs/uat-gate.md §The check-run.
 */

const HOW_TO_PASS =
  'Apply `UAT passed` after testing, or `no UAT needed` to waive testing. ' +
  'Only someone with write access can pass the gate.';

function describeGate(gate: UatGate): { title: string; summary: string } {
  switch (gate.reason) {
    case 'verdict-exempt':
      return {
        title: 'UAT not required',
        summary: 'The latest review marked this change as not needing UAT.',
      };
    case 'bot-eligible':
      return {
        title: 'UAT not required',
        summary: 'This bot PR is approved without review, so no UAT is required.',
      };
    case 'override':
      return gate.override === 'no UAT needed'
        ? { title: 'UAT waived', summary: 'A maintainer waived UAT with `no UAT needed`.' }
        : { title: 'UAT passed', summary: 'A maintainer marked this PR `UAT passed`.' };
    case 'verdict-required':
      return {
        title: 'Waiting for UAT',
        summary: `The latest review says this change needs UAT. ${HOW_TO_PASS}`,
      };
    case 'verdict-unspecified':
      return {
        title: 'Waiting for UAT',
        summary: `The latest review didn't say whether UAT is needed, so it is required. ${HOW_TO_PASS}`,
      };
    case 'no-verdict':
      return {
        title: 'Waiting for review',
        summary: `No review has decided yet whether this change needs UAT, so it is required for now. ${HOW_TO_PASS}`,
      };
  }
}

export function uatCheckRun(gate: UatGate, headSha: string): CheckRunWrite {
  return {
    name: UAT_CHECK_NAME,
    headSha,
    status: gate.passes ? 'completed' : 'in_progress',
    conclusion: gate.passes ? 'success' : undefined,
    ...describeGate(gate),
  };
}

/**
 * Whether the head already shows this result: every `uat` run on it has the same
 * status, conclusion, and title. Any run that differs (including one another app
 * posted) means the result is written again, so the latest run is always ours.
 */
export function isUatCheckCurrent(existing: readonly CheckRunData[], run: CheckRunWrite): boolean {
  return (
    existing.length > 0 &&
    existing.every(
      (check) =>
        check.status === run.status &&
        check.conclusion === (run.conclusion ?? null) &&
        check.title === run.title,
    )
  );
}
