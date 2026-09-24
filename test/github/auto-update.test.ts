import { describe, expect, it } from 'vitest';

import { DEPENDABOT_LOGIN } from '../../src/bot-eligibility.js';
import type { PullRequestData } from '../../src/github/client.js';
import { GitHubApiError } from '../../src/github/client.js';
import {
  buildRebaseRequestBody,
  DEPENDABOT_REBASING_NOTICE,
} from '../../src/github/dependabot-rebase.js';
import { executePlan } from '../../src/github/execute.js';
import { gatherFacts } from '../../src/github/gather.js';
import { reconcilePullRequest } from '../../src/github/reconcile.js';
import type { ReconcilePlan } from '../../src/plan.js';
import { UPDATE_REQUIRED_LABEL } from '../../src/plan.js';
import { COPILOT_REVIEWER_LOGIN } from '../../src/state.js';
import { HEAD_SHA, makeVerdictBody } from '../fixtures.js';
import { FakeGitHubClient, makePullRequestData, makeReviewData } from './fake-client.js';

/** An approved PR (Copilot-reviewed, maintainer-approved) flagged `update required`. */
function makeFlaggedClient(overrides: Partial<PullRequestData> = {}): FakeGitHubClient {
  const client = new FakeGitHubClient(
    makePullRequestData({ labels: [UPDATE_REQUIRED_LABEL, 'approved'], ...overrides }),
    [
      makeReviewData({ id: 1, login: COPILOT_REVIEWER_LOGIN, type: 'Bot' }),
      makeReviewData({ id: 2, body: makeVerdictBody('approved') }),
    ],
  );
  client.permissions.set('maintainer', { permission: 'write', roleName: 'write' });
  return client;
}

const DEPENDABOT = { authorLogin: DEPENDABOT_LOGIN, headRef: 'dependabot/npm_and_yarn/x-1.0.1' };
const AUTO_UPDATE = { autoUpdate: true };
const TARGET = { pr: 7, nodeId: 'PR_node', headSha: HEAD_SHA };

function makePlan(update: ReconcilePlan['update']): ReconcilePlan {
  return {
    state: 'approved',
    addLabels: [],
    removeLabels: [],
    autoMerge: 'none',
    update,
    uatGate: undefined,
  };
}

describe('gatherFacts — branch updater', () => {
  it('uses update-branch for a PR not opened by Dependabot', async () => {
    const { facts } = await gatherFacts(makeFlaggedClient(), 7, AUTO_UPDATE);

    expect(facts.updater).toBe('github');
  });

  it('leaves a Dependabot PR to Dependabot', async () => {
    const { facts } = await gatherFacts(makeFlaggedClient(DEPENDABOT), 7, AUTO_UPDATE);

    expect(facts.updater).toBe('dependabot');
  });

  it('sees a rebase in progress from the PR body', async () => {
    const client = makeFlaggedClient({ ...DEPENDABOT, body: DEPENDABOT_REBASING_NOTICE });

    const { facts } = await gatherFacts(client, 7, AUTO_UPDATE);

    expect(facts.rebasePending).toBe(true);
  });

  it('sees a rebase already requested for this head', async () => {
    const client = makeFlaggedClient(DEPENDABOT);
    client.comments = [buildRebaseRequestBody(HEAD_SHA)];

    const { facts } = await gatherFacts(client, 7, AUTO_UPDATE);

    expect(facts.rebasePending).toBe(true);
  });

  it('reads no comments when auto-update is off', async () => {
    const client = makeFlaggedClient(DEPENDABOT);

    await gatherFacts(client, 7, {});

    expect(client.calls.some((call) => call.method === 'listIssueComments')).toBe(false);
  });

  it('reads no comments for a PR not opened by Dependabot', async () => {
    const client = makeFlaggedClient();

    await gatherFacts(client, 7, AUTO_UPDATE);

    expect(client.calls.some((call) => call.method === 'listIssueComments')).toBe(false);
  });
});

