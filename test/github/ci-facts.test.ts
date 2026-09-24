import { describe, expect, it } from 'vitest';

import { gatherCiFacts } from '../../src/github/ci-facts.js';
import type { CheckRunData } from '../../src/github/client.js';
import { GitHubApiError } from '../../src/github/client.js';
import { HEAD_SHA } from '../fixtures.js';
import { FakeGitHubClient, makePullRequestData } from './fake-client.js';

const BASE_SHA = 'e'.repeat(40);

function makeRun(name: string, conclusion: string | null): CheckRunData {
  return {
    name,
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
    completedAt: conclusion === null ? null : '2026-09-24T00:00:00Z',
  };
}

function makeClient(headRuns: CheckRunData[], baseRuns: CheckRunData[] = []) {
  const client = new FakeGitHubClient(makePullRequestData());
  client.requiredChecks.set('main', ['Build', 'Test']);
  client.branchHeads.set('main', BASE_SHA);
  client.checkRuns.set(HEAD_SHA, headRuns);
  client.checkRuns.set(BASE_SHA, baseRuns);
  return client;
}

function methods(client: FakeGitHubClient): string[] {
  return client.calls.map((call) => call.method);
}

describe('gatherCiFacts', () => {
  it('is passing when the required checks passed', async () => {
    const client = makeClient([makeRun('Build', 'success'), makeRun('Test', 'success')]);

    expect(await gatherCiFacts(client, client.pull, {})).toEqual({
      ciStatus: 'passing',
      baseCiFailing: false,
    });
  });

  it('is pending while a required check runs', async () => {
    const client = makeClient([makeRun('Build', 'success'), makeRun('Test', null)]);

    expect((await gatherCiFacts(client, client.pull, {})).ciStatus).toBe('pending');
  });

  it('reads commit statuses as well as check-runs', async () => {
    const client = makeClient([makeRun('Build', 'success')]);
    client.commitStatuses.set(HEAD_SHA, [{ context: 'Test', state: 'failure' }]);

    expect((await gatherCiFacts(client, client.pull, {})).ciStatus).toBe('failing');
  });

  it('reports a failing head on a green base as not base-caused', async () => {
    const client = makeClient(
      [makeRun('Build', 'failure'), makeRun('Test', 'success')],
      [makeRun('Build', 'success'), makeRun('Test', 'success')],
    );

    expect(await gatherCiFacts(client, client.pull, {})).toEqual({
      ciStatus: 'failing',
      baseCiFailing: false,
    });
  });

  it('flags a red base when the base fails the same required checks', async () => {
    const client = makeClient(
      [makeRun('Build', 'failure'), makeRun('Test', 'success')],
      [makeRun('Build', 'failure'), makeRun('Test', 'success')],
    );

    expect((await gatherCiFacts(client, client.pull, {})).baseCiFailing).toBe(true);
  });

  it('only reads the base branch when the head is failing', async () => {
    const client = makeClient([makeRun('Build', 'success'), makeRun('Test', null)]);

    await gatherCiFacts(client, client.pull, {});

    expect(methods(client)).not.toContain('getBranchHeadSha');
  });

  it('passes the hold/ignored policy through', async () => {
    const client = makeClient([makeRun('Build', 'success'), makeRun('Test', 'failure')]);

    const facts = await gatherCiFacts(client, client.pull, { ignoredChecks: ['Test'] });

    expect(facts.ciStatus).toBe('passing');
  });

  it('is passing and reads no checks when none are required', async () => {
    const client = new FakeGitHubClient(makePullRequestData());

    const facts = await gatherCiFacts(client, client.pull, {});

    expect([facts.ciStatus, methods(client)]).toEqual(['passing', ['getRequiredStatusChecks']]);
  });

  it('treats a plan-limitation 403 (private repo on GitHub Free) as no required checks', async () => {
    const client = makeClient([makeRun('Build', 'failure')]);
    client.failNext(
      'getRequiredStatusChecks',
      new GitHubApiError(
        403,
        'GET /rules/branches/main → 403: {"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}',
      ),
    );

    expect((await gatherCiFacts(client, client.pull, {})).ciStatus).toBe('passing');
  });

  it('propagates any other 403, so a token missing permissions fails loudly', async () => {
    const client = makeClient([]);
    client.failNext(
      'getRequiredStatusChecks',
      new GitHubApiError(
        403,
        'GET /rules/branches/main → 403: Resource not accessible by integration',
      ),
    );

    await expect(gatherCiFacts(client, client.pull, {})).rejects.toThrow('not accessible');
  });

  it('spends no calls on a closed PR', async () => {
    const client = makeClient([makeRun('Build', 'failure')]);

    await gatherCiFacts(client, makePullRequestData({ state: 'closed' }), {});

    expect(client.calls).toEqual([]);
  });

  it('reads the required checks for the PR base branch', async () => {
    const client = makeClient([]);

    await gatherCiFacts(client, makePullRequestData({ baseRef: 'release/1.x' }), {});

    expect(client.calls[0]).toEqual({ method: 'getRequiredStatusChecks', args: ['release/1.x'] });
  });
});
