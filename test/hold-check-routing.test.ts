import { describe, expect, it } from 'vitest';

import { classifyBotPr } from '../src/bot-eligibility.js';
import type { CheckOutcome } from '../src/ci.js';
import { computeCiStatus } from '../src/ci.js';
import { computeState } from '../src/state.js';
import { makeFacts } from './fixtures.js';

// A major Dependabot bump whose only pr-policy finding is the undecided
// `breaking change` / `contained break` classification. These tests supply
// pr-policy's outcome rather than verify it: the contract is that pr-policy
// reports this as pending (rmartz/pr-policy#115), and pending must route to a
// review, not a fix (#149).
const MAJOR_BUMP_MESSAGE =
  'chore(deps): bump vercel from 64.5.0 to 65.2.0\n\nBumps vercel.\n\n---\nupdated-dependencies:\n- dependency-name: vercel\n  dependency-version: 65.2.0\n  dependency-type: direct:development\n  update-type: version-update:semver-major\n...\n\nSigned-off-by: dependabot[bot] <support@github.com>';

function stateWithPrPolicy(outcome: CheckOutcome): string {
  const eligibility = classifyBotPr({
    authorLogin: 'dependabot[bot]',
    headRef: 'dependabot/npm_and_yarn/vercel-65.2.0',
    isCrossRepository: false,
    commits: [{ authorLogin: 'dependabot[bot]', message: MAJOR_BUMP_MESSAGE }],
    changedFiles: undefined,
  });
  const ciStatus = computeCiStatus(
    [
      { name: 'Build', outcome: 'passed' },
      { name: 'pr-policy', outcome },
    ],
    ['Build', 'pr-policy'],
  );
  const facts = makeFacts({
    title: 'chore(deps): bump vercel from 64.5.0 to 65.2.0',
    botEligible: eligibility.eligible,
    ciStatus,
  });
  return computeState(facts, {});
}

describe('routing a major Dependabot bump on its pr-policy result', () => {
  it('requests review while pr-policy holds on the breaking-change classification', () => {
    expect(stateWithPrPolicy('running')).toBe('review-requested');
  });

  it('still routes to a fix when pr-policy fails', () => {
    expect(stateWithPrPolicy('failed')).toBe('ci-failing');
  });
});
