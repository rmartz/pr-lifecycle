import { describe, expect, it } from 'vitest';

import { parseVerdictRecord } from '../src/verdict-marker.js';
import { currentUatVerdict, currentVerdict, parseVerdict } from '../src/verdict.js';
import {
  HEAD_SHA,
  makeAuthor,
  makeDimensionedVerdictBody,
  makeFacts,
  makeReview,
  makeVerdictBody,
  OLD_SHA,
} from './fixtures.js';

// A /review marker records each decision of a pass as its own dimension (#141).
// Nothing acts on the UAT dimension yet; these pin the parsing and resolution.

const TESTED_SHA = 'd'.repeat(40);

describe('parseVerdictRecord — the verdicts map', () => {
  it('reads the code dimension', () => {
    const review = makeReview({ body: makeDimensionedVerdictBody({ code: 'blocked' }) });

    expect(parseVerdictRecord(review)?.code).toBe('blocked');
  });

  it.each(['not-needed', 'required'] as const)('reads a %s UAT decision', (uat) => {
    const review = makeReview({ body: makeDimensionedVerdictBody({ uat }) });

    expect(parseVerdictRecord(review)?.uat).toEqual({ kind: uat });
  });

  it('reads an unchanged UAT decision with the commit it builds on', () => {
    const body = makeDimensionedVerdictBody({ uat: 'unchanged' }, { uat_since: TESTED_SHA });

    expect(parseVerdictRecord(makeReview({ body }))?.uat).toEqual({
      kind: 'unchanged',
      since: TESTED_SHA,
    });
  });

  it.each([
    ['missing', {}],
    ['non-string', { uat_since: 42 }],
    ['abbreviated', { uat_since: 'd'.repeat(7) }],
    ['option-shaped', { uat_since: '--upload-pack=x' }],
  ])('fails an unchanged decision with a %s uat_since closed to required', (_label, extra) => {
    const body = makeDimensionedVerdictBody({ uat: 'unchanged' }, extra);

    expect(parseVerdictRecord(makeReview({ body }))?.uat).toEqual({ kind: 'required' });
  });

  it.each(['passed', 'Not-Needed', '', 1, null])(
    'fails the unreadable UAT value %j closed to required',
    (uat) => {
      const review = makeReview({ body: makeDimensionedVerdictBody({ uat }) });

      expect(parseVerdictRecord(review)?.uat).toEqual({ kind: 'required' });
    },
  );

  it('escalates an unreadable code dimension', () => {
    const review = makeReview({
      body: makeDimensionedVerdictBody({ code: 'lgtm', uat: 'required' }),
    });

    expect(parseVerdictRecord(review)?.code).toBe('escalation-needed');
  });

  it('records no code verdict for a marker that records only its UAT decision', () => {
    const review = makeReview({ body: makeDimensionedVerdictBody({ uat: 'not-needed' }) });

    expect(parseVerdictRecord(review)?.code).toBeUndefined();
  });

  it('records no UAT decision for a legacy marker', () => {
    const review = makeReview({ body: makeVerdictBody('approved') });

    expect(parseVerdictRecord(review)?.uat).toBeUndefined();
  });

  it('records no UAT decision for an unmarked native approval', () => {
    expect(parseVerdictRecord(makeReview({ state: 'APPROVED' }))?.uat).toBeUndefined();
  });

  it('prefers the map code over a legacy outcome', () => {
    const body = makeDimensionedVerdictBody({ code: 'changes-requested' }, { outcome: 'approved' });

    expect(parseVerdictRecord(makeReview({ body }))?.code).toBe('changes-requested');
  });

  it('reads the code verdict from outcome when the map records only UAT', () => {
    const body = makeDimensionedVerdictBody({ uat: 'not-needed' }, { outcome: 'approved' });

    expect(parseVerdictRecord(makeReview({ body }))?.code).toBe('approved');
  });

  it('escalates a map that records neither dimension', () => {
    const review = makeReview({ body: makeDimensionedVerdictBody({ release: 'yes' }) });

    expect(parseVerdictRecord(review)?.code).toBe('escalation-needed');
  });

  it.each([
    ['a string', 'approved'],
    ['an array', ['approved']],
  ])('treats a verdicts map that is %s as a legacy marker', (_label, verdicts) => {
    const review = makeReview({ body: makeDimensionedVerdictBody({}, { verdicts }) });

    expect(parseVerdictRecord(review)?.code).toBe('escalation-needed');
  });

  it('treats a skipped code dimension with no UAT decision as no verdict', () => {
    const review = makeReview({ body: makeDimensionedVerdictBody({ code: 'skipped' }) });

    expect(parseVerdictRecord(review)).toBeUndefined();
  });

  it('treats a dismissed review as no verdict, even with a UAT decision', () => {
    const review = makeReview({
      state: 'DISMISSED',
      body: makeDimensionedVerdictBody({ uat: 'not-needed' }),
    });

    expect(parseVerdictRecord(review)).toBeUndefined();
  });

  it('leaves a UAT-only marker out of the code verdict view', () => {
    const review = makeReview({ body: makeDimensionedVerdictBody({ uat: 'not-needed' }) });

    expect(parseVerdict(review)).toBeUndefined();
  });
});

