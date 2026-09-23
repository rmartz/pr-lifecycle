import { describe, expect, it } from 'vitest';

import { AUTO_MERGE_LABEL, planReconcile } from '../src/plan.js';
import { makeCopilotReview, makeFacts, makeReview, makeVerdictBody } from './fixtures.js';

const approvedReviews = [makeReview({ body: makeVerdictBody('approved') })];

describe('planReconcile labels', () => {
  it('adds review requested once Copilot has reviewed', () => {
    const plan = planReconcile(makeFacts({ reviews: [makeCopilotReview()] }), {});

    expect(plan.addLabels).toEqual(['review requested']);
  });

  it.each([
    ['approved', 'approved'],
    ['changes-requested', 'changes requested'],
    ['escalation-needed', 'escalation needed'],
  ] as const)('adds the label for a %s verdict', (outcome, label) => {
    const facts = makeFacts({ reviews: [makeReview({ body: makeVerdictBody(outcome) })] });

    expect(planReconcile(facts, {}).addLabels).toEqual([label]);
  });

  it('adds no lifecycle label while awaiting Copilot', () => {
    expect(planReconcile(makeFacts(), {}).addLabels).toEqual([]);
  });

  it('removes stale lifecycle labels', () => {
    const facts = makeFacts({ labels: ['review requested'], reviews: approvedReviews });

    expect(planReconcile(facts, {}).removeLabels).toEqual(['review requested']);
  });

  it('removes a hand-applied approved label with no verdict behind it', () => {
    const facts = makeFacts({ labels: ['approved'] });

    expect(planReconcile(facts, {}).removeLabels).toEqual(['approved']);
  });

  it('clears every lifecycle label from a draft', () => {
    const facts = makeFacts({ isDraft: true, labels: ['approved', 'changes requested'] });

    expect(planReconcile(facts, {}).removeLabels).toEqual(['approved', 'changes requested']);
  });

  it('never touches labels it does not own', () => {
    const facts = makeFacts({ labels: ['DevOps', 'ready for UAT', AUTO_MERGE_LABEL] });

    expect(planReconcile(facts, {}).removeLabels).toEqual([]);
  });

  it('plans nothing when labels already match', () => {
    const facts = makeFacts({ labels: ['approved', 'DevOps'], reviews: approvedReviews });
    const plan = planReconcile(facts, {});

    expect([plan.addLabels, plan.removeLabels]).toEqual([[], []]);
  });

  it('plans nothing for a closed PR, leaving its labels as the record', () => {
    const facts = makeFacts({ status: 'merged', labels: ['review requested'] });

    expect(planReconcile(facts, { armAutoMerge: true })).toEqual({
      state: 'closed',
      addLabels: [],
      removeLabels: [],
      autoMerge: 'none',
    });
  });
});

describe('planReconcile auto-merge', () => {
  it('never touches auto-merge when arming is off', () => {
    const facts = makeFacts({ autoMergeEnabled: true });

    expect(planReconcile(facts, {}).autoMerge).toBe('none');
  });

  it('arms an approved PR in arming mode', () => {
    const plan = planReconcile(makeFacts({ reviews: approvedReviews }), { armAutoMerge: true });

    expect(plan.autoMerge).toBe('arm');
  });

  it('adds the auto-merge label when arming', () => {
    const plan = planReconcile(makeFacts({ reviews: approvedReviews }), { armAutoMerge: true });

    expect(plan.addLabels).toEqual(['approved', AUTO_MERGE_LABEL]);
  });

  it('does not re-arm an already armed PR', () => {
    const facts = makeFacts({ autoMergeEnabled: true, reviews: approvedReviews });

    expect(planReconcile(facts, { armAutoMerge: true }).autoMerge).toBe('none');
  });

  it('disarms a PR that is no longer approved', () => {
    const facts = makeFacts({ autoMergeEnabled: true, labels: ['approved', AUTO_MERGE_LABEL] });

    expect(planReconcile(facts, { armAutoMerge: true }).autoMerge).toBe('disarm');
  });

  it('removes the auto-merge label when disarming', () => {
    const facts = makeFacts({ autoMergeEnabled: true, labels: ['approved', AUTO_MERGE_LABEL] });

    expect(planReconcile(facts, { armAutoMerge: true }).removeLabels).toEqual([
      'approved',
      AUTO_MERGE_LABEL,
    ]);
  });
});
