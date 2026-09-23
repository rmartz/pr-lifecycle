import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PullRequestFacts, ReconcilePolicy, ReviewAuthor, ReviewFact } from '../src/facts.js';
import { REPO_PERMISSIONS, REVIEW_STATES } from '../src/facts.js';
import { AUTO_MERGE_LABEL, LIFECYCLE_LABELS, planReconcile } from '../src/plan.js';
import { COPILOT_REVIEWER_LOGIN, computeState } from '../src/state.js';
import { applyPlan, HEAD_SHA, makeVerdictBody, OLD_SHA } from './fixtures.js';

// Property-based guarantees from docs/reconciler-design.md §Guaranteed properties.

const OWNED_LABELS = new Set<string>([...LIFECYCLE_LABELS, AUTO_MERGE_LABEL]);
const LOGINS = ['maintainer', 'rmartz', 'drive-by', COPILOT_REVIEWER_LOGIN] as const;

const shaArb = fc.constantFrom(HEAD_SHA, OLD_SHA);

const bodyArb = fc.oneof(
  fc.constant(''),
  fc.constant('LGTM'),
  fc
    .tuple(
      fc.constantFrom('approved', 'changes-requested', 'escalation-needed', 'skipped'),
      fc.option(shaArb, { nil: undefined }),
    )
    .map(([outcome, head]) => makeVerdictBody(outcome, head)),
);

const authorArb: fc.Arbitrary<ReviewAuthor> = fc.record({
  login: fc.constantFrom(...LOGINS),
  type: fc.constantFrom('Bot', 'User'),
  permission: fc.constantFrom(...REPO_PERMISSIONS),
});

function reviewArb(author: fc.Arbitrary<ReviewAuthor>, commitSha = shaArb) {
  return fc.record({
    id: fc.nat({ max: 10_000 }),
    author,
    commitSha,
    state: fc.constantFrom(...REVIEW_STATES),
    body: bodyArb,
    submittedAt: fc.constantFrom(
      '2026-09-23T12:00:00Z',
      '2026-09-23T12:00:00Z',
      '2026-09-23T13:00:00Z',
      '2026-09-24T09:30:00Z',
    ),
  });
}

/** Unique review ids, as GitHub guarantees — ties then break deterministically. */
function reviewsArb(author = authorArb, commitSha = shaArb) {
  return fc.uniqueArray(reviewArb(author, commitSha), {
    selector: (review) => review.id,
    maxLength: 8,
  });
}

const factsArb: fc.Arbitrary<PullRequestFacts> = fc.record({
  status: fc.constantFrom('open', 'open', 'open', 'closed', 'merged'),
  isDraft: fc.boolean(),
  title: fc.constantFrom('feat: thing', '[WIP] feat: thing'),
  headSha: fc.constant(HEAD_SHA),
  labels: fc.subarray([...OWNED_LABELS, 'DevOps', 'ready for UAT']),
  autoMergeEnabled: fc.boolean(),
  botEligible: fc.boolean(),
  reviews: reviewsArb(),
});

const policyArb: fc.Arbitrary<ReconcilePolicy> = fc.record(
  {
    trustedAuthors: fc.subarray(['maintainer', 'RMARTZ']),
    armAutoMerge: fc.boolean(),
  },
  { requiredKeys: [] },
);

/** Authors that can never cast a counting verdict (and are not Copilot). */
const untrustedAuthorArb: fc.Arbitrary<ReviewAuthor> = fc.oneof(
  fc.record({
    login: fc.constantFrom('maintainer', 'drive-by'),
    type: fc.constant('User' as const),
    permission: fc.constantFrom('none', 'read', 'triage'),
  }),
  fc.record({
    login: fc.constantFrom('github-actions[bot]', 'dependabot[bot]'),
    type: fc.constant('Bot' as const),
    permission: fc.constantFrom(...REPO_PERMISSIONS),
  }),
);

/** Offset appended reviews' ids so they never collide with the originals. */
function withIdOffset(reviews: readonly ReviewFact[]): ReviewFact[] {
  return reviews.map((review) => ({ ...review, id: review.id + 100_000 }));
}

describe('reconciler properties', () => {
  it('is idempotent: re-planning after applying a plan changes nothing', () => {
    fc.assert(
      fc.property(factsArb, policyArb, (facts, policy) => {
        const replanned = planReconcile(applyPlan(facts, planReconcile(facts, policy)), policy);

        expect(replanned).toMatchObject({ addLabels: [], removeLabels: [], autoMerge: 'none' });
      }),
    );
  });

  it('is order-independent: permuting reviews never changes the plan', () => {
    fc.assert(
      fc.property(factsArb, policyArb, fc.nat(), (facts, policy, seed) => {
        const shuffled = [...facts.reviews].sort(
          (a, b) => ((a.id * 7919 + seed) % 104_729) - ((b.id * 7919 + seed) % 104_729),
        );

        expect(planReconcile({ ...facts, reviews: shuffled }, policy)).toEqual(
          planReconcile(facts, policy),
        );
      }),
    );
  });

  it('ignores untrusted reviews, including forged approval markers', () => {
    fc.assert(
      fc.property(factsArb, policyArb, reviewsArb(untrustedAuthorArb), (facts, policy, extra) => {
        const polluted = { ...facts, reviews: [...facts.reviews, ...withIdOffset(extra)] };

        expect(computeState(polluted, policy)).toBe(computeState(facts, policy));
      }),
    );
  });

  it('ignores reviews of older commits from anyone', () => {
    fc.assert(
      fc.property(
        factsArb,
        policyArb,
        reviewsArb(authorArb, fc.constant(OLD_SHA)),
        (facts, policy, extra) => {
          const polluted = { ...facts, reviews: [...facts.reviews, ...withIdOffset(extra)] };

          expect(computeState(polluted, policy)).toBe(computeState(facts, policy));
        },
      ),
    );
  });

  it('only ever writes labels it owns', () => {
    fc.assert(
      fc.property(factsArb, policyArb, (facts, policy) => {
        const plan = planReconcile(facts, policy);

        expect([...plan.addLabels, ...plan.removeLabels].every((l) => OWNED_LABELS.has(l))).toBe(
          true,
        );
      }),
    );
  });

  it('never arms auto-merge unless the PR is approved', () => {
    fc.assert(
      fc.property(factsArb, policyArb, (facts, policy) => {
        const plan = planReconcile(facts, policy);

        expect(plan.autoMerge !== 'arm' || plan.state === 'approved').toBe(true);
      }),
    );
  });
});
