import { describe, expect, it } from 'vitest';

import type { PullRequestFacts, ReconcilePolicy } from '../src/facts.js';
import { planReconcile } from '../src/plan.js';
import { classifySignOff } from '../src/sign-off.js';
import { classifyUat, uatLabelFor } from '../src/uat.js';
import { HEAD_SHA, makeAuthor, makeReview, OLD_SHA } from './fixtures.js';
import {
  BEFORE_HEAD,
  HEAD_ARRIVED,
  makeApproval,
  makeSignOff,
  makeUatFacts,
  withSignOffs,
} from './uat-fixtures.js';

const ON: ReconcilePolicy = { uat: 'on' };

function outcome(facts: PullRequestFacts, policy: ReconcilePolicy = ON) {
  return classifyUat(facts, policy, classifySignOff(facts, policy.uat ?? 'on'));
}

describe('classifyUat — rule 1: UAT off', () => {
  it('waives every PR', () => {
    expect(outcome(makeUatFacts(), { uat: 'off' })).toBe('off');
  });
});

describe('classifyUat — rule 2: can not be user-facing', () => {
  it.each(['docs: a', 'test: a', 'refactor: a'])('exempts the title %j', (title) => {
    expect(outcome(makeUatFacts({ title }))).toBe('exempt-title');
  });

  it('gives a ci PR touching source the CI sign-off instead of UAT', () => {
    expect(outcome(makeUatFacts({ title: 'ci: a' }))).toBe('ci');
  });

  it.each(['feat: a', 'fix: a', 'perf: a', 'revert: a', 'chore: a', 'chore no colon'])(
    'does not exempt the title %j',
    (title) => {
      expect(outcome(makeUatFacts({ title }))).toBe('pending');
    },
  );

  it('exempts a chore PR touching only lockfiles by its paths', () => {
    const facts = makeUatFacts({ title: 'chore(deps): bump a', changedPaths: ['pnpm-lock.yaml'] });

    expect(outcome(facts)).toBe('exempt-paths');
  });

  it('exempts a chore PR touching only CI scripts and tooling config by its paths', () => {
    const facts = makeUatFacts({
      title: 'chore: group storybook-ci bumps',
      changedPaths: ['.github/dependabot.yml', 'scripts/dependabot-audit.mjs', 'eslint.config.js'],
    });

    expect(outcome(facts)).toBe('exempt-paths');
  });

  it('does not exempt a chore PR touching source', () => {
    const facts = makeUatFacts({
      title: 'chore: tidy up',
      changedPaths: ['pnpm-lock.yaml', 'src/a.ts'],
    });

    expect(outcome(facts)).toBe('pending');
  });

  it('does not exempt a PR whose paths are unknown', () => {
    const facts: PullRequestFacts = makeUatFacts();
    delete facts.changedPaths;

    expect(outcome(facts)).toBe('pending');
  });

  it('exempts even an approved PR with a UAT passed on it', () => {
    const facts = withSignOffs(
      makeUatFacts({ title: 'docs: a', reviews: [makeApproval()] }),
      makeSignOff({ label: 'UAT passed' }),
    );

    expect(outcome(facts)).toBe('exempt-title');
  });
});

