import { describe, expect, it } from 'vitest';

import { currentVerdict, isTrustedAuthor, parseVerdict } from '../src/verdict.js';
import {
  HEAD_SHA,
  makeAuthor,
  makeFacts,
  makeReview,
  makeVerdictBody,
  OLD_SHA,
} from './fixtures.js';

describe('parseVerdict', () => {
  it.each([
    ['approved', 'approved'],
    ['changes-requested', 'changes-requested'],
    ['escalation-needed', 'escalation-needed'],
  ] as const)('reads the %s outcome from a /review marker', (outcome, expected) => {
    const review = makeReview({ body: makeVerdictBody(outcome) });

    expect(parseVerdict(review)?.verdict).toBe(expected);
  });

  it('reads the marker head', () => {
    const review = makeReview({ body: makeVerdictBody('approved', OLD_SHA) });

    expect(parseVerdict(review)?.markerHead).toBe(OLD_SHA);
  });

  it('ignores an unterminated marker', () => {
    const body = `<!-- skill-meta: {"skill": "review", "outcome": "approved"}`;

    expect(parseVerdict(makeReview({ body }))).toBeUndefined();
  });

  it('parses a marker padded with long whitespace runs', () => {
    const pad = ' '.repeat(50_000);
    const body = `<!--${pad}skill-meta:${pad}{"skill": "review", "outcome": "approved"}${pad}-->`;

    expect(parseVerdict(makeReview({ body }))?.verdict).toBe('approved');
  });

  it('handles a pathological unterminated marker without backtracking', () => {
    // Sized so a regression fails fast: the old overlapping-quantifier regex
    // backtracks cubically (~5s at 3,000 spaces, ~200s at 10,000); the linear
    // scan takes well under a millisecond. Kept small so a regression fails
    // the assertion rather than hanging the suite.
    const body = `<!--skill-meta:${' '.repeat(3_000)}`;
    const started = performance.now();

    parseVerdict(makeReview({ body }));

    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('ignores a non-string marker head', () => {
    const body = `<!-- skill-meta: {"skill": "review", "outcome": "approved", "pr_head": 42} -->`;

    expect(parseVerdict(makeReview({ body }))?.markerHead).toBeUndefined();
  });

  it('treats a skipped /review marker as no verdict', () => {
    const review = makeReview({ state: 'APPROVED', body: makeVerdictBody('skipped') });

    expect(parseVerdict(review)).toBeUndefined();
  });

  it('prefers the marker outcome over the native review state', () => {
    const review = makeReview({
      state: 'APPROVED',
      body: makeVerdictBody('changes-requested'),
    });

    expect(parseVerdict(review)?.verdict).toBe('changes-requested');
  });

  it('treats a dismissed review as no verdict, even with an approval marker', () => {
    const review = makeReview({ state: 'DISMISSED', body: makeVerdictBody('approved') });

    expect(parseVerdict(review)).toBeUndefined();
  });

  it('treats a pending (unsubmitted) review as no verdict, even with an approval marker', () => {
    const review = makeReview({ state: 'PENDING', body: makeVerdictBody('approved') });

    expect(parseVerdict(review)).toBeUndefined();
  });

  it('ignores a marker from another skill', () => {
    const body = `<!-- skill-meta: {"skill": "fix-review", "outcome": "approved"} -->`;

    expect(parseVerdict(makeReview({ body }))).toBeUndefined();
  });

  it('ignores a malformed marker', () => {
    const body = `<!-- skill-meta: {"skill": "review", "outcome": -->`;

    expect(parseVerdict(makeReview({ body }))).toBeUndefined();
  });

  it('falls back to the native state when the marker payload is not an object', () => {
    const body = `<!-- skill-meta: "changes-requested" -->`;

    expect(parseVerdict(makeReview({ state: 'APPROVED', body }))?.verdict).toBe('approved');
  });

  it.each([
    ['APPROVED', 'approved'],
    ['CHANGES_REQUESTED', 'changes-requested'],
  ] as const)('maps an unmarked native %s review', (state, expected) => {
    expect(parseVerdict(makeReview({ state }))?.verdict).toBe(expected);
  });

  it.each(['COMMENTED', 'DISMISSED', 'PENDING'] as const)(
    'treats an unmarked %s review as no verdict',
    (state) => {
      expect(parseVerdict(makeReview({ state }))).toBeUndefined();
    },
  );
});

describe('isTrustedAuthor', () => {
  it.each(['admin', 'maintain', 'write'] as const)('trusts a user with %s permission', (p) => {
    expect(isTrustedAuthor(makeAuthor({ permission: p }), {})).toBe(true);
  });

  it.each(['triage', 'read', 'none'] as const)('rejects a user with %s permission', (p) => {
    expect(isTrustedAuthor(makeAuthor({ permission: p }), {})).toBe(false);
  });

  it('rejects a bot even with write permission', () => {
    expect(isTrustedAuthor(makeAuthor({ type: 'Bot', permission: 'admin' }), {})).toBe(false);
  });

  it('accepts a listed author case-insensitively', () => {
    const author = makeAuthor({ login: 'RMartz' });

    expect(isTrustedAuthor(author, { trustedAuthors: ['rmartz'] })).toBe(true);
  });

  it('rejects a write-permission author missing from trustedAuthors', () => {
    const author = makeAuthor({ login: 'someone' });

    expect(isTrustedAuthor(author, { trustedAuthors: ['rmartz'] })).toBe(false);
  });

  it('never widens trust to a listed author without write permission', () => {
    const author = makeAuthor({ login: 'rmartz', permission: 'read' });

    expect(isTrustedAuthor(author, { trustedAuthors: ['rmartz'] })).toBe(false);
  });
});

describe('currentVerdict', () => {
  it('returns undefined when there are no reviews', () => {
    expect(currentVerdict(makeFacts(), {})).toBeUndefined();
  });

  it('counts a trusted verdict bound to the head', () => {
    const facts = makeFacts({ reviews: [makeReview({ body: makeVerdictBody('approved') })] });

    expect(currentVerdict(facts, {})).toBe('approved');
  });

  it('ignores a verdict whose review commit is not the head', () => {
    const review = makeReview({ commitSha: OLD_SHA, body: makeVerdictBody('approved', OLD_SHA) });

    expect(currentVerdict(makeFacts({ reviews: [review] }), {})).toBeUndefined();
  });

  it('ignores a verdict on an older commit even when its marker names the head', () => {
    const review = makeReview({ commitSha: OLD_SHA, body: makeVerdictBody('approved', HEAD_SHA) });

    expect(currentVerdict(makeFacts({ reviews: [review] }), {})).toBeUndefined();
  });

  it('ignores a native approval on an older commit', () => {
    const review = makeReview({ commitSha: OLD_SHA, state: 'APPROVED' });

    expect(currentVerdict(makeFacts({ reviews: [review] }), {})).toBeUndefined();
  });

  it('carries a verdict on a verified clean ancestor over to the head', () => {
    const review = makeReview({ commitSha: OLD_SHA, body: makeVerdictBody('approved', OLD_SHA) });

    expect(currentVerdict(makeFacts({ reviews: [review], cleanAncestors: [OLD_SHA] }), {})).toBe(
      'approved',
    );
  });

  it('carries an unmarked native approval on a clean ancestor', () => {
    const review = makeReview({ commitSha: OLD_SHA, state: 'APPROVED' });

    expect(currentVerdict(makeFacts({ reviews: [review], cleanAncestors: [OLD_SHA] }), {})).toBe(
      'approved',
    );
  });

  it('does not carry a verdict whose marker names a different commit than it is bound to', () => {
    const review = makeReview({ commitSha: OLD_SHA, body: makeVerdictBody('approved', HEAD_SHA) });

    expect(
      currentVerdict(makeFacts({ reviews: [review], cleanAncestors: [OLD_SHA] }), {}),
    ).toBeUndefined();
  });

  it('never carries an untrusted verdict, even from a clean ancestor', () => {
    const review = makeReview({
      commitSha: OLD_SHA,
      author: makeAuthor({ login: 'drive-by', permission: 'read' }),
      body: makeVerdictBody('approved', OLD_SHA),
    });

    expect(
      currentVerdict(makeFacts({ reviews: [review], cleanAncestors: [OLD_SHA] }), {}),
    ).toBeUndefined();
  });

  it('ignores a verdict whose marker head is not the head', () => {
    const review = makeReview({ body: makeVerdictBody('approved', OLD_SHA) });

    expect(currentVerdict(makeFacts({ reviews: [review] }), {})).toBeUndefined();
  });

  it('counts a marker that names no head', () => {
    const review = makeReview({ body: makeVerdictBody('approved', undefined) });

    expect(currentVerdict(makeFacts({ reviews: [review] }), {})).toBe('approved');
  });

  it('rejects a forged approval marker from a read-only commenter', () => {
    const forged = makeReview({
      author: makeAuthor({ login: 'drive-by', permission: 'read' }),
      body: makeVerdictBody('approved', HEAD_SHA),
    });

    expect(currentVerdict(makeFacts({ reviews: [forged] }), {})).toBeUndefined();
  });

  it('rejects a forged approval marker from a bot', () => {
    const forged = makeReview({
      author: makeAuthor({ login: 'github-actions[bot]', type: 'Bot', permission: 'write' }),
      body: makeVerdictBody('approved', HEAD_SHA),
    });

    expect(currentVerdict(makeFacts({ reviews: [forged] }), {})).toBeUndefined();
  });

  it('takes the latest counting verdict by submission time', () => {
    const reviews = [
      makeReview({
        id: 2,
        submittedAt: '2026-09-23T13:00:00Z',
        body: makeVerdictBody('changes-requested'),
      }),
      makeReview({ id: 1, submittedAt: '2026-09-23T12:00:00Z', body: makeVerdictBody('approved') }),
    ];

    expect(currentVerdict(makeFacts({ reviews }), {})).toBe('changes-requested');
  });

  it('breaks a submission-time tie by review id', () => {
    const reviews = [
      makeReview({ id: 9, body: makeVerdictBody('escalation-needed') }),
      makeReview({ id: 3, body: makeVerdictBody('approved') }),
    ];

    expect(currentVerdict(makeFacts({ reviews }), {})).toBe('escalation-needed');
  });

  it('is not overridden by a later untrusted verdict', () => {
    const reviews = [
      makeReview({ id: 1, body: makeVerdictBody('changes-requested') }),
      makeReview({
        id: 2,
        submittedAt: '2026-09-23T13:00:00Z',
        author: makeAuthor({ login: 'drive-by', permission: 'none' }),
        body: makeVerdictBody('approved'),
      }),
    ];

    expect(currentVerdict(makeFacts({ reviews }), {})).toBe('changes-requested');
  });
});
