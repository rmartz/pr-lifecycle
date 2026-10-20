import { describe, expect, it } from 'vitest';

import { isRetitledSince, isSignOffCurrent } from '../src/uat-binding.js';
import { HEAD_SHA, OLD_SHA } from './fixtures.js';
import {
  AFTER_HEAD,
  BEFORE_HEAD,
  HEAD_ARRIVED,
  makeSignOff,
  makeUatFacts,
} from './uat-fixtures.js';

const CARRIED = new Set([OLD_SHA]);
const OLD_ARRIVED = '2026-10-19T08:00:00Z';

describe('isSignOffCurrent — the head', () => {
  it('binds a sign-off applied after the head arrived', () => {
    expect(isSignOffCurrent(makeSignOff(), makeUatFacts())).toBe(true);
  });

  it('does not bind a sign-off applied before the head arrived', () => {
    expect(isSignOffCurrent(makeSignOff({ appliedAt: BEFORE_HEAD }), makeUatFacts())).toBe(false);
  });

  it('does not bind a sign-off applied in the same instant the head arrived', () => {
    expect(isSignOffCurrent(makeSignOff({ appliedAt: HEAD_ARRIVED }), makeUatFacts())).toBe(false);
  });

  it('does not bind when the head has no known arrival', () => {
    const facts = makeUatFacts({ commitArrivals: {} });

    expect(isSignOffCurrent(makeSignOff(), facts)).toBe(false);
  });

  it('does not bind a sign-off with an unreadable time', () => {
    expect(isSignOffCurrent(makeSignOff({ appliedAt: 'yesterday' }), makeUatFacts())).toBe(false);
  });

  it('uses the force-push that made the head when it is later than the first check suite', () => {
    const facts = makeUatFacts({
      forcePushes: [{ headSha: HEAD_SHA, pushedAt: '2026-10-19T12:00:00Z' }],
    });

    expect(isSignOffCurrent(makeSignOff({ appliedAt: AFTER_HEAD }), facts)).toBe(false);
  });

  it('treats a force-push GitHub did not attribute as a possible arrival of the head', () => {
    const facts = makeUatFacts({
      forcePushes: [{ headSha: undefined, pushedAt: '2026-10-19T12:00:00Z' }],
    });

    expect(isSignOffCurrent(makeSignOff({ appliedAt: AFTER_HEAD }), facts)).toBe(false);
  });

  it('does not bind when a force-push to the head has an unreadable time', () => {
    const facts = makeUatFacts({ forcePushes: [{ headSha: HEAD_SHA, pushedAt: 'soon' }] });

    expect(isSignOffCurrent(makeSignOff(), facts)).toBe(false);
  });

  it('binds from a force-push alone when the head has no check suite', () => {
    const facts = makeUatFacts({
      commitArrivals: {},
      forcePushes: [{ headSha: HEAD_SHA, pushedAt: HEAD_ARRIVED }],
    });

    expect(isSignOffCurrent(makeSignOff(), facts)).toBe(true);
  });
});

