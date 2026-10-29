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

describe('classifyUat — rule 2: a CI change', () => {
  it('gives a ci PR touching source the CI sign-off instead of UAT', () => {
    expect(outcome(makeUatFacts({ title: 'ci: a' }))).toBe('ci');
  });

  it('treats a PR touching only workflows as a CI change, whatever its title', () => {
    const facts = makeUatFacts({
      title: 'chore(deps): bump an action',
      changedPaths: ['.github/workflows/ci.yml'],
      workflowChanges: [
        { path: '.github/workflows/ci.yml', baseText: 'on: push\n', headText: 'on: push\n' },
      ],
    });

    expect(outcome(facts)).toBe('ci');
  });
});

describe('classifyUat — no title or path exemption', () => {
  it.each(['docs: a', 'test: a', 'refactor: a', 'chore: a', 'feat: a', 'chore no colon'])(
    'holds the title %j for a decision',
    (title) => {
      expect(outcome(makeUatFacts({ title }))).toBe('pending');
    },
  );

  it('holds a docs-only PR for a decision', () => {
    const facts = makeUatFacts({ title: 'docs: explain', changedPaths: ['README.md'] });

    expect(outcome(facts)).toBe('pending');
  });

  it('asks for UAT on an approved docs-only PR with no UAT decision', () => {
    const facts = makeUatFacts({
      title: 'docs: explain',
      changedPaths: ['README.md'],
      reviews: [makeApproval()],
    });

    expect(outcome(facts)).toBe('ready');
  });

  it('holds a lockfile-only chore PR for a decision', () => {
    const facts = makeUatFacts({ title: 'chore(deps): bump a', changedPaths: ['pnpm-lock.yaml'] });

    expect(outcome(facts)).toBe('pending');
  });

  it('holds a PR whose paths are unknown', () => {
    const facts: PullRequestFacts = makeUatFacts();
    delete facts.changedPaths;

    expect(outcome(facts)).toBe('pending');
  });
});

describe('classifyUat — rule 3: approved through bot eligibility', () => {
  it('exempts an eligible bot PR with no verdict', () => {
    expect(outcome(makeUatFacts({ botEligible: true }))).toBe('exempt-auto-approved');
  });

  it('does not exempt an eligible bot PR once a person requests changes', () => {
    const changes = makeReview({ state: 'CHANGES_REQUESTED', submittedAt: '2026-10-19T10:30:00Z' });

    expect(outcome(makeUatFacts({ botEligible: true, reviews: [changes] }))).toBe('pending');
  });

  it('decides an eligible bot PR with a verdict by the other rules', () => {
    expect(outcome(makeUatFacts({ botEligible: true, reviews: [makeApproval()] }))).toBe('ready');
  });
});

describe('classifyUat — rule 4: UAT passed', () => {
  it('keeps a current UAT passed on an approved PR', () => {
    const facts = withSignOffs(
      makeUatFacts({ reviews: [makeApproval()] }),
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

  it('carries over a verified clean rebase', () => {
    const facts = withSignOffs(
      makeUatFacts({
        reviews: [makeApproval(OLD_SHA)],
        cleanRebaseSources: [OLD_SHA],
        commitArrivals: { [OLD_SHA]: '2026-10-19T08:00:00Z' },
        forcePushes: [{ headSha: HEAD_SHA, beforeSha: OLD_SHA, pushedAt: HEAD_ARRIVED }],
      }),
      makeSignOff({ label: 'UAT passed', appliedAt: BEFORE_HEAD }),
    );

    expect(outcome(facts)).toBe('passed');
  });

  it('carries over a verified clean base merge', () => {
    const facts = withSignOffs(
      makeUatFacts({
        reviews: [makeApproval(OLD_SHA)],
        cleanAncestors: [OLD_SHA],
        commitArrivals: { [HEAD_SHA]: HEAD_ARRIVED, [OLD_SHA]: '2026-10-19T08:00:00Z' },
      }),
      makeSignOff({ label: 'UAT passed', appliedAt: BEFORE_HEAD }),
    );

    expect(outcome(facts)).toBe('passed');
  });

  it('does not carry over a hand-resolved merge', () => {
    const facts = withSignOffs(
      makeUatFacts({
        reviews: [makeApproval()],
        commitArrivals: { [HEAD_SHA]: HEAD_ARRIVED, [OLD_SHA]: '2026-10-19T08:00:00Z' },
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

describe('classifyUat — rule 6: a person waives UAT', () => {
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
});

describe('classifyUat — rules 8 and 9', () => {
  it('is ready once the PR is approved', () => {
    expect(outcome(makeUatFacts({ reviews: [makeApproval()] }))).toBe('ready');
  });

  it('is ready on a native approval with no marker', () => {
    const approval = makeReview({ state: 'APPROVED', submittedAt: '2026-10-19T10:30:00Z' });

    expect(outcome(makeUatFacts({ reviews: [approval] }))).toBe('ready');
  });

  it('is pending otherwise', () => {
    expect(outcome(makeUatFacts())).toBe('pending');
  });
});

describe('uatLabelFor', () => {
  it.each([
    ['off', 'no UAT needed'],
    ['ci', 'no UAT needed'],
    ['exempt-auto-approved', 'no UAT needed'],
    ['passed', 'UAT passed'],
    ['passed-attested', 'UAT passed'],
    ['waived', 'no UAT needed'],
    ['waived-by-review', 'no UAT needed'],
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
