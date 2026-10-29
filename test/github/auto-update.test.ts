import { describe, expect, it } from 'vitest';

import { DEPENDABOT_LOGIN } from '../../src/bot-eligibility.js';
import type { PullRequestData } from '../../src/github/client.js';
import { GitHubApiError } from '../../src/github/client.js';
import {
  DEPENDABOT_REBASING_NOTICE,
  DEPENDABOT_RECREATING_NOTICE,
} from '../../src/github/dependabot-rebase.js';
import { executePlan } from '../../src/github/execute.js';
import { gatherFacts } from '../../src/github/gather.js';
import { reconcilePullRequest } from '../../src/github/reconcile.js';
import type { ReconcilePlan } from '../../src/plan.js';
import { UPDATE_REQUIRED_LABEL } from '../../src/plan.js';
import { COPILOT_REVIEWER_LOGIN, HEAD_SHA, makeVerdictBody } from '../fixtures.js';
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
  return { state: 'approved', addLabels: [], removeLabels: [], autoMerge: 'none', update };
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

  it('reports Dependabot rebasing from the PR body', async () => {
    const client = makeFlaggedClient({ ...DEPENDABOT, body: DEPENDABOT_RECREATING_NOTICE });

    const { facts } = await gatherFacts(client, 7, {});

    expect(facts.dependabotRebasing).toBe(true);
  });

  // A person's request means "asked", not "running": it must not raise the label.
  it('does not report Dependabot rebasing from a rebase request alone', async () => {
    const client = makeFlaggedClient(DEPENDABOT);
    client.comments = ['@dependabot rebase'];

    const { facts } = await gatherFacts(client, 7, AUTO_UPDATE);

    expect(facts.dependabotRebasing).toBe(false);
  });

  // Anyone can paste the notice into their own PR's body; only Dependabot's counts.
  it('does not report Dependabot rebasing for a PR not opened by Dependabot', async () => {
    const client = makeFlaggedClient({ body: DEPENDABOT_REBASING_NOTICE });

    const { facts } = await gatherFacts(client, 7, AUTO_UPDATE);

    expect(facts.dependabotRebasing).toBe(false);
  });

  it('reports a Dependabot security update from its commit metadata', async () => {
    const client = makeFlaggedClient(DEPENDABOT);
    client.commits = [
      {
        sha: 'c'.repeat(40),
        authorLogin: DEPENDABOT_LOGIN,
        message:
          '---\nupdated-dependencies:\n- dependency-name: x\n  dependency-version: 1.0.1\n...',
      },
    ];

    const { facts } = await gatherFacts(client, 7, {});

    expect(facts.securityUpdate).toBe(true);
  });

  it('does not report a security update for a PR not opened by Dependabot', async () => {
    const client = makeFlaggedClient();
    client.commits = [
      {
        sha: 'c'.repeat(40),
        authorLogin: DEPENDABOT_LOGIN,
        message:
          '---\nupdated-dependencies:\n- dependency-name: x\n  dependency-version: 1.0.1\n...',
      },
    ];

    const { facts } = await gatherFacts(client, 7, {});

    expect(facts.securityUpdate).toBe(false);
  });

  it('reads no comments for a Dependabot PR, even with auto-update on', async () => {
    const client = makeFlaggedClient(DEPENDABOT);

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

    await expect(executePlan(client, TARGET, makePlan('update-branch'))).resolves.toEqual({
      autoMerge: 'none',
      deferred: undefined,
    });
  });

  it('propagates any other update failure', async () => {
    const client = new FakeGitHubClient();
    client.failNext('updateBranch', new GitHubApiError(403, 'forbidden'));

    await expect(executePlan(client, TARGET, makePlan('update-branch'))).rejects.toThrow(
      'forbidden',
    );
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

  // Dependabot refuses `@dependabot rebase` from a GitHub App ("only users with
  // push access"), and update-branch would break its own rebasing: write nothing.
  it('leaves an approved Dependabot PR flagged update required untouched', async () => {
    const client = makeFlaggedClient(DEPENDABOT);

    await reconcilePullRequest(client, 7, AUTO_UPDATE);

    expect(client.writes).toEqual([]);
  });

  it('reports no skipped update for a Dependabot PR without a release token', async () => {
    const result = await reconcilePullRequest(makeFlaggedClient(DEPENDABOT), 7, AUTO_UPDATE, {
      release: 'unavailable',
    });

    expect(result.skippedUpdate).toBeUndefined();
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
