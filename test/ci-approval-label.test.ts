import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { FileChange, PullRequestFacts, UatSignOffFact } from '../src/facts.js';
import { planReconcile } from '../src/plan.js';
import { BASE_WORKFLOW, edited } from './ci-change/fixtures/workflow.js';
import { applyPlan, makeAuthor } from './fixtures.js';
import { makeUatFacts } from './uat-fixtures.js';

// `CI approval needed` (#118): present while the head needs the CI sign-off,
// removed when a push takes the need away, kept once a trusted person signed off.

const ON = { uat: 'on' } as const;
const NEEDED = 'CI approval needed';
const APPROVED = 'CI change approved';
const WORKFLOW = '.github/workflows/ci.yml';

const LOOSENING: FileChange = {
  path: WORKFLOW,
  baseText: BASE_WORKFLOW,
  headText: edited(
    '    runs-on: ubuntu-latest',
    '    runs-on: ubuntu-latest\n    continue-on-error: true',
  ),
};

function approval(overrides: Partial<UatSignOffFact> = {}): UatSignOffFact {
  return {
    label: APPROVED,
    actor: makeAuthor({ login: 'rmartz', permission: 'admin' }),
    appliedAt: '2026-10-19T11:00:00Z',
    ...overrides,
  };
}

/** A ci PR touching scripts: it needs the CI sign-off. */
function ciFacts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return makeUatFacts({
    title: 'ci: add a lint script',
    changedPaths: ['scripts/lint.sh'],
    ...overrides,
  });
}

/** A feat PR touching only source: it needs no CI sign-off. */
function featFacts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return makeUatFacts({ title: 'feat: a', changedPaths: ['src/a.ts'], ...overrides });
}

describe('CI approval needed', () => {
  it('is added to a PR that needs the CI sign-off', () => {
    expect(planReconcile(ciFacts(), ON).addLabels).toContain(NEEDED);
  });

  it('is added to a feat PR that bundles a loosening', () => {
    const facts = featFacts({ changedPaths: ['src/a.ts', WORKFLOW], workflowChanges: [LOOSENING] });

    expect(planReconcile(facts, ON).addLabels).toContain(NEEDED);
  });

  it('is removed when a push takes the need away', () => {
    expect(planReconcile(featFacts({ labels: [NEEDED] }), ON).removeLabels).toContain(NEEDED);
  });

  it('is kept after a push once a trusted person signed off', () => {
    const facts = featFacts({ labels: [NEEDED, APPROVED], uatSignOffs: [approval()] });

    expect(planReconcile(facts, ON).removeLabels).not.toContain(NEEDED);
  });

  it('is still removed when the approval came from a bot', () => {
    const actor = makeAuthor({ login: 'github-actions[bot]', type: 'Bot', permission: 'none' });
    const facts = featFacts({ labels: [NEEDED, APPROVED], uatSignOffs: [approval({ actor })] });

    expect(planReconcile(facts, ON).removeLabels).toContain(NEEDED);
  });

  it('is still removed when the approval came from a triage user', () => {
    const actor = makeAuthor({ login: 'helper', permission: 'triage' });
    const facts = featFacts({ labels: [NEEDED, APPROVED], uatSignOffs: [approval({ actor })] });

    expect(planReconcile(facts, ON).removeLabels).toContain(NEEDED);
  });

  it('is not added back by a signed-off PR that no longer needs it', () => {
    const facts = featFacts({ labels: [APPROVED], uatSignOffs: [approval()] });

    expect(planReconcile(facts, ON).addLabels).not.toContain(NEEDED);
  });

  it('never writes CI change approved, and never removes it', () => {
    const plan = planReconcile(ciFacts({ labels: [APPROVED], uatSignOffs: [approval()] }), ON);

    expect([plan.addLabels.includes(APPROVED), plan.removeLabels.includes(APPROVED)]).toEqual([
      false,
      false,
    ]);
  });

  it('is left alone without a UAT setting', () => {
    const plan = planReconcile(ciFacts({ labels: [NEEDED] }), {});

    expect([plan.addLabels, plan.removeLabels]).toEqual([['review requested'], []]);
  });

  it('converges: applying the plan and re-planning changes nothing', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(ciFacts(), featFacts()),
        fc.subarray([NEEDED, APPROVED, 'UAT pending']),
        fc.boolean(),
        (base, labels, trusted) => {
          const actor = trusted
            ? makeAuthor({ login: 'rmartz', permission: 'admin' })
            : makeAuthor({ login: 'bot', type: 'Bot', permission: 'none' });
          const facts = { ...base, labels, uatSignOffs: [approval({ actor })] };
          const again = planReconcile(applyPlan(facts, planReconcile(facts, ON)), ON);
          expect([again.addLabels, again.removeLabels]).toEqual([[], []]);
        },
      ),
    );
  });
});
