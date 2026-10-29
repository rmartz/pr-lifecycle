import { describe, expect, it } from 'vitest';

import type { PullRequestFacts, ReconcilePolicy } from '../src/facts.js';
import { classifySignOff } from '../src/sign-off.js';
import { classifyUat } from '../src/uat.js';
import { HEAD_SHA, makeAuthor, makeReview, OLD_SHA } from './fixtures.js';
import {
  BEFORE_HEAD,
  HEAD_ARRIVED,
  makeSignOff,
  makeUatFacts,
  makeUatReview,
  withSignOffs,
} from './uat-fixtures.js';

/** The rules the review agent's UAT decision drives (docs/uat.md rules 5 and 7). */

const ON: ReconcilePolicy = { uat: 'on' };
const OLD_ARRIVED = '2026-10-19T08:00:00Z';
const OTHER_SHA = 'd'.repeat(40);
const UNTRUSTED = makeAuthor({ login: 'drive-by', permission: 'read' });

function outcome(facts: PullRequestFacts, policy: ReconcilePolicy = ON) {
  return classifyUat(facts, policy, classifySignOff(facts, policy.uat ?? 'on'));
}

describe('classifyUat — rule 7: the review waives UAT', () => {
  it('waives on a counting not-needed', () => {
    expect(outcome(makeUatFacts({ reviews: [makeUatReview('not-needed')] }))).toBe(
      'waived-by-review',
    );
  });

  it('waives without an approval', () => {
    const review = makeUatReview('not-needed', { code: 'changes-requested' });

    expect(outcome(makeUatFacts({ reviews: [review] }))).toBe('waived-by-review');
  });

  it('does not count a not-needed from an untrusted author', () => {
    const review = makeUatReview('not-needed', { review: { author: UNTRUSTED } });

    expect(outcome(makeUatFacts({ reviews: [review] }))).toBe('pending');
  });

  it('does not count a not-needed on a stale head', () => {
    const review = makeUatReview('not-needed', { prHead: OLD_SHA });

    expect(outcome(makeUatFacts({ reviews: [review] }))).toBe('pending');
  });

  it('carries a not-needed over a verified clean base merge', () => {
    const review = makeUatReview('not-needed', { prHead: OLD_SHA });

    expect(outcome(makeUatFacts({ reviews: [review], cleanAncestors: [OLD_SHA] }))).toBe(
      'waived-by-review',
    );
  });

  it('carries a not-needed over a verified clean rebase', () => {
    // GitHub moved the review onto the rebased head; its marker names the source.
    const review = makeUatReview('not-needed', {
      prHead: OLD_SHA,
      review: { commitSha: HEAD_SHA, submittedAt: BEFORE_HEAD },
    });
    const facts = makeUatFacts({
      reviews: [review],
      cleanRebaseSources: [OLD_SHA],
      forcePushes: [{ headSha: HEAD_SHA, beforeSha: OLD_SHA, pushedAt: HEAD_ARRIVED }],
    });

    expect(outcome(facts)).toBe('waived-by-review');
  });

  it('keeps an earlier not-needed when a later review leaves uat out', () => {
    const later = makeReview({
      id: 2,
      state: 'APPROVED',
      submittedAt: '2026-10-19T11:00:00Z',
    });

    expect(outcome(makeUatFacts({ reviews: [makeUatReview('not-needed'), later] }))).toBe(
      'waived-by-review',
    );
  });

  it('withdraws a not-needed on a later required', () => {
    const later = makeUatReview('required', {
      review: { id: 2, submittedAt: '2026-10-19T11:00:00Z' },
    });

    expect(outcome(makeUatFacts({ reviews: [makeUatReview('not-needed'), later] }))).toBe('ready');
  });

  it('is revoked when its review is dismissed', () => {
    const review = makeUatReview('not-needed', { review: { state: 'DISMISSED' } });

    expect(outcome(makeUatFacts({ reviews: [review] }))).toBe('pending');
  });

  it('holds on required', () => {
    expect(outcome(makeUatFacts({ reviews: [makeUatReview('required')] }))).toBe('ready');
  });
});

