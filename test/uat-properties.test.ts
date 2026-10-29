import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PullRequestFacts, ReconcilePolicy, UatSignOffFact } from '../src/facts.js';
import { REPO_PERMISSIONS, UAT_SETTINGS, UAT_SIGN_OFF_LABELS } from '../src/facts.js';
import { planReconcile } from '../src/plan.js';
import { UAT_LABELS } from '../src/uat.js';
import type { UatOutcome } from '../src/uat.js';
import { applyPlan, HEAD_SHA, OLD_SHA } from './fixtures.js';
import { makeUatFacts, makeUatReview } from './uat-fixtures.js';

// Property-based guarantees of the UAT labels (docs/uat.md §Guaranteed properties).

const TIMES = [
  '2026-10-19T08:00:00Z',
  '2026-10-19T09:00:00Z',
  '2026-10-19T10:00:00Z',
  '2026-10-19T11:00:00Z',
] as const;
const timeArb = fc.constantFrom(...TIMES);

const signOffArb: fc.Arbitrary<UatSignOffFact> = fc.record({
  label: fc.constantFrom(...UAT_SIGN_OFF_LABELS),
  actor: fc.record({
    login: fc.constantFrom('rmartz', 'helper', 'github-actions[bot]'),
    type: fc.constantFrom('Bot', 'User'),
    permission: fc.constantFrom(...REPO_PERMISSIONS),
  }),
  appliedAt: timeArb,
});

const factsArb: fc.Arbitrary<PullRequestFacts> = fc
  .record({
    title: fc.constantFrom('feat: a', 'fix: a', 'docs: a', 'chore: a', 'build: a', 'oops'),
    labels: fc.subarray([...UAT_LABELS, 'approved', 'DevOps']),
    changedPaths: fc.constantFrom(['src/a.ts'], ['pnpm-lock.yaml'], ['README.md', 'src/a.ts']),
    approved: fc.boolean(),
    botEligible: fc.boolean(),
    ciStatus: fc.constantFrom('passing', 'pending', 'failing'),
    signOffs: fc.uniqueArray(signOffArb, { selector: (signOff) => signOff.label, maxLength: 2 }),
    headArrived: fc.option(timeArb, { nil: undefined }),
    forcePushes: fc.array(
      fc.record({
        headSha: fc.constantFrom(HEAD_SHA, OLD_SHA, undefined),
        beforeSha: fc.constantFrom(HEAD_SHA, OLD_SHA, undefined),
        pushedAt: timeArb,
      }),
      { maxLength: 2 },
    ),
    cleanRebaseSources: fc.constantFrom([], [OLD_SHA]),
    uat: fc.constantFrom(undefined, 'not-needed', 'required', 'unchanged'),
    passedHistory: fc.array(signOffArb, { maxLength: 2 }),
  })
  .map((drawn) =>
    makeUatFacts({
      title: drawn.title,
      labels: drawn.labels,
      changedPaths: drawn.changedPaths,
      botEligible: drawn.botEligible,
      ciStatus: drawn.ciStatus,
      reviews:
        drawn.approved || drawn.uat !== undefined
          ? [
              makeUatReview(drawn.uat ?? 'required', {
                code: drawn.approved ? 'approved' : 'changes-requested',
                since: OLD_SHA,
                review: { submittedAt: TIMES[2] },
              }),
            ]
          : [],
      uatPassedHistory: drawn.passedHistory.map((signOff) => ({
        ...signOff,
        label: 'UAT passed' as const,
      })),
      uatSignOffs: drawn.signOffs,
      commitArrivals: {
        ...(drawn.headArrived === undefined ? {} : { [HEAD_SHA]: drawn.headArrived }),
        [OLD_SHA]: TIMES[0],
      },
      forcePushes: drawn.forcePushes,
      cleanRebaseSources: drawn.cleanRebaseSources,
    }),
  );

const policyArb: fc.Arbitrary<ReconcilePolicy> = fc.record({
  uat: fc.constantFrom(...UAT_SETTINGS),
});

/** Outcomes whose label this package decides, not a person's sign-off. */
const SELF_DECIDED: ReadonlySet<UatOutcome> = new Set([
  'off',
  'ci',
  'exempt-auto-approved',
  'passed-attested',
  'waived-by-review',
]);

function uatLabelsOf(facts: PullRequestFacts): string[] {
  return facts.labels.filter((name) => UAT_LABELS.some((label) => label === name));
}

describe('UAT label properties', () => {
  it('leaves exactly one UAT label on an open PR', () => {
    fc.assert(
      fc.property(factsArb, policyArb, (facts, policy) => {
        const after = applyPlan(facts, planReconcile(facts, policy));
        expect(uatLabelsOf(after)).toHaveLength(1);
      }),
    );
  });

  it('is idempotent: re-planning after applying a plan changes nothing', () => {
    fc.assert(
      fc.property(factsArb, policyArb, (facts, policy) => {
        const after = applyPlan(facts, planReconcile(facts, policy));
        const again = planReconcile(after, policy);
        expect([again.addLabels, again.removeLabels]).toEqual([[], []]);
      }),
    );
  });

  it('is order-independent: permuting the sign-offs, pushes, and pass history changes nothing', () => {
    fc.assert(
      fc.property(factsArb, policyArb, fc.boolean(), (facts, policy, reverse) => {
        const permuted: PullRequestFacts = {
          ...facts,
          uatSignOffs: reverse ? facts.uatSignOffs?.toReversed() : facts.uatSignOffs,
          forcePushes: facts.forcePushes.toReversed(),
          uatPassedHistory: facts.uatPassedHistory?.toReversed(),
        } as PullRequestFacts;
        expect(planReconcile(permuted, policy)).toEqual(planReconcile(facts, policy));
      }),
    );
  });

  it('never keeps a sign-off label from an untrusted actor', () => {
    fc.assert(
      fc.property(factsArb, (facts) => {
        const untrusted = (facts.uatSignOffs ?? []).filter(
          (signOff) =>
            signOff.actor.type !== 'User' ||
            !['admin', 'maintain', 'write'].includes(signOff.actor.permission),
        );
        const plan = planReconcile(facts, { uat: 'on' });
        for (const signOff of untrusted) {
          const kept =
            facts.labels.includes(signOff.label) && !plan.removeLabels.includes(signOff.label);
          // A label this package decides itself is the one exception.
          if (kept && (plan.uat === undefined || !SELF_DECIDED.has(plan.uat))) {
            expect.fail(`kept ${signOff.label} from ${signOff.actor.login}`);
          }
        }
      }),
    );
  });
});
