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
  mergeable: fc.constantFrom(true, true, false, undefined),
  ciStatus: fc.constantFrom('passing', 'passing', 'pending', 'failing'),
  baseCiFailing: fc.boolean(),
  cleanAncestors: fc.constantFrom([], [], [OLD_SHA]),
  reviews: reviewsArb(),
});

/**
 * Open, ready, non-bot PRs: the facts where one extra review *can* change the
 * state, so the inertness properties below exercise the trust and head-binding
 * rules instead of short-circuiting on closed/draft/bot-eligible.
 */
const openFactsArb: fc.Arbitrary<PullRequestFacts> = factsArb.map((facts) => ({
  ...facts,
  status: 'open',
  isDraft: false,
  title: 'feat: thing',
  botEligible: false,
  // No carry-over: the inertness properties are about commits whose verdicts
  // must not count.
  cleanAncestors: [],
}));

/** Security properties get more runs than the default 100. */
const SECURITY_RUNS = { numRuns: 1000 };

const policyArb: fc.Arbitrary<ReconcilePolicy> = fc.record(
  {
    trustedAuthors: fc.subarray(['maintainer', 'RMARTZ']),
    armAutoMerge: fc.boolean(),
    skipCopilotReview: fc.boolean(),
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
      fc.property(
        openFactsArb,
        policyArb,
        reviewsArb(untrustedAuthorArb),
        (facts, policy, extra) => {
          const polluted = { ...facts, reviews: [...facts.reviews, ...withIdOffset(extra)] };

          expect(computeState(polluted, policy)).toBe(computeState(facts, policy));
        },
      ),
      SECURITY_RUNS,
    );
  });

  it('ignores reviews of older commits from anyone', () => {
    fc.assert(
      fc.property(
        openFactsArb,
        policyArb,
        reviewsArb(authorArb, fc.constant(OLD_SHA)),
        (facts, policy, extra) => {
          const polluted = { ...facts, reviews: [...facts.reviews, ...withIdOffset(extra)] };

          expect(computeState(polluted, policy)).toBe(computeState(facts, policy));
        },
      ),
      SECURITY_RUNS,
    );
  });

  it('ignores dismissed and pending reviews, even from trusted authors', () => {
    const trustedAuthor = fc.record({
      login: fc.constantFrom('maintainer', 'rmartz'),
      type: fc.constant('User' as const),
      permission: fc.constantFrom('admin', 'maintain', 'write'),
    });
    const revoked = reviewArb(trustedAuthor, fc.constant(HEAD_SHA)).map((review) => ({
      ...review,
      state: review.id % 2 === 0 ? ('DISMISSED' as const) : ('PENDING' as const),
    }));
    fc.assert(
      fc.property(
        openFactsArb,
        policyArb,
        fc.uniqueArray(revoked, { selector: (review) => review.id, maxLength: 8 }),
        (facts, policy, extra) => {
          const polluted = { ...facts, reviews: [...facts.reviews, ...withIdOffset(extra)] };

          expect(computeState(polluted, policy)).toBe(computeState(facts, policy));
        },
      ),
      SECURITY_RUNS,
    );
  });

  // Carry-over grants nothing new: a verdict on a verified clean ancestor counts
  // exactly as if the same reviewer had posted it on the head.
  it('treats a carried-over verdict exactly like one on the head', () => {
    const onAncestor = reviewArb(authorArb, fc.constant(OLD_SHA));
    fc.assert(
      fc.property(
        openFactsArb,
        policyArb,
        fc.uniqueArray(onAncestor, { selector: (review) => review.id, maxLength: 6 }),
        (facts, policy, reviews) => {
          // Compare like with like: each review's marker (when present) names the
          // commit the review is bound to, on both sides. A review whose marker
          // contradicts its binding is rejected by design on either side.
          const carried = {
            ...facts,
            cleanAncestors: [OLD_SHA],
            reviews: reviews.map((review) => ({
              ...review,
              body: review.body.replaceAll(HEAD_SHA, OLD_SHA),
            })),
          };
          const onHead = {
            ...facts,
            reviews: reviews.map((review) => ({
              ...review,
              commitSha: HEAD_SHA,
              body: review.body.replaceAll(OLD_SHA, HEAD_SHA),
            })),
          };

          expect(computeState(carried, policy)).toBe(computeState(onHead, policy));
        },
      ),
      SECURITY_RUNS,
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

  // The CI-gate safety rule: an armed PR that isn't approved — e.g. an unreviewed
  // push onto an approved PR while CI runs — must never stay armed, or GitHub
  // would merge unreviewed code as soon as CI passed.
  it('always disarms an armed open PR that is not approved', () => {
    fc.assert(
      fc.property(openFactsArb, policyArb, (facts, policy) => {
        const armed = { ...facts, autoMergeEnabled: true };
        const plan = planReconcile(armed, { ...policy, armAutoMerge: true });

        expect(plan.state === 'approved' || plan.autoMerge === 'disarm').toBe(true);
      }),
      SECURITY_RUNS,
    );
  });
});
