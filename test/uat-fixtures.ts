import type { PullRequestFacts, ReviewFact, UatSignOffFact } from '../src/facts.js';
import {
  HEAD_SHA,
  makeAuthor,
  makeDimensionedVerdictBody,
  makeFacts,
  makeReview,
  makeVerdictBody,
} from './fixtures.js';

/** Shared setup for the UAT tests: a feature PR whose head arrived at HEAD_ARRIVED. */

export const HEAD_ARRIVED = '2026-10-19T10:00:00Z';
export const BEFORE_HEAD = '2026-10-19T09:00:00Z';
export const AFTER_HEAD = '2026-10-19T11:00:00Z';

export function makeSignOff(overrides: Partial<UatSignOffFact> = {}): UatSignOffFact {
  return {
    label: 'no UAT needed',
    actor: makeAuthor({ login: 'rmartz', permission: 'admin' }),
    appliedAt: AFTER_HEAD,
    ...overrides,
  };
}

/** A feature PR touching source, so nothing exempts it from UAT. */
export function makeUatFacts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return makeFacts({
    title: 'feat: add a thing',
    changedPaths: ['src/thing.ts'],
    commitArrivals: { [HEAD_SHA]: HEAD_ARRIVED },
    ...overrides,
  });
}

/** A trusted `/review` approval of the head, submitted after it arrived. */
export function makeApproval(commitSha: string = HEAD_SHA) {
  return makeReview({
    body: makeVerdictBody('approved', commitSha),
    commitSha,
    submittedAt: '2026-10-19T10:30:00Z',
  });
}

/** The facts with `signOffs` present as labels and as label applications. */
export function withSignOffs(
  facts: PullRequestFacts,
  ...signOffs: UatSignOffFact[]
): PullRequestFacts {
  return {
    ...facts,
    labels: [...facts.labels, ...signOffs.map((signOff) => signOff.label)],
    uatSignOffs: signOffs,
  };
}

/**
 * A trusted `/review` that records a UAT decision (and, unless `code` is
 * undefined, a code verdict) for `prHead`, submitted after the head arrived.
 */
export function makeUatReview(
  uat: string,
  options: {
    code?: string | undefined;
    since?: string;
    prHead?: string;
    review?: Partial<ReviewFact>;
  } = {},
): ReviewFact {
  const prHead = options.prHead ?? HEAD_SHA;
  const code = 'code' in options ? options.code : 'approved';
  const verdicts = code === undefined ? { uat } : { code, uat };
  return makeReview({
    body: makeDimensionedVerdictBody(verdicts, {
      pr_head: prHead,
      ...(options.since === undefined ? {} : { uat_since: options.since }),
    }),
    commitSha: prHead,
    submittedAt: '2026-10-19T10:30:00Z',
    ...options.review,
  });
}
