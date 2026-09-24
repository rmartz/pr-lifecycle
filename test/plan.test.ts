import { describe, expect, it } from 'vitest';

import { AUTO_MERGE_LABEL, planReconcile, withoutReleaseActions } from '../src/plan.js';
import { makeCopilotReview, makeFacts, makeReview, makeVerdictBody, OLD_SHA } from './fixtures.js';

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
      update: 'none',
    });
  });
});

describe('planReconcile merge conflict', () => {
  const approvedConflict = makeFacts({
    mergeable: false,
    labels: ['approved', AUTO_MERGE_LABEL],
    autoMergeEnabled: true,
    reviews: approvedReviews,
  });

  it('replaces approved with fix required', () => {
    const plan = planReconcile(approvedConflict, { armAutoMerge: true });

    expect([plan.addLabels, plan.removeLabels]).toEqual([
      ['fix required'],
      ['approved', AUTO_MERGE_LABEL],
    ]);
  });

  it('disarms auto-merge', () => {
    expect(planReconcile(approvedConflict, { armAutoMerge: true }).autoMerge).toBe('disarm');
  });

  it('removes a stale fix required once the conflict is resolved', () => {
    const facts = makeFacts({ labels: ['fix required'], reviews: [makeCopilotReview()] });

    expect(planReconcile(facts, {}).removeLabels).toEqual(['fix required']);
  });
});

describe('planReconcile CI gate', () => {
  it('labels failing CI fix required + ci failing', () => {
    expect(planReconcile(makeFacts({ ciStatus: 'failing' }), {}).addLabels).toEqual([
      'fix required',
      'ci failing',
    ]);
  });

  it('drops the approval and disarms when CI fails on an approved PR', () => {
    const facts = makeFacts({
      ciStatus: 'failing',
      labels: ['approved', AUTO_MERGE_LABEL],
      autoMergeEnabled: true,
      reviews: approvedReviews,
    });

    const plan = planReconcile(facts, { armAutoMerge: true });

    expect([plan.removeLabels, plan.autoMerge]).toEqual([['approved', AUTO_MERGE_LABEL], 'disarm']);
  });

  it('removes ci failing (but keeps fix required) when CI passes but a conflict remains', () => {
    const facts = makeFacts({ mergeable: false, labels: ['fix required', 'ci failing'] });

    expect(planReconcile(facts, {}).removeLabels).toEqual(['ci failing']);
  });

  it('shows no lifecycle label while the base is red', () => {
    const facts = makeFacts({
      ciStatus: 'failing',
      baseCiFailing: true,
      labels: ['review requested'],
    });

    const plan = planReconcile(facts, {});

    expect([plan.addLabels, plan.removeLabels]).toEqual([[], ['review requested']]);
  });

  it('disarms an unreviewed push onto an armed approved PR while CI runs', () => {
    const facts = makeFacts({
      ciStatus: 'pending',
      autoMergeEnabled: true,
      labels: ['approved', AUTO_MERGE_LABEL],
      reviews: [makeReview({ commitSha: OLD_SHA, body: makeVerdictBody('approved', OLD_SHA) })],
    });

    expect(planReconcile(facts, { armAutoMerge: true }).autoMerge).toBe('disarm');
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

describe('planReconcile merge or arm', () => {
  const approved = { reviews: [makeCopilotReview(), ...approvedReviews] };

  it('merges an approved PR that is immediately mergeable', () => {
    const plan = planReconcile(makeFacts({ ...approved, immediatelyMergeable: true }), {
      armAutoMerge: true,
    });

    expect(plan.autoMerge).toBe('merge');
  });

  it('does not add the auto-merge label for a direct merge', () => {
    const plan = planReconcile(makeFacts({ ...approved, immediatelyMergeable: true }), {
      armAutoMerge: true,
    });

    expect(plan.addLabels).toEqual(['approved']);
  });

  it('never merges when arming is off', () => {
    const plan = planReconcile(makeFacts({ ...approved, immediatelyMergeable: true }), {});

    expect(plan.autoMerge).toBe('none');
  });

  it('leaves an already armed, mergeable PR to GitHub', () => {
    const facts = makeFacts({
      ...approved,
      immediatelyMergeable: true,
      autoMergeEnabled: true,
      labels: ['approved', AUTO_MERGE_LABEL],
    });

    expect(planReconcile(facts, { armAutoMerge: true }).autoMerge).toBe('none');
  });

  it('never merges an immediately mergeable PR that is not approved', () => {
    const facts = makeFacts({ reviews: [makeCopilotReview()], immediatelyMergeable: true });

    expect(planReconcile(facts, { armAutoMerge: true }).autoMerge).toBe('none');
  });
});

describe('withoutReleaseActions', () => {
  const approved = { reviews: [makeCopilotReview(), ...approvedReviews] };

  it('turns an arm into nothing and drops the auto-merge label', () => {
    const plan = withoutReleaseActions(planReconcile(makeFacts(approved), { armAutoMerge: true }));

    expect([plan.autoMerge, plan.addLabels]).toEqual(['none', ['approved']]);
  });

  it('turns a merge into nothing', () => {
    const facts = makeFacts({ ...approved, immediatelyMergeable: true });

    expect(withoutReleaseActions(planReconcile(facts, { armAutoMerge: true })).autoMerge).toBe('none');
  });

  it('keeps a disarm', () => {
    const facts = makeFacts({ autoMergeEnabled: true, labels: [AUTO_MERGE_LABEL] });
    const plan = planReconcile(facts, { armAutoMerge: true });

    expect(withoutReleaseActions(plan)).toEqual(plan);
  });
});
