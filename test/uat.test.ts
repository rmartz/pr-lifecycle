import { describe, expect, it } from 'vitest';

import type { ReviewAuthor } from '../src/facts.js';
import type { UatOverrideLabel } from '../src/uat.js';
import { computeUatGate, overrideForLabel } from '../src/uat.js';
import { parseVerdict } from '../src/verdict.js';
import { makeAuthor, makeFacts, makeReview, makeVerdictBody, OLD_SHA } from './fixtures.js';

// The UAT gate's rules from docs/uat-gate.md, one direct test per row.

function verdictWithUat(uat: unknown, overrides: Parameters<typeof makeReview>[0] = {}) {
  return makeReview({ body: makeVerdictBody('approved', undefined, { uat }), ...overrides });
}

function override(label: UatOverrideLabel, appliedBy: ReviewAuthor = makeAuthor()) {
  return { label, appliedBy };
}

describe('parseVerdict — uat field', () => {
  it.each(['exempt', 'required'] as const)('reads uat: %s from a /review marker', (uat) => {
    expect(parseVerdict(verdictWithUat(uat))?.uat).toBe(uat);
  });

  it('reads an unknown uat value as absent', () => {
    expect(parseVerdict(verdictWithUat('maybe'))?.uat).toBeUndefined();
  });

  it('has no uat on a native approval', () => {
    expect(parseVerdict(makeReview({ state: 'APPROVED' }))?.uat).toBeUndefined();
  });
});

describe('computeUatGate — requirement source', () => {
  it('passes when the latest counting verdict is exempt', () => {
    const facts = makeFacts({ reviews: [verdictWithUat('exempt')] });

    expect(computeUatGate(facts, {})).toEqual({
      passes: true,
      required: false,
      reason: 'verdict-exempt',
      override: undefined,
    });
  });

  it('holds when the latest counting verdict requires UAT', () => {
    const facts = makeFacts({ reviews: [verdictWithUat('required')] });

    expect(computeUatGate(facts, {})).toEqual({
      passes: false,
      required: true,
      reason: 'verdict-required',
      override: undefined,
    });
  });

  it('fails closed on a verdict without a uat field', () => {
    const facts = makeFacts({ reviews: [makeReview({ body: makeVerdictBody('approved') })] });

    expect(computeUatGate(facts, {}).reason).toBe('verdict-unspecified');
  });

  it('fails closed on an unknown uat value', () => {
    const facts = makeFacts({ reviews: [verdictWithUat('maybe')] });

    expect(computeUatGate(facts, {}).passes).toBe(false);
  });

  it('fails closed on a native approval', () => {
    const facts = makeFacts({ reviews: [makeReview({ state: 'APPROVED' })] });

    expect(computeUatGate(facts, {}).reason).toBe('verdict-unspecified');
  });

  it('holds with no counting verdict', () => {
    expect(computeUatGate(makeFacts(), {}).reason).toBe('no-verdict');
  });

  it('passes an eligible bot PR with no counting verdict', () => {
    const facts = makeFacts({ botEligible: true });

    expect(computeUatGate(facts, {})).toMatchObject({ passes: true, reason: 'bot-eligible' });
  });

  it("uses a person's verdict over bot eligibility", () => {
    const facts = makeFacts({ botEligible: true, reviews: [verdictWithUat('required')] });

    expect(computeUatGate(facts, {}).reason).toBe('verdict-required');
  });

  it('reads the latest counting verdict, not an earlier one', () => {
    const earlier = verdictWithUat('exempt', { id: 1, submittedAt: '2026-09-23T12:00:00Z' });
    const later = verdictWithUat('required', { id: 2, submittedAt: '2026-09-23T13:00:00Z' });

    expect(computeUatGate(makeFacts({ reviews: [earlier, later] }), {}).reason).toBe(
      'verdict-required',
    );
  });

  it('carries an exempt verdict over a clean base update', () => {
    const facts = makeFacts({
      cleanAncestors: [OLD_SHA],
      reviews: [
        makeReview({
          commitSha: OLD_SHA,
          body: makeVerdictBody('approved', OLD_SHA, { uat: 'exempt' }),
        }),
      ],
    });

    expect(computeUatGate(facts, {}).reason).toBe('verdict-exempt');
  });
});

