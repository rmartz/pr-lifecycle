import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PullRequestFacts, UatSignOffFact } from '../src/facts.js';
import { planReconcile } from '../src/plan.js';
import { UAT_LABELS } from '../src/uat.js';
import { applyPlan, makeAuthor, makeReview, makeVerdictBody } from './fixtures.js';
import { makeUatFacts } from './uat-fixtures.js';

// The invariant (docs/uat.md §Always exactly one): whatever the facts and the
// repo's UAT setting, every reconcile leaves an open PR with exactly one of the
// four UAT labels, `no UAT needed` included when UAT is off, for auditing.

const PATHS = {
  source: ['src/a.ts'],
  trivial: ['README.md', 'pnpm-lock.yaml'],
  tooling: ['scripts/lint.sh'],
  workflow: ['.github/workflows/ci.yml'],
  unknown: undefined,
} as const;

const signOffArb: fc.Arbitrary<UatSignOffFact> = fc.record({
  label: fc.constantFrom('no UAT needed', 'UAT passed', 'CI change approved'),
  actor: fc.constantFrom(
    makeAuthor({ login: 'rmartz', permission: 'admin' }),
    makeAuthor({ login: 'helper', permission: 'triage' }),
    makeAuthor({ login: 'github-actions[bot]', type: 'Bot', permission: 'none' }),
  ),
  appliedAt: fc.constantFrom('2026-10-19T09:00:00Z', '2026-10-19T11:00:00Z'),
});

const factsArb: fc.Arbitrary<PullRequestFacts> = fc
  .record({
    title: fc.constantFrom(
      'feat: a',
      'fix: a',
      'docs: a',
      'chore: a',
      'ci: a',
      '[WIP] feat: a',
      'oops',
    ),
    paths: fc.constantFrom(...(Object.keys(PATHS) as (keyof typeof PATHS)[])),
    isDraft: fc.boolean(),
    botEligible: fc.boolean(),
    dependabot: fc.boolean(),
    approved: fc.boolean(),
    mergeable: fc.constantFrom(true, false, undefined),
    ciStatus: fc.constantFrom('passing', 'pending', 'failing'),
    labels: fc.subarray([...UAT_LABELS, 'escalation needed', 'CI approval needed', 'approved']),
    signOffs: fc.uniqueArray(signOffArb, { selector: (signOff) => signOff.label, maxLength: 3 }),
  })
  .map((drawn) => {
    const facts = makeUatFacts({
      title: drawn.title,
      isDraft: drawn.isDraft,
      botEligible: drawn.botEligible,
      updater: drawn.dependabot ? 'dependabot' : 'github',
      mergeable: drawn.mergeable,
      ciStatus: drawn.ciStatus,
      // GitHub's labels are a set.
      labels: [...new Set([...drawn.labels, ...drawn.signOffs.map((signOff) => signOff.label)])],
      uatSignOffs: drawn.signOffs,
      reviews: drawn.approved ? [makeReview({ body: makeVerdictBody('approved') })] : [],
    });
    const paths = PATHS[drawn.paths];
    if (paths === undefined) {
      delete facts.changedPaths;
    } else {
      facts.changedPaths = [...paths];
    }
    return facts;
  });

function uatLabelsOf(labels: readonly string[]): string[] {
  return labels.filter((name) => UAT_LABELS.some((label) => label === name));
}

describe('every reconcile leaves exactly one UAT label', () => {
  it.each(['on', 'off'] as const)('holds on every open PR with UAT %s', (uat) => {
    fc.assert(
      fc.property(factsArb, (facts) => {
        const after = applyPlan(facts, planReconcile(facts, { uat }));
        expect(uatLabelsOf(after.labels)).toHaveLength(1);
      }),
      { numRuns: 500 },
    );
  });

  it('records no UAT needed on every PR when UAT is off, for auditing', () => {
    fc.assert(
      fc.property(factsArb, (facts) => {
        const after = applyPlan(facts, planReconcile(facts, { uat: 'off' }));
        expect(uatLabelsOf(after.labels)).toEqual(['no UAT needed']);
      }),
      { numRuns: 300 },
    );
  });

  it('leaves the labels of a closed PR as its record', () => {
    fc.assert(
      fc.property(factsArb, fc.constantFrom('closed', 'merged'), (facts, status) => {
        const plan = planReconcile({ ...facts, status }, { uat: 'on' });
        expect([plan.addLabels, plan.removeLabels]).toEqual([[], []]);
      }),
    );
  });
});
