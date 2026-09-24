import type { PullRequestFacts, ReviewAuthor, ReviewFact } from '../src/facts.js';
import type { ReconcilePlan } from '../src/plan.js';
import { COPILOT_REVIEWER_LOGIN } from '../src/state.js';

export const HEAD_SHA = 'a'.repeat(40);
export const OLD_SHA = 'b'.repeat(40);

export function makeAuthor(overrides: Partial<ReviewAuthor> = {}): ReviewAuthor {
  return { login: 'maintainer', type: 'User', permission: 'write', ...overrides };
}

export function makeReview(overrides: Partial<ReviewFact> = {}): ReviewFact {
  return {
    id: 1,
    author: makeAuthor(),
    commitSha: HEAD_SHA,
    state: 'COMMENTED',
    body: '',
    submittedAt: '2026-09-23T12:00:00Z',
    ...overrides,
  };
}

export function makeFacts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    status: 'open',
    isDraft: false,
    title: 'feat: add a thing',
    headSha: HEAD_SHA,
    labels: [],
    autoMergeEnabled: false,
    botEligible: false,
    mergeable: true,
    ciStatus: 'passing',
    baseCiFailing: false,
    reviews: [],
    ...overrides,
  };
}

/** A review body carrying a /review skill-meta marker, as post-review-verdict.py writes it. */
export function makeVerdictBody(outcome: string, prHead: string | undefined = HEAD_SHA): string {
  const meta = { skill: 'review', pr_head: prHead, skill_hash: 'c'.repeat(40), outcome };
  return `Looks good.\n\n---\n\n_Claude Opus 5.5_\n<!-- skill-meta: ${JSON.stringify(meta)} -->\n`;
}

export function makeCopilotReview(overrides: Partial<ReviewFact> = {}): ReviewFact {
  return makeReview({
    author: makeAuthor({ login: COPILOT_REVIEWER_LOGIN, type: 'Bot', permission: 'none' }),
    ...overrides,
  });
}

/** The PR's facts after the edge layer faithfully applies a plan. */
export function applyPlan(facts: PullRequestFacts, plan: ReconcilePlan): PullRequestFacts {
  const removed = new Set(plan.removeLabels);
  const labels = [...facts.labels.filter((name) => !removed.has(name)), ...plan.addLabels];
  const autoMergeEnabled =
    plan.autoMerge === 'none' ? facts.autoMergeEnabled : plan.autoMerge === 'arm';
  return { ...facts, labels, autoMergeEnabled };
}