describe('executePlan — update', () => {
  it('updates the branch through the release actions, bound to the head', async () => {
    const client = new FakeGitHubClient();
    const release = new FakeGitHubClient();

    await executePlan(client, TARGET, makePlan('update-branch'), release);

    expect([release.writes, client.writes]).toEqual([
      [{ method: 'updateBranch', args: [7, HEAD_SHA] }],
      [],
    ]);
  });

  it('treats a 422 (head moved, or nothing to merge) as a no-op', async () => {
    const client = new FakeGitHubClient();
    client.failNext('updateBranch', new GitHubApiError(422, 'expected head sha did not match'));

    await expect(executePlan(client, TARGET, makePlan('update-branch'))).resolves.toBeUndefined();
  });

  it('propagates any other update failure', async () => {
    const client = new FakeGitHubClient();
    client.failNext('updateBranch', new GitHubApiError(403, 'forbidden'));

    await expect(executePlan(client, TARGET, makePlan('update-branch'))).rejects.toThrow(
      'forbidden',
    );
  });

  it('asks Dependabot to rebase through the release actions', async () => {
    const client = new FakeGitHubClient();
    const release = new FakeGitHubClient();

    await executePlan(client, TARGET, makePlan('dependabot-rebase'), release);

    expect(release.writes).toEqual([
      { method: 'createIssueComment', args: [7, buildRebaseRequestBody(HEAD_SHA)] },
    ]);
  });

  it('updates after arming, since the update moves the head', async () => {
    const client = new FakeGitHubClient();
    const plan = { ...makePlan('update-branch'), autoMerge: 'arm' as const };

    await executePlan(client, TARGET, plan);

    expect(client.writes.map((call) => call.method)).toEqual(['enableAutoMerge', 'updateBranch']);
  });
});

describe('reconcilePullRequest — auto-update', () => {
  it('updates a regular approved PR with update-branch', async () => {
    const client = makeFlaggedClient();

    await reconcilePullRequest(client, 7, AUTO_UPDATE);

    expect(client.writes).toEqual([{ method: 'updateBranch', args: [7, HEAD_SHA] }]);
  });

  it('never calls update-branch on a Dependabot PR', async () => {
    const client = makeFlaggedClient(DEPENDABOT);

    await reconcilePullRequest(client, 7, AUTO_UPDATE);

    expect(client.writes).toEqual([
      { method: 'createIssueComment', args: [7, buildRebaseRequestBody(HEAD_SHA)] },
    ]);
  });

  it('asks Dependabot only once for the same head', async () => {
    const client = makeFlaggedClient(DEPENDABOT);

    await reconcilePullRequest(client, 7, AUTO_UPDATE);
    await reconcilePullRequest(client, 7, AUTO_UPDATE);

    expect(client.comments).toEqual([buildRebaseRequestBody(HEAD_SHA)]);
  });

  it('asks again once Dependabot has pushed a new head', async () => {
    const client = makeFlaggedClient(DEPENDABOT);
    await reconcilePullRequest(client, 7, AUTO_UPDATE);
    const rebased = 'e'.repeat(40);
    client.pull.headSha = rebased;
    client.reviews = client.reviews.map((review) => ({
      ...review,
      commitSha: rebased,
      body: review.id === 2 ? makeVerdictBody('approved', rebased) : review.body,
    }));

    await reconcilePullRequest(client, 7, AUTO_UPDATE);

    expect(client.comments).toEqual([
      buildRebaseRequestBody(HEAD_SHA),
      buildRebaseRequestBody(rebased),
    ]);
  });

  it('skips and reports the update when no release token is available', async () => {
    const client = makeFlaggedClient();

    const result = await reconcilePullRequest(client, 7, AUTO_UPDATE, { release: 'unavailable' });

    expect([result.skippedUpdate, client.writes]).toEqual(['update-branch', []]);
  });

  it('reports nothing skipped when no update was wanted', async () => {
    const result = await reconcilePullRequest(
      makeFlaggedClient(),
      7,
      {},
      {
        release: 'unavailable',
      },
    );

    expect(result.skippedUpdate).toBeUndefined();
  });
});
