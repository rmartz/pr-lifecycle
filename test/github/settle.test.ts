import { describe, expect, it } from 'vitest';

import { gatherFacts } from '../../src/github/gather.js';
import { reconcilePullRequest } from '../../src/github/reconcile.js';
import { DEFAULT_SETTLE_MS, resolveSettle, settleDelay } from '../../src/github/settle.js';
import { COPILOT_REQUEST_LOGIN, makeVerdictBody } from '../fixtures.js';
import { FakeGitHubClient, makePullRequestData, makeReviewData } from './fake-client.js';

const OPENED_AT = '2026-09-27T12:00:00Z';
const OPENED_MS = Date.parse(OPENED_AT);
const SETTLE_MS = 30_000;

function freshClient(overrides: Parameters<typeof makePullRequestData>[0] = {}) {
  return new FakeGitHubClient(makePullRequestData({ createdAt: OPENED_AT, ...overrides }));
}

async function delayFor(client: FakeGitHubClient, now: number, policy = {}) {
  const gathered = await gatherFacts(client, 7, policy);
  return settleDelay(client, 7, gathered, policy, SETTLE_MS, now);
}

describe('settleDelay', () => {
  it('waits out the rest of the window for a PR opened 5s ago', async () => {
    expect(await delayFor(freshClient(), OPENED_MS + 5_000)).toBe(25_000);
  });

  it('does not wait once the window has passed', async () => {
    expect(await delayFor(freshClient(), OPENED_MS + 31_000)).toBe(0);
  });

  it('measures from a recent ready-for-review, not the old creation time', async () => {
    const client = freshClient({ createdAt: '2026-09-01T00:00:00Z' });
    client.readyForReviewAt = OPENED_AT;

    expect(await delayFor(client, OPENED_MS + 10_000)).toBe(20_000);
  });

  it('waits at most the window when GitHub’s clock is ahead of ours', async () => {
    expect(await delayFor(freshClient(), OPENED_MS - 60_000)).toBe(SETTLE_MS);
  });

  it('waits the full window when the creation time is unparseable', async () => {
    expect(await delayFor(freshClient({ createdAt: 'not a time' }), OPENED_MS)).toBe(SETTLE_MS);
  });

  it('does not wait while a bot review is already requested', async () => {
    const client = freshClient({ requestedBotReviewers: [COPILOT_REQUEST_LOGIN] });

    expect(await delayFor(client, OPENED_MS + 1_000)).toBe(0);
  });

  it('does not wait for a PR that is approved', async () => {
    const client = freshClient();
    client.reviews = [makeReviewData({ body: makeVerdictBody('approved') })];
    client.permissions.set('maintainer', { permission: 'write', roleName: 'write' });

    expect(await delayFor(client, OPENED_MS + 1_000)).toBe(0);
  });

  it('does not wait once review requested is already labelled', async () => {
    const client = freshClient({ labels: ['review requested'] });

    expect(await delayFor(client, OPENED_MS + 1_000)).toBe(0);
  });

  it('reads the ready time only on the transition into review-requested', async () => {
    const client = freshClient({ labels: ['review requested'] });
    await delayFor(client, OPENED_MS + 1_000);

    expect(client.calls.some((call) => call.method === 'getLastReadyForReviewAt')).toBe(false);
  });

  it('does not wait when skipCopilotReview is set', async () => {
    expect(await delayFor(freshClient(), OPENED_MS + 1_000, { skipCopilotReview: true })).toBe(0);
  });
});

describe('resolveSettle', () => {
  it('defaults to a 30s window', () => {
    expect(resolveSettle().settleMs).toBe(DEFAULT_SETTLE_MS);
  });
});

describe('reconcilePullRequest settle wait', () => {
  /** A fake timer that records each wait and runs `during` while "sleeping". */
  function settleWith(during: () => void = () => undefined) {
    const waits: number[] = [];
    const settle = {
      settleMs: SETTLE_MS,
      now: () => OPENED_MS + 2_000,
      sleep: (ms: number) => {
        waits.push(ms);
        during();
        return Promise.resolve();
      },
    };
    return { settle, waits };
  }

  it('holds a just-opened PR whose Copilot request lands during the wait', async () => {
    const client = freshClient();
    const { settle } = settleWith(() => {
      client.pull.requestedBotReviewers = [COPILOT_REQUEST_LOGIN];
    });

    const { plan } = await reconcilePullRequest(client, 7, {}, { settle });

    expect([plan.state, client.pull.labels]).toEqual(['awaiting-bot-review', []]);
  });

  // The out-of-quota case (#36): no request ever comes, so the wait must end in
  // the same run, since no later event is guaranteed to fire.
  it('requests review in the same run when no bot request ever comes', async () => {
    const client = freshClient();
    const { settle, waits } = settleWith();

    const { plan, settledMs } = await reconcilePullRequest(client, 7, {}, { settle });

    expect([plan.state, client.pull.labels, settledMs, waits]).toEqual([
      'review-requested',
      ['review requested'],
      28_000,
      [28_000],
    ]);
  });

  it('never sleeps for a PR opened long ago', async () => {
    const client = new FakeGitHubClient();
    const { settle, waits } = settleWith();

    await reconcilePullRequest(client, 7, {}, { settle });

    expect(waits).toEqual([]);
  });
});