describe('computeUatGate — forged and stale exemptions', () => {
  it('ignores an exempt marker from a user without write access', () => {
    const forged = verdictWithUat('exempt', {
      author: makeAuthor({ login: 'drive-by', permission: 'triage' }),
    });

    expect(computeUatGate(makeFacts({ reviews: [forged] }), {}).reason).toBe('no-verdict');
  });

  it('ignores an exempt marker from a bot', () => {
    const forged = verdictWithUat('exempt', {
      author: makeAuthor({ login: 'github-actions[bot]', type: 'Bot', permission: 'admin' }),
    });

    expect(computeUatGate(makeFacts({ reviews: [forged] }), {}).passes).toBe(false);
  });

  it('ignores an exempt marker on an older head', () => {
    const stale = makeReview({
      commitSha: OLD_SHA,
      body: makeVerdictBody('approved', OLD_SHA, { uat: 'exempt' }),
    });

    expect(computeUatGate(makeFacts({ reviews: [stale] }), {}).passes).toBe(false);
  });

  it('ignores an exempt marker from an author off the trusted-authors list', () => {
    const facts = makeFacts({ reviews: [verdictWithUat('exempt')] });

    expect(computeUatGate(facts, { trustedAuthors: ['rmartz'] }).passes).toBe(false);
  });
});

describe('computeUatGate — human overrides', () => {
  const required = [verdictWithUat('required')];

  it.each(['UAT passed', 'no UAT needed'] as const)('passes a required gate on %s', (label) => {
    const facts = makeFacts({ reviews: required, uatOverrides: [override(label)] });

    expect(computeUatGate(facts, {})).toEqual({
      passes: true,
      required: true,
      reason: 'override',
      override: label,
    });
  });

  it('passes a no-verdict gate on a trusted override', () => {
    const facts = makeFacts({ uatOverrides: [override('UAT passed')] });

    expect(computeUatGate(facts, {}).passes).toBe(true);
  });

  it('ignores an override applied by a bot', () => {
    const bot = makeAuthor({ login: 'github-actions[bot]', type: 'Bot', permission: 'admin' });
    const facts = makeFacts({ reviews: required, uatOverrides: [override('UAT passed', bot)] });

    expect(computeUatGate(facts, {}).passes).toBe(false);
  });

  it('ignores an override applied by a triage-only user', () => {
    const triager = makeAuthor({ login: 'triager', permission: 'triage' });
    const facts = makeFacts({
      reviews: required,
      uatOverrides: [override('no UAT needed', triager)],
    });

    expect(computeUatGate(facts, {}).passes).toBe(false);
  });

  it('ignores an override with no verifiable applier', () => {
    const unverified = { label: 'UAT passed' as const, appliedBy: undefined };
    const facts = makeFacts({ reviews: required, uatOverrides: [unverified] });

    expect(computeUatGate(facts, {}).passes).toBe(false);
  });

  it('ignores an override from someone off the trusted-authors list', () => {
    const facts = makeFacts({ reviews: required, uatOverrides: [override('UAT passed')] });

    expect(computeUatGate(facts, { trustedAuthors: ['rmartz'] }).passes).toBe(false);
  });
});

describe('overrideForLabel', () => {
  it.each([
    ['UAT passed', 'UAT passed'],
    ['tested', 'UAT passed'],
    ['no UAT needed', 'no UAT needed'],
  ] as const)('reads %s as the %s override', (name, expected) => {
    expect(overrideForLabel(name)).toBe(expected);
  });

  it.each(['UAT ready', 'ready for UAT', 'UAT pending', 'approved'])(
    'does not treat %s as an override',
    (name) => {
      expect(overrideForLabel(name)).toBeUndefined();
    },
  );
});
