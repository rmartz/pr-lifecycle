import { describe, expect, it } from 'vitest';

import { AUTO_MERGE_LABEL, planReconcile } from '../src/plan.js';
import { computeState, ESCALATION_LABEL } from '../src/state.js';
import { makeFacts, makeReview, makeVerdictBody, OLD_SHA } from './fixtures.js';

const approvedReviews = [makeReview({ body: makeVerdictBody('approved') })];

describe('sticky escalation label: state', () => {
  it('escalates a PR carrying the label over a counting approval', () => {
    const facts = makeFacts({ labels: [ESCALATION_LABEL], reviews: approvedReviews });

    expect(computeState(facts, {})).toBe('escalation-needed');
  });

  it('escalates an eligible bot PR carrying the label', () => {
    const facts = makeFacts({ labels: [ESCALATION_LABEL], botEligible: true });

    expect(computeState(facts, {})).toBe('escalation-needed');
  });

  it('keeps the escalation after a push invalidates the escalating verdict', () => {
    const facts = makeFacts({
      labels: [ESCALATION_LABEL],
      reviews: [
        makeReview({ commitSha: OLD_SHA, body: makeVerdictBody('escalation-needed', OLD_SHA) }),
      ],
    });

    expect(computeState(facts, {})).toBe('escalation-needed');
  });

  it.each([
    ['a draft', { isDraft: true }],
    ['a conflicting', { mergeable: false }],
    ['a CI-failing', { ciStatus: 'failing' }],
    ['a CI-pending', { ciStatus: 'pending' }],
  ] as const)('escalates %s PR carrying the label', (_label, overrides) => {
    const facts = makeFacts({ labels: [ESCALATION_LABEL], ...overrides });

    expect(computeState(facts, {})).toBe('escalation-needed');
  });

  it('leaves a closed PR closed', () => {
    const facts = makeFacts({ status: 'closed', labels: [ESCALATION_LABEL] });

    expect(computeState(facts, {})).toBe('closed');
  });

  it('computes from verdicts again once the label is removed', () => {
    const facts = makeFacts({ labels: [], reviews: approvedReviews });

    expect(computeState(facts, {})).toBe('approved');
  });
});

describe('sticky escalation label: plan', () => {
  it('never removes a hand-applied escalation label', () => {
    const facts = makeFacts({ labels: [ESCALATION_LABEL, 'review requested'] });

    expect(planReconcile(facts, {}).removeLabels).toEqual(['review requested']);
  });

  it('removes approved from an escalated PR', () => {
    const facts = makeFacts({ labels: [ESCALATION_LABEL, 'approved'], reviews: approvedReviews });

    expect(planReconcile(facts, {}).removeLabels).toEqual(['approved']);
  });

  it('disarms an armed PR once it is escalated', () => {
    const facts = makeFacts({
      autoMergeEnabled: true,
      labels: [ESCALATION_LABEL, 'approved', AUTO_MERGE_LABEL],
      reviews: approvedReviews,
    });

    expect(planReconcile(facts, { armAutoMerge: true }).autoMerge).toBe('disarm');
  });

  it('never arms an escalated PR that is otherwise approved', () => {
    const facts = makeFacts({ labels: [ESCALATION_LABEL], reviews: approvedReviews });

    expect(planReconcile(facts, { armAutoMerge: true }).autoMerge).toBe('none');
  });
});