describe('currentUatVerdict', () => {
  it('counts a trusted UAT decision bound to the head', () => {
    const review = makeReview({ body: makeDimensionedVerdictBody({ uat: 'not-needed' }) });

    expect(currentUatVerdict(makeFacts({ reviews: [review] }), {})).toEqual({ kind: 'not-needed' });
  });

  it('rejects a forged UAT decision from a read-only commenter', () => {
    const forged = makeReview({
      author: makeAuthor({ login: 'drive-by', permission: 'read' }),
      body: makeDimensionedVerdictBody({ uat: 'not-needed' }),
    });

    expect(currentUatVerdict(makeFacts({ reviews: [forged] }), {})).toBeUndefined();
  });

  it('rejects a forged UAT decision from a bot', () => {
    const forged = makeReview({
      author: makeAuthor({ login: 'github-actions[bot]', type: 'Bot', permission: 'write' }),
      body: makeDimensionedVerdictBody({ uat: 'not-needed' }),
    });

    expect(currentUatVerdict(makeFacts({ reviews: [forged] }), {})).toBeUndefined();
  });

  it('ignores a UAT decision on a stale head', () => {
    const review = makeReview({
      commitSha: OLD_SHA,
      body: makeDimensionedVerdictBody({ uat: 'not-needed' }, { pr_head: OLD_SHA }),
    });

    expect(currentUatVerdict(makeFacts({ reviews: [review] }), {})).toBeUndefined();
  });

  it.each([
    ['clean ancestor', { cleanAncestors: [OLD_SHA] }],
    ['clean rebase source', { cleanRebaseSources: [OLD_SHA] }],
  ])('carries a UAT decision on a verified %s over to the head', (_label, carried) => {
    const review = makeReview({
      commitSha: OLD_SHA,
      body: makeDimensionedVerdictBody({ uat: 'not-needed' }, { pr_head: OLD_SHA }),
    });

    expect(currentUatVerdict(makeFacts({ reviews: [review], ...carried }), {})).toEqual({
      kind: 'not-needed',
    });
  });

  it('is left in force by a later review that records only a code verdict', () => {
    const reviews = [
      makeReview({
        id: 1,
        body: makeDimensionedVerdictBody({ code: 'approved', uat: 'not-needed' }),
      }),
      makeReview({
        id: 2,
        submittedAt: '2026-09-23T13:00:00Z',
        body: makeVerdictBody('changes-requested'),
      }),
    ];

    expect(currentUatVerdict(makeFacts({ reviews }), {})).toEqual({ kind: 'not-needed' });
  });

  it('is superseded by a later review that records a UAT decision', () => {
    const reviews = [
      makeReview({ id: 1, body: makeDimensionedVerdictBody({ uat: 'not-needed' }) }),
      makeReview({
        id: 2,
        submittedAt: '2026-09-23T13:00:00Z',
        body: makeDimensionedVerdictBody({ uat: 'required' }),
      }),
    ];

    expect(currentUatVerdict(makeFacts({ reviews }), {})).toEqual({ kind: 'required' });
  });

  it('is revoked when its review is dismissed', () => {
    const review = makeReview({
      state: 'DISMISSED',
      body: makeDimensionedVerdictBody({ code: 'approved', uat: 'not-needed' }),
    });

    expect(currentUatVerdict(makeFacts({ reviews: [review] }), {})).toBeUndefined();
  });
});

describe('currentVerdict — with dimensioned markers', () => {
  it('reads the code verdict from a verdicts map', () => {
    const review = makeReview({
      body: makeDimensionedVerdictBody({ code: 'approved', uat: 'required' }),
    });

    expect(currentVerdict(makeFacts({ reviews: [review] }), {})).toBe('approved');
  });

  it('is left in force by a later review that records only a UAT decision', () => {
    const reviews = [
      makeReview({ id: 1, body: makeVerdictBody('approved') }),
      makeReview({
        id: 2,
        submittedAt: '2026-09-23T13:00:00Z',
        body: makeDimensionedVerdictBody({ uat: 'not-needed' }),
      }),
    ];

    expect(currentVerdict(makeFacts({ reviews }), {})).toBe('approved');
  });

  it('never lets a UAT decision name a head the review was not bound to', () => {
    const review = makeReview({
      commitSha: OLD_SHA,
      body: makeDimensionedVerdictBody(
        { code: 'approved', uat: 'not-needed' },
        { pr_head: HEAD_SHA },
      ),
    });
    const facts = makeFacts({ reviews: [review] });

    expect([currentVerdict(facts, {}), currentUatVerdict(facts, {})]).toEqual([
      undefined,
      undefined,
    ]);
  });
});