describe('classifyUat — rule 3: UAT passed', () => {
  it('keeps a current UAT passed on an approved PR', () => {
    const facts = withSignOffs(
      makeUatFacts({ reviews: [makeApproval()] }),
      makeSignOff({ label: 'UAT passed' }),
    );

    expect(outcome(facts)).toBe('passed');
  });

  it('keeps it on an eligible bot PR', () => {
    const facts = withSignOffs(
      makeUatFacts({ botEligible: true }),
      makeSignOff({ label: 'UAT passed' }),
    );

    expect(outcome(facts)).toBe('passed');
  });

  it('keeps it while CI fails on the approved head', () => {
    const facts = withSignOffs(
      makeUatFacts({ reviews: [makeApproval()], ciStatus: 'failing' }),
      makeSignOff({ label: 'UAT passed' }),
    );

    expect(outcome(facts)).toBe('passed');
  });

  it('does not count on an unapproved PR', () => {
    const facts = withSignOffs(makeUatFacts(), makeSignOff({ label: 'UAT passed' }));

    expect(outcome(facts)).toBe('pending');
  });

  it('does not count once the approval was dismissed', () => {
    const facts = withSignOffs(
      makeUatFacts({ reviews: [{ ...makeApproval(), state: 'DISMISSED' }] }),
      makeSignOff({ label: 'UAT passed' }),
    );

    expect(outcome(facts)).toBe('pending');
  });

  it('does not count once a changes-requested verdict supersedes the approval', () => {
    const changes = makeReview({
      id: 2,
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-10-19T12:00:00Z',
    });
    const facts = withSignOffs(
      makeUatFacts({ reviews: [makeApproval(), changes] }),
      makeSignOff({ label: 'UAT passed' }),
    );

    expect(outcome(facts)).toBe('pending');
  });

  it('does not count from an earlier head', () => {
    const facts = withSignOffs(
      makeUatFacts({ reviews: [makeApproval()] }),
      makeSignOff({ label: 'UAT passed', appliedAt: BEFORE_HEAD }),
    );

    expect(outcome(facts)).toBe('ready');
  });

  it('does not carry over a verified clean rebase', () => {
    const facts = withSignOffs(
      makeUatFacts({
        reviews: [makeApproval(OLD_SHA)],
        cleanRebaseSources: [OLD_SHA],
        commitArrivals: { [OLD_SHA]: '2026-10-19T08:00:00Z' },
        forcePushes: [{ headSha: HEAD_SHA, beforeSha: OLD_SHA, pushedAt: HEAD_ARRIVED }],
      }),
      makeSignOff({ label: 'UAT passed', appliedAt: BEFORE_HEAD }),
    );

    expect(outcome(facts)).toBe('ready');
  });

  it('does not count from a bot', () => {
    const actor = makeAuthor({ login: 'github-actions[bot]', type: 'Bot', permission: 'none' });
    const facts = withSignOffs(
      makeUatFacts({ reviews: [makeApproval()] }),
      makeSignOff({ label: 'UAT passed', actor }),
    );

    expect(outcome(facts)).toBe('ready');
  });
});

describe('classifyUat — rule 4: no UAT needed', () => {
  it('keeps a trusted waiver for the head', () => {
    expect(outcome(withSignOffs(makeUatFacts(), makeSignOff()))).toBe('waived');
  });

  it('prefers a current UAT passed over a waiver', () => {
    const facts = withSignOffs(
      makeUatFacts({ reviews: [makeApproval()] }),
      makeSignOff(),
      makeSignOff({ label: 'UAT passed' }),
    );

    expect(outcome(facts)).toBe('passed');
  });

  it('does not count a waiver applied by a bot', () => {
    const actor = makeAuthor({ login: 'github-actions[bot]', type: 'Bot', permission: 'none' });

    expect(outcome(withSignOffs(makeUatFacts(), makeSignOff({ actor })))).toBe('pending');
  });

  it('does not count a waiver applied by a triage user', () => {
    const actor = makeAuthor({ login: 'helper', permission: 'triage' });

    expect(outcome(withSignOffs(makeUatFacts(), makeSignOff({ actor })))).toBe('pending');
  });

  it('does not count a waiver from outside the trusted authors', () => {
    const facts = withSignOffs(makeUatFacts(), makeSignOff());

    expect(outcome(facts, { uat: 'on', trustedAuthors: ['someone-else'] })).toBe('pending');
  });

  it('does not count a waiver label with no application on record', () => {
    const facts = { ...makeUatFacts(), labels: ['no UAT needed'] };

    expect(outcome(facts)).toBe('pending');
  });

  it('does not count a waiver application whose label was since removed', () => {
    const facts = { ...makeUatFacts(), uatSignOffs: [makeSignOff()] };

    expect(outcome(facts)).toBe('pending');
  });

  it('does not count a waiver from an earlier head after a push', () => {
    const facts = withSignOffs(makeUatFacts(), makeSignOff({ appliedAt: BEFORE_HEAD }));

    expect(outcome(facts)).toBe('pending');
  });

  it('keeps a waiver across a verified clean rebase', () => {
    const facts = withSignOffs(
      makeUatFacts({
        cleanRebaseSources: [OLD_SHA],
        commitArrivals: { [OLD_SHA]: '2026-10-19T08:00:00Z' },
        forcePushes: [{ headSha: HEAD_SHA, beforeSha: OLD_SHA, pushedAt: HEAD_ARRIVED }],
      }),
      makeSignOff({ appliedAt: BEFORE_HEAD }),
    );

    expect(outcome(facts)).toBe('waived');
  });

  it('keeps a waiver across a verified clean base merge', () => {
    const facts = withSignOffs(
      makeUatFacts({
        cleanAncestors: [OLD_SHA],
        commitArrivals: { [HEAD_SHA]: HEAD_ARRIVED, [OLD_SHA]: '2026-10-19T08:00:00Z' },
      }),
      makeSignOff({ appliedAt: BEFORE_HEAD }),
    );

    expect(outcome(facts)).toBe('waived');
  });

  it('drops a waiver once the title changes', () => {
    const facts = withSignOffs(
      makeUatFacts({ titleChanges: ['2026-10-19T12:00:00Z'] }),
      makeSignOff(),
    );

    expect(outcome(facts)).toBe('pending');
  });
});

