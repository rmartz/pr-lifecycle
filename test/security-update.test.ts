import { describe, expect, it } from 'vitest';

import type { BotPrFacts } from '../src/bot-eligibility.js';
import { DEPENDABOT_LOGIN, isDependabotSecurityUpdate } from '../src/bot-eligibility.js';
import { isSecurityUpdateCommit } from '../src/dependabot-versions.js';
import type { PullRequestFacts } from '../src/facts.js';
import { planReconcile, SECURITY_UPDATE_LABEL } from '../src/plan.js';
import { makeFacts } from './fixtures.js';

// A security update's metadata leaves `update-type` out; a version update's
// carries it on every entry. See docs/bot-eligibility.md §Security updates.

function makeEntry(name: string, updateType?: string): string {
  const typeLine = updateType === undefined ? '' : `\n  update-type: ${updateType}`;
  return `- dependency-name: ${name}\n  dependency-version: 2.0.1\n  dependency-type: direct:production${typeLine}`;
}

function makeMessage(...entries: string[]): string {
  return `chore(deps): bump things\n\n---\nupdated-dependencies:\n${entries.join('\n')}\n...\n`;
}

const SECURITY_MESSAGE = makeMessage(makeEntry('next'));
const VERSION_MESSAGE = makeMessage(makeEntry('next', 'version-update:semver-patch'));

function makeSecurityPr(overrides: Partial<BotPrFacts> = {}): BotPrFacts {
  return {
    authorLogin: DEPENDABOT_LOGIN,
    headRef: 'dependabot/npm_and_yarn/next-2.0.1',
    isCrossRepository: false,
    commits: [{ authorLogin: DEPENDABOT_LOGIN, message: SECURITY_MESSAGE }],
    changedFiles: undefined,
    ...overrides,
  };
}

describe('isSecurityUpdateCommit', () => {
  it('flags an entry without an update type', () => {
    expect(isSecurityUpdateCommit(SECURITY_MESSAGE)).toBe(true);
  });

  it('does not flag a version update', () => {
    expect(isSecurityUpdateCommit(VERSION_MESSAGE)).toBe(false);
  });

  it('flags a group with one entry missing its update type', () => {
    const message = makeMessage(
      makeEntry('react', 'version-update:semver-minor'),
      makeEntry('next'),
    );

    expect(isSecurityUpdateCommit(message)).toBe(true);
  });

  it('does not flag a commit without a metadata block', () => {
    expect(isSecurityUpdateCommit('chore(deps): bump next from 2.0.0 to 2.0.1')).toBe(false);
  });

  it('does not flag an empty metadata block', () => {
    expect(isSecurityUpdateCommit(makeMessage())).toBe(false);
  });
});

describe('isDependabotSecurityUpdate', () => {
  it('flags a same-repo Dependabot security update', () => {
    expect(isDependabotSecurityUpdate(makeSecurityPr())).toBe(true);
  });

  it('does not flag a Dependabot version update', () => {
    const commits = [{ authorLogin: DEPENDABOT_LOGIN, message: VERSION_MESSAGE }];

    expect(isDependabotSecurityUpdate(makeSecurityPr({ commits }))).toBe(false);
  });

  // Anyone can write Dependabot-shaped metadata into their own commit message.
  it('does not flag a PR Dependabot did not open', () => {
    expect(isDependabotSecurityUpdate(makeSecurityPr({ authorLogin: 'drive-by' }))).toBe(false);
  });

  it('does not flag a fork PR', () => {
    expect(isDependabotSecurityUpdate(makeSecurityPr({ isCrossRepository: true }))).toBe(false);
  });

  it('ignores security metadata in a commit someone else pushed', () => {
    const commits = [
      { authorLogin: DEPENDABOT_LOGIN, message: VERSION_MESSAGE },
      { authorLogin: 'maintainer', message: SECURITY_MESSAGE },
    ];

    expect(isDependabotSecurityUpdate(makeSecurityPr({ commits }))).toBe(false);
  });

  // A fix pushed on top doesn't change what Dependabot opened the PR for.
  it('still flags a security update once someone else has pushed to it', () => {
    const commits = [
      { authorLogin: DEPENDABOT_LOGIN, message: SECURITY_MESSAGE },
      { authorLogin: 'maintainer', message: 'fix: adapt to next 2' },
    ];

    expect(isDependabotSecurityUpdate(makeSecurityPr({ commits }))).toBe(true);
  });
});

/** A Dependabot PR still waiting on CI, so no lifecycle label is in play. */
function dependabot(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return makeFacts({ updater: 'dependabot', ciStatus: 'pending', ...overrides });
}

describe('planReconcile security update label', () => {
  it('adds the label to a Dependabot security update', () => {
    const plan = planReconcile(dependabot({ securityUpdate: true }), {});

    expect(plan.addLabels).toEqual([SECURITY_UPDATE_LABEL]);
  });

  it('keeps the label on a Dependabot security update that has it', () => {
    const facts = dependabot({ securityUpdate: true, labels: [SECURITY_UPDATE_LABEL] });
    const plan = planReconcile(facts, {});

    expect([...plan.addLabels, ...plan.removeLabels]).toEqual([]);
  });

  it('removes the label from a Dependabot version update', () => {
    const facts = dependabot({ securityUpdate: false, labels: [SECURITY_UPDATE_LABEL] });

    expect(planReconcile(facts, {}).removeLabels).toEqual([SECURITY_UPDATE_LABEL]);
  });

  it('never adds the label to a PR Dependabot does not own', () => {
    const facts = dependabot({ updater: 'github', securityUpdate: true });

    expect(planReconcile(facts, {}).addLabels).not.toContain(SECURITY_UPDATE_LABEL);
  });

  // Elsewhere the label is a person's to set, so the reconciler leaves it alone.
  it("leaves a person's label on a PR Dependabot does not own", () => {
    const facts = dependabot({ updater: 'github', labels: [SECURITY_UPDATE_LABEL] });

    expect(planReconcile(facts, {}).removeLabels).not.toContain(SECURITY_UPDATE_LABEL);
  });

  it('shows the label alongside the lifecycle state label', () => {
    const facts = dependabot({ ciStatus: 'passing', botEligible: true, securityUpdate: true });

    expect(planReconcile(facts, {}).addLabels.sort()).toEqual(
      ['approved', SECURITY_UPDATE_LABEL].sort(),
    );
  });
});