describe('isSignOffCurrent — carried commits', () => {
  it('ignores carried commits unless they are passed', () => {
    const facts = makeUatFacts({
      cleanAncestors: [OLD_SHA],
      commitArrivals: { [HEAD_SHA]: HEAD_ARRIVED, [OLD_SHA]: OLD_ARRIVED },
    });

    expect(isSignOffCurrent(makeSignOff({ appliedAt: BEFORE_HEAD }), facts)).toBe(false);
  });

  it('binds a sign-off on a clean ancestor with no force-push since', () => {
    const facts = makeUatFacts({
      cleanAncestors: [OLD_SHA],
      commitArrivals: { [HEAD_SHA]: HEAD_ARRIVED, [OLD_SHA]: OLD_ARRIVED },
    });

    expect(isSignOffCurrent(makeSignOff({ appliedAt: BEFORE_HEAD }), facts, CARRIED)).toBe(true);
  });

  it('does not bind a sign-off applied before the carried commit arrived', () => {
    const facts = makeUatFacts({
      commitArrivals: { [HEAD_SHA]: HEAD_ARRIVED, [OLD_SHA]: OLD_ARRIVED },
    });
    const signOff = makeSignOff({ appliedAt: '2026-10-19T07:00:00Z' });

    expect(isSignOffCurrent(signOff, facts, CARRIED)).toBe(false);
  });

  it('binds a sign-off on a rebase source the force-push replaced', () => {
    const facts = makeUatFacts({
      commitArrivals: { [OLD_SHA]: OLD_ARRIVED },
      forcePushes: [{ headSha: HEAD_SHA, beforeSha: OLD_SHA, pushedAt: HEAD_ARRIVED }],
    });

    expect(isSignOffCurrent(makeSignOff({ appliedAt: BEFORE_HEAD }), facts, CARRIED)).toBe(true);
  });

  it('does not bind when an ordinary push came between the carried commit and the force-push', () => {
    const between = 'c'.repeat(40);
    const facts = makeUatFacts({
      commitArrivals: { [OLD_SHA]: OLD_ARRIVED },
      forcePushes: [{ headSha: HEAD_SHA, beforeSha: between, pushedAt: HEAD_ARRIVED }],
    });

    expect(isSignOffCurrent(makeSignOff({ appliedAt: BEFORE_HEAD }), facts, CARRIED)).toBe(false);
  });

  it('does not bind when the force-push did not say what it replaced', () => {
    const facts = makeUatFacts({
      commitArrivals: { [OLD_SHA]: OLD_ARRIVED },
      forcePushes: [{ headSha: HEAD_SHA, beforeSha: undefined, pushedAt: HEAD_ARRIVED }],
    });

    expect(isSignOffCurrent(makeSignOff({ appliedAt: BEFORE_HEAD }), facts, CARRIED)).toBe(false);
  });

  it('does not bind a sign-off applied after the force-push that replaced the carried commit', () => {
    const facts = makeUatFacts({
      commitArrivals: { [OLD_SHA]: OLD_ARRIVED },
      forcePushes: [
        { headSha: 'c'.repeat(40), beforeSha: OLD_SHA, pushedAt: '2026-10-19T08:30:00Z' },
        { headSha: HEAD_SHA, beforeSha: 'c'.repeat(40), pushedAt: HEAD_ARRIVED },
      ],
    });

    expect(isSignOffCurrent(makeSignOff({ appliedAt: BEFORE_HEAD }), facts, CARRIED)).toBe(false);
  });

  it('does not bind when a force-push has an unreadable time', () => {
    const facts = makeUatFacts({
      commitArrivals: { [OLD_SHA]: OLD_ARRIVED },
      forcePushes: [{ headSha: HEAD_SHA, beforeSha: OLD_SHA, pushedAt: 'then' }],
    });

    expect(isSignOffCurrent(makeSignOff({ appliedAt: BEFORE_HEAD }), facts, CARRIED)).toBe(false);
  });

  it('does not bind to a carried commit with no known arrival', () => {
    const facts = makeUatFacts({
      forcePushes: [{ headSha: HEAD_SHA, beforeSha: OLD_SHA, pushedAt: HEAD_ARRIVED }],
    });

    expect(isSignOffCurrent(makeSignOff({ appliedAt: BEFORE_HEAD }), facts, CARRIED)).toBe(false);
  });
});

describe('isRetitledSince', () => {
  it('is true when the title changed after the sign-off', () => {
    const facts = makeUatFacts({ titleChanges: ['2026-10-19T12:00:00Z'] });

    expect(isRetitledSince(makeSignOff(), facts)).toBe(true);
  });

  it('is false when the title changed before the sign-off', () => {
    const facts = makeUatFacts({ titleChanges: [BEFORE_HEAD] });

    expect(isRetitledSince(makeSignOff(), facts)).toBe(false);
  });

  it('is true when a title change has an unreadable time', () => {
    const facts = makeUatFacts({ titleChanges: ['at some point'] });

    expect(isRetitledSince(makeSignOff(), facts)).toBe(true);
  });
});