describe('classifyUat — a person outranks the review agent', () => {
  it("keeps a person's waiver over an agent required", () => {
    const facts = withSignOffs(
      makeUatFacts({ reviews: [makeUatReview('required')] }),
      makeSignOff(),
    );

    expect(outcome(facts)).toBe('waived');
  });

  it("keeps a person's UAT passed over an agent required", () => {
    const facts = withSignOffs(
      makeUatFacts({ reviews: [makeUatReview('required')] }),
      makeSignOff({ label: 'UAT passed' }),
    );

    expect(outcome(facts)).toBe('passed');
  });

  it("keeps a person's UAT passed over an agent not-needed", () => {
    const facts = withSignOffs(
      makeUatFacts({ reviews: [makeUatReview('not-needed')] }),
      makeSignOff({ label: 'UAT passed' }),
    );

    expect(outcome(facts)).toBe('passed');
  });

  it('does not take a bot-applied waiver for a person', () => {
    const bot = makeAuthor({ login: 'github-actions[bot]', type: 'Bot', permission: 'none' });
    const facts = withSignOffs(
      makeUatFacts({ reviews: [makeUatReview('required')] }),
      makeSignOff({ actor: bot }),
    );

    expect(outcome(facts)).toBe('ready');
  });
});

/**
 * A PR that passed UAT on OLD_SHA, then had a conflict resolved by hand: the
 * head is a new commit carry-over didn't verify, so the label was removed as
 * stale, and the review attests the pass still holds.
 */
function makeAttested(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return makeUatFacts({
    reviews: [makeUatReview('unchanged', { since: OLD_SHA })],
    commitArrivals: { [HEAD_SHA]: HEAD_ARRIVED, [OLD_SHA]: OLD_ARRIVED },
    uatPassedHistory: [makeSignOff({ label: 'UAT passed', appliedAt: BEFORE_HEAD })],
    ...overrides,
  });
}

describe('classifyUat — rule 5: the review attests an earlier pass', () => {
  it('keeps a pass the review attests', () => {
    expect(outcome(makeAttested())).toBe('passed-attested');
  });

  it('does not count without an approval on the head', () => {
    const review = makeUatReview('unchanged', { since: OLD_SHA, code: 'changes-requested' });

    expect(outcome(makeAttested({ reviews: [review] }))).toBe('pending');
  });

  it('does not count with no UAT passed on record', () => {
    const facts = makeAttested();
    delete facts.uatPassedHistory;

    expect(outcome(facts)).toBe('ready');
  });

  it('does not count a UAT passed applied before uat_since arrived', () => {
    const history = [makeSignOff({ label: 'UAT passed', appliedAt: '2026-10-19T07:00:00Z' })];

    expect(outcome(makeAttested({ uatPassedHistory: history }))).toBe('ready');
  });

  it('does not count a UAT passed applied after a later commit arrived', () => {
    const arrivals = {
      [HEAD_SHA]: HEAD_ARRIVED,
      [OLD_SHA]: OLD_ARRIVED,
      [OTHER_SHA]: '2026-10-19T08:30:00Z',
    };

    expect(outcome(makeAttested({ commitArrivals: arrivals }))).toBe('ready');
  });

  it('does not count a UAT passed applied after a later force-push', () => {
    const push = { headSha: OTHER_SHA, beforeSha: OLD_SHA, pushedAt: '2026-10-19T08:30:00Z' };

    expect(outcome(makeAttested({ forcePushes: [push] }))).toBe('ready');
  });

  it('does not count a UAT passed from an untrusted person', () => {
    const history = [
      makeSignOff({ label: 'UAT passed', appliedAt: BEFORE_HEAD, actor: UNTRUSTED }),
    ];

    expect(outcome(makeAttested({ uatPassedHistory: history }))).toBe('ready');
  });

  it('does not count when uat_since has no known arrival', () => {
    expect(outcome(makeAttested({ commitArrivals: { [HEAD_SHA]: HEAD_ARRIVED } }))).toBe('ready');
  });

  it('does not count an unchanged from an untrusted reviewer', () => {
    const attest = makeUatReview('unchanged', {
      since: OLD_SHA,
      code: undefined,
      review: { id: 2, author: UNTRUSTED },
    });
    const approval = makeUatReview('required');

    expect(outcome(makeAttested({ reviews: [approval, attest] }))).toBe('ready');
  });

  it('counts any trusted application bound to uat_since, not just the latest', () => {
    const history = [
      makeSignOff({ label: 'UAT passed', appliedAt: BEFORE_HEAD }),
      makeSignOff({
        label: 'UAT passed',
        appliedAt: '2026-10-19T11:00:00Z',
        actor: makeAuthor({ login: 'github-actions[bot]', type: 'Bot', permission: 'none' }),
      }),
    ];

    expect(outcome(makeAttested({ uatPassedHistory: history }))).toBe('passed-attested');
  });
});
