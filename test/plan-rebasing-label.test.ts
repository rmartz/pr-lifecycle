import { describe, expect, it } from 'vitest';

import type { PullRequestFacts } from '../src/facts.js';
import { DEPENDABOT_REBASING_LABEL, planReconcile } from '../src/plan.js';
import { makeFacts } from './fixtures.js';

/** A Dependabot PR still waiting on CI, so no lifecycle label is in play. */
function dependabot(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return makeFacts({ updater: 'dependabot', ciStatus: 'pending', ...overrides });
}

describe('planReconcile dependabot rebasing label', () => {
  it('adds the label while Dependabot is rebasing', () => {
    const plan = planReconcile(dependabot({ dependabotRebasing: true }), {});

    expect(plan.addLabels).toEqual([DEPENDABOT_REBASING_LABEL]);
  });

  it('removes the label once Dependabot has finished', () => {
    const facts = dependabot({ labels: [DEPENDABOT_REBASING_LABEL] });

    expect(planReconcile(facts, {}).removeLabels).toEqual([DEPENDABOT_REBASING_LABEL]);
  });

  it('keeps the label while the rebase is still running', () => {
    const facts = dependabot({ dependabotRebasing: true, labels: [DEPENDABOT_REBASING_LABEL] });
    const plan = planReconcile(facts, {});

    expect([...plan.addLabels, ...plan.removeLabels]).toEqual([]);
  });

  // A request we posted is not a rebase in progress: Dependabot may reply with an
  // error instead, and a label raised on the request would then never clear.
  it('does not add the label for a pending rebase request alone', () => {
    const plan = planReconcile(dependabot({ rebasePending: true }), {});

    expect(plan.addLabels).not.toContain(DEPENDABOT_REBASING_LABEL);
  });

  it('never adds the label to a PR Dependabot does not own', () => {
    const facts = dependabot({ updater: 'github', dependabotRebasing: true });

    expect(planReconcile(facts, {}).addLabels).not.toContain(DEPENDABOT_REBASING_LABEL);
  });

  it('shows the label alongside the lifecycle state label', () => {
    const facts = dependabot({ ciStatus: 'passing', botEligible: true, dependabotRebasing: true });

    expect(planReconcile(facts, {}).addLabels.sort()).toEqual(
      ['approved', DEPENDABOT_REBASING_LABEL].sort(),
    );
  });
});
