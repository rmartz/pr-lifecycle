import { describe, expect, it } from 'vitest';

import { AUTO_MERGE_LABEL, planReconcile } from '../src/plan.js';
import { computeState, ESCALATION_LABEL } from '../src/state.js';
import { makeFacts, makeReview, makeVerdictBody, OLD_SHA } from './fixtures.js';

// A `blocked` /review verdict means the change is ready but waits on another PR
// or issue; the coordinator re-reviews it when that closes. It is a hold, never
// an escalation (#81).

const blockedReview = makeReview({ id: 5, body: makeVerdictBody('blocked') });
const ARMING = { armAutoMerge: true };

describe('blocked verdict: state', () => {
  it('holds a PR whose latest verdict is blocked', () => {
    const facts = makeFacts({ reviews: [blockedReview] });

    expect(computeState(facts, {})).toBe('blocked');
  });

  it('outranks an earlier approval', () => {
    const approval = makeReview({
      id: 2,
      submittedAt: '2026-09-23T09:00:00Z',
      body: makeVerdictBody('approved'),
    });
    const facts = makeFacts({ reviews: [approval, blockedReview] });

    expect(computeState(facts, {})).toBe('blocked');
  });

  it('is replaced by a later verdict', () => {
    const approval = makeReview({
      id: 9,
      submittedAt: '2026-09-23T16:00:00Z',
      body: makeVerdictBody('approved'),
    });
    const facts = makeFacts({ reviews: [blockedReview, approval] });

    expect(computeState(facts, {})).toBe('approved');
  });

  it('stops counting once a push moves the head', () => {
    const stale = makeReview({ commitSha: OLD_SHA, body: makeVerdictBody('blocked', OLD_SHA) });
    const facts = makeFacts({ reviews: [stale] });

    expect(computeState(facts, {})).toBe('review-requested');
  });

  it('holds an eligible bot PR', () => {
    const facts = makeFacts({ reviews: [blockedReview], botEligible: true });

    expect(computeState(facts, {})).toBe('blocked');
  });
});

describe('blocked verdict: plan', () => {
  it('labels the PR blocked, never escalation needed', () => {
    const plan = planReconcile(makeFacts({ reviews: [blockedReview] }), {});

    expect([plan.addLabels, plan.addLabels.includes(ESCALATION_LABEL)]).toEqual([
      ['blocked'],
      false,
    ]);
  });

  it('disarms an armed PR', () => {
    const facts = makeFacts({
      reviews: [blockedReview],
      labels: ['approved', AUTO_MERGE_LABEL],
      autoMergeEnabled: true,
    });

    const plan = planReconcile(facts, ARMING);

    expect([plan.autoMerge, plan.removeLabels]).toEqual(['disarm', ['approved', AUTO_MERGE_LABEL]]);
  });

  it('removes the blocked label once a later verdict replaces it', () => {
    const approval = makeReview({
      id: 9,
      submittedAt: '2026-09-23T16:00:00Z',
      body: makeVerdictBody('approved'),
    });
    const facts = makeFacts({ reviews: [blockedReview, approval], labels: ['blocked'] });

    const plan = planReconcile(facts, {});

    expect([plan.addLabels, plan.removeLabels]).toEqual([['approved'], ['blocked']]);
  });
});