describe('classifyUat — rules 5 and 6', () => {
  it('is ready once the PR is approved', () => {
    expect(outcome(makeUatFacts({ reviews: [makeApproval()] }))).toBe('ready');
  });

  it('is ready for an eligible bot PR', () => {
    expect(outcome(makeUatFacts({ botEligible: true }))).toBe('ready');
  });

  it('is pending otherwise', () => {
    expect(outcome(makeUatFacts())).toBe('pending');
  });
});

describe('uatLabelFor', () => {
  it.each([
    ['off', 'no UAT needed'],
    ['exempt-title', 'no UAT needed'],
    ['exempt-paths', 'no UAT needed'],
    ['ci', 'no UAT needed'],
    ['waived', 'no UAT needed'],
    ['passed', 'UAT passed'],
    ['ready', 'UAT ready'],
    ['pending', 'UAT pending'],
  ] as const)('labels %s as %j', (uat, label) => {
    expect(uatLabelFor(uat)).toBe(label);
  });
});

describe('planReconcile — UAT labels', () => {
  it('neither reads nor writes UAT labels without a UAT setting', () => {
    const plan = planReconcile({ ...makeUatFacts(), labels: ['UAT ready'] }, {});

    expect([plan.uat, plan.addLabels, plan.removeLabels]).toEqual([
      undefined,
      ['review requested'],
      [],
    ]);
  });

  it('adds UAT pending to a new feature PR', () => {
    expect(planReconcile(makeUatFacts(), ON).addLabels).toEqual([
      'review requested',
      'UAT pending',
    ]);
  });

  it('replaces a stale waiver with UAT pending after a push', () => {
    const facts = withSignOffs(
      makeUatFacts({ labels: ['review requested'] }),
      makeSignOff({ appliedAt: BEFORE_HEAD }),
    );
    const plan = planReconcile(facts, ON);

    expect([plan.addLabels, plan.removeLabels]).toEqual([['UAT pending'], ['no UAT needed']]);
  });

  it('replaces a stale UAT passed with UAT ready', () => {
    const facts = withSignOffs(
      makeUatFacts({ labels: ['approved'], reviews: [makeApproval()] }),
      makeSignOff({ label: 'UAT passed', appliedAt: BEFORE_HEAD }),
    );
    const plan = planReconcile(facts, ON);

    expect([plan.addLabels, plan.removeLabels]).toEqual([['UAT ready'], ['UAT passed']]);
  });

  it('keeps a current UAT passed and removes the other UAT labels', () => {
    const facts = withSignOffs(
      makeUatFacts({ labels: ['approved', 'UAT ready', 'UAT pending'], reviews: [makeApproval()] }),
      makeSignOff({ label: 'UAT passed' }),
    );
    const plan = planReconcile(facts, ON);

    expect([plan.addLabels, plan.removeLabels]).toEqual([[], ['UAT pending', 'UAT ready']]);
  });

  it('never touches a UAT label on a closed PR', () => {
    const plan = planReconcile(makeUatFacts({ status: 'merged', labels: ['UAT pending'] }), ON);

    expect([plan.uat, plan.addLabels, plan.removeLabels]).toEqual([undefined, [], []]);
  });

  it('labels a draft PR too', () => {
    expect(planReconcile(makeUatFacts({ isDraft: true }), ON).addLabels).toEqual(['UAT pending']);
  });
});
