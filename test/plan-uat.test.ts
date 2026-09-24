import { describe, expect, it } from 'vitest';

import { computeCiStatus } from '../src/ci.js';
import { AUTO_MERGE_LABEL, planReconcile } from '../src/plan.js';
import { UAT_CHECK_NAME } from '../src/uat.js';
import { makeAuthor, makeFacts, makeReview, makeVerdictBody } from './fixtures.js';

// How the UAT gate shapes the plan: arming waits for it, and CI never waits on it.

const ARM_WITH_GATE = { armAutoMerge: true, uatGate: true };

function approvedWithUat(uat: string) {
  return [makeReview({ body: makeVerdictBody('approved', undefined, { uat }) })];
}

describe('planReconcile — UAT gate', () => {
  it('computes no gate when --uat-gate is off', () => {
    const facts = makeFacts({ reviews: approvedWithUat('required') });

    expect(planReconcile(facts, { armAutoMerge: true }).uatGate).toBeUndefined();
  });

  it('computes no gate for a closed PR', () => {
    const facts = makeFacts({ status: 'merged', reviews: approvedWithUat('required') });

    expect(planReconcile(facts, ARM_WITH_GATE).uatGate).toBeUndefined();
  });

  it('computes the gate for an open PR in any state', () => {
    expect(planReconcile(makeFacts({ isDraft: true }), ARM_WITH_GATE).uatGate?.reason).toBe(
      'no-verdict',
    );
  });

  it('keeps an approved PR waiting on UAT approved but unarmed', () => {
    const plan = planReconcile(makeFacts({ reviews: approvedWithUat('required') }), ARM_WITH_GATE);

    expect([plan.state, plan.autoMerge, plan.addLabels]).toEqual([
      'approved',
      'none',
      ['approved'],
    ]);
  });

  it('arms an approved PR once UAT passes', () => {
    const facts = makeFacts({
      reviews: approvedWithUat('required'),
      uatOverrides: [{ label: 'UAT passed', appliedBy: makeAuthor() }],
    });

    expect(planReconcile(facts, ARM_WITH_GATE).autoMerge).toBe('arm');
  });

  it('arms an approved, UAT-exempt PR', () => {
    const plan = planReconcile(makeFacts({ reviews: approvedWithUat('exempt') }), ARM_WITH_GATE);

    expect([plan.autoMerge, plan.addLabels]).toEqual(['arm', ['approved', AUTO_MERGE_LABEL]]);
  });

  it('never merges directly while UAT holds, even if GitHub would merge now', () => {
    const facts = makeFacts({ immediatelyMergeable: true, reviews: approvedWithUat('required') });

    expect(planReconcile(facts, ARM_WITH_GATE).autoMerge).toBe('none');
  });

  it('disarms an armed PR when a new verdict requires UAT', () => {
    const facts = makeFacts({
      autoMergeEnabled: true,
      labels: ['approved', AUTO_MERGE_LABEL],
      reviews: approvedWithUat('required'),
    });
    const plan = planReconcile(facts, ARM_WITH_GATE);

    expect([plan.autoMerge, plan.removeLabels]).toEqual(['disarm', [AUTO_MERGE_LABEL]]);
  });

  it('arms without a gate when --uat-gate is off, whatever the verdict says', () => {
    const facts = makeFacts({ reviews: approvedWithUat('required') });

    expect(planReconcile(facts, { armAutoMerge: true }).autoMerge).toBe('arm');
  });
});

describe('computeCiStatus — the uat check', () => {
  it('treats a pending uat check as a hold, not running CI', () => {
    const results = [
      { name: 'Build', outcome: 'passed' as const },
      { name: UAT_CHECK_NAME, outcome: 'running' as const },
    ];

    expect(computeCiStatus(results, ['Build', UAT_CHECK_NAME])).toBe('passing');
  });

  it('keeps uat a hold when --hold-checks replaces the default list', () => {
    const results = [{ name: UAT_CHECK_NAME, outcome: 'running' as const }];

    expect(computeCiStatus(results, [UAT_CHECK_NAME], { holdChecks: [] })).toBe('passing');
  });

  it('does not wait for a uat check that has not been posted yet', () => {
    expect(computeCiStatus([], [UAT_CHECK_NAME])).toBe('passing');
  });
});
