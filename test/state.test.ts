import { describe, expect, it } from 'vitest';

import { computeState } from '../src/state.js';
import {
  HEAD_SHA,
  makeAuthor,
  makeCopilotReview,
  makeFacts,
  makeReview,
  makeVerdictBody,
  OLD_SHA,
} from './fixtures.js';

describe('computeState', () => {
  it.each(['closed', 'merged'] as const)('is closed for a %s PR', (status) => {
    const facts = makeFacts({
      status,
      reviews: [makeReview({ body: makeVerdictBody('approved') })],
    });

    expect(computeState(facts, {})).toBe('closed');
  });

  it('is draft for a draft PR, even with an approval', () => {
    const facts = makeFacts({
      isDraft: true,
      reviews: [makeReview({ body: makeVerdictBody('approved') })],
    });

    expect(computeState(facts, {})).toBe('draft');
  });

  it('is fix-required for a conflicting PR, even with an approval', () => {
    const facts = makeFacts({
      mergeable: false,
      reviews: [makeReview({ body: makeVerdictBody('approved') })],
    });

    expect(computeState(facts, {})).toBe('fix-required');
  });

  it('is fix-required for a conflicting eligible bot PR', () => {
    expect(computeState(makeFacts({ mergeable: false, botEligible: true }), {})).toBe(
      'fix-required',
    );
  });

  it('keeps a conflicting draft a draft', () => {
    expect(computeState(makeFacts({ mergeable: false, isDraft: true }), {})).toBe('draft');
  });

  it('is ci-failing when required CI fails, even with an approval', () => {
    const facts = makeFacts({
      ciStatus: 'failing',
      reviews: [makeReview({ body: makeVerdictBody('approved') })],
    });

    expect(computeState(facts, {})).toBe('ci-failing');
  });

  it('is blocked-base-red when CI fails on the base branch too', () => {
    expect(computeState(makeFacts({ ciStatus: 'failing', baseCiFailing: true }), {})).toBe(
      'blocked-base-red',
    );
  });

  it('ignores a red base when the PR itself is passing', () => {
    const facts = makeFacts({ baseCiFailing: true, reviews: [makeCopilotReview()] });

    expect(computeState(facts, {})).toBe('review-requested');
  });

  it('ranks a merge conflict above failing CI', () => {
    expect(computeState(makeFacts({ mergeable: false, ciStatus: 'failing' }), {})).toBe(
      'fix-required',
    );
  });

  it('is awaiting-ci instead of review-requested while CI is running', () => {
    const facts = makeFacts({ ciStatus: 'pending', reviews: [makeCopilotReview()] });

    expect(computeState(facts, {})).toBe('awaiting-ci');
  });

  it('is awaiting-ci even when Copilot is skipped', () => {
    expect(computeState(makeFacts({ ciStatus: 'pending' }), { skipCopilotReview: true })).toBe(
      'awaiting-ci',
    );
  });

  it('keeps an approval on the head while CI is running', () => {
    const facts = makeFacts({
      ciStatus: 'pending',
      reviews: [makeReview({ body: makeVerdictBody('approved') })],
    });

    expect(computeState(facts, {})).toBe('approved');
  });

  it('keeps an eligible bot PR approved while CI is running', () => {
    expect(computeState(makeFacts({ ciStatus: 'pending', botEligible: true }), {})).toBe(
      'approved',
    );
  });

  it('is awaiting-ci after an unreviewed push onto an approved PR', () => {
    const facts = makeFacts({
      ciStatus: 'pending',
      reviews: [makeReview({ commitSha: OLD_SHA, body: makeVerdictBody('approved', OLD_SHA) })],
    });

    expect(computeState(facts, {})).toBe('awaiting-ci');
  });

  it('treats an unknown mergeable (GitHub still computing) as no conflict', () => {
    const facts = makeFacts({
      mergeable: undefined,
      reviews: [makeReview({ body: makeVerdictBody('approved') })],
    });

    expect(computeState(facts, {})).toBe('approved');
  });

  it.each(['[WIP] feat: thing', 'feat: thing [wip]'])('is draft for the title %j', (title) => {
    expect(computeState(makeFacts({ title }), {})).toBe('draft');
  });

  it('is awaiting-copilot with no reviews', () => {
    expect(computeState(makeFacts(), {})).toBe('awaiting-copilot');
  });

  it('is review-requested once Copilot has reviewed the head', () => {
    expect(computeState(makeFacts({ reviews: [makeCopilotReview()] }), {})).toBe(
      'review-requested',
    );
  });

  it('stays awaiting-copilot when Copilot only reviewed an older commit', () => {
    const facts = makeFacts({ reviews: [makeCopilotReview({ commitSha: OLD_SHA })] });

    expect(computeState(facts, {})).toBe('awaiting-copilot');
  });

  it('skips the Copilot wait when skipCopilotReview is set', () => {
    expect(computeState(makeFacts(), { skipCopilotReview: true })).toBe('review-requested');
  });

  it('still honors a counting verdict when skipCopilotReview is set', () => {
    const facts = makeFacts({
      reviews: [
        makeReview({
          commitSha: HEAD_SHA,
          author: makeAuthor({ permission: 'write' }),
          body: makeVerdictBody('approved'),
        }),
      ],
    });

    expect(computeState(facts, { skipCopilotReview: true })).toBe('approved');
  });

  it('keeps a draft a draft when skipCopilotReview is set', () => {
    expect(computeState(makeFacts({ isDraft: true }), { skipCopilotReview: true })).toBe('draft');
  });

  it.each([
    ['approved', 'approved'],
    ['changes-requested', 'changes-requested'],
    ['escalation-needed', 'escalation-needed'],
  ] as const)('takes the %s state from a counting verdict', (outcome, expected) => {
    const facts = makeFacts({ reviews: [makeReview({ body: makeVerdictBody(outcome) })] });

    expect(computeState(facts, {})).toBe(expected);
  });

  it('is approved for an eligible bot PR with no verdict', () => {
    expect(computeState(makeFacts({ botEligible: true }), {})).toBe('approved');
  });

  it('lets a trusted verdict hold an eligible bot PR', () => {
    const facts = makeFacts({
      botEligible: true,
      reviews: [makeReview({ body: makeVerdictBody('changes-requested') })],
    });

    expect(computeState(facts, {})).toBe('changes-requested');
  });

  it('falls back to review-requested after a push invalidates an approval', () => {
    const facts = makeFacts({
      reviews: [
        makeReview({ commitSha: OLD_SHA, body: makeVerdictBody('approved', OLD_SHA) }),
        makeCopilotReview({ id: 2 }),
      ],
    });

    expect(computeState(facts, {})).toBe('review-requested');
  });
});
