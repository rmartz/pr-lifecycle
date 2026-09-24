import { describe, expect, it } from 'vitest';

import type { PullRequestFacts, ReconcilePolicy } from '../src/facts.js';
import { planReconcile, UPDATE_REQUIRED_LABEL, withoutReleaseActions } from '../src/plan.js';
import { makeFacts } from './fixtures.js';

/** An eligible bot PR is approved with no review, which keeps these facts small. */
function flagged(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return makeFacts({ botEligible: true, labels: [UPDATE_REQUIRED_LABEL], ...overrides });
}

const AUTO_UPDATE: ReconcilePolicy = { autoUpdate: true };

describe('planReconcile update', () => {
  it('updates an approved PR flagged update required with update-branch', () => {
    expect(planReconcile(flagged(), AUTO_UPDATE).update).toBe('update-branch');
  });

  it('asks Dependabot to rebase its own PR instead', () => {
    const facts = flagged({ updater: 'dependabot' });

    expect(planReconcile(facts, AUTO_UPDATE).update).toBe('dependabot-rebase');
  });

  it('does not ask Dependabot again while a rebase is pending', () => {
    const facts = flagged({ updater: 'dependabot', rebasePending: true });

    expect(planReconcile(facts, AUTO_UPDATE).update).toBe('none');
  });

  it('does nothing when --auto-update is off', () => {
    expect(planReconcile(flagged(), { armAutoMerge: true }).update).toBe('none');
  });

  it('does nothing without the update required label', () => {
    expect(planReconcile(flagged({ labels: ['DevOps'] }), AUTO_UPDATE).update).toBe('none');
  });

  it('does nothing for a PR that is not approved', () => {
    const facts = flagged({ botEligible: false, ciStatus: 'pending' });

    expect(planReconcile(facts, AUTO_UPDATE).update).toBe('none');
  });

  it('does nothing for a PR with a merge conflict', () => {
    expect(planReconcile(flagged({ mergeable: false }), AUTO_UPDATE).update).toBe('none');
  });

  it('does nothing for a PR being merged in the same pass', () => {
    const facts = flagged({ immediatelyMergeable: true });
    const plan = planReconcile(facts, { ...AUTO_UPDATE, armAutoMerge: true });

    expect([plan.autoMerge, plan.update]).toEqual(['merge', 'none']);
  });

  it('updates alongside arming', () => {
    const plan = planReconcile(flagged(), { ...AUTO_UPDATE, armAutoMerge: true });

    expect([plan.autoMerge, plan.update]).toEqual(['arm', 'update-branch']);
  });

  it('never writes the update required label', () => {
    const plan = planReconcile(flagged(), AUTO_UPDATE);

    expect([...plan.addLabels, ...plan.removeLabels]).not.toContain(UPDATE_REQUIRED_LABEL);
  });
});

describe('withoutReleaseActions update', () => {
  it('drops the update', () => {
    expect(withoutReleaseActions(planReconcile(flagged(), AUTO_UPDATE)).update).toBe('none');
  });

  it('keeps the labels when only an update is dropped', () => {
    const plan = planReconcile(flagged(), AUTO_UPDATE);

    expect(withoutReleaseActions(plan).addLabels).toEqual(['approved']);
  });
});
