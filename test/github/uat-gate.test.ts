import { describe, expect, it } from 'vitest';

import type { CheckRunWrite, LabelEventData } from '../../src/github/client.js';
import { gatherFacts } from '../../src/github/gather.js';
import { reconcilePullRequest } from '../../src/github/reconcile.js';
import { isUatCheckCurrent, uatCheckRun } from '../../src/github/uat-check.js';
import type { UatGate } from '../../src/uat.js';
import { UAT_CHECK_NAME } from '../../src/uat.js';
import { HEAD_SHA, makeVerdictBody } from '../fixtures.js';
import { FakeGitHubClient, makePullRequestData, makeReviewData } from './fake-client.js';

// The UAT gate at the edge: gathering override appliers, and posting the check-run.

const GATE = { uatGate: true };

function makeLabelEvent(overrides: Partial<LabelEventData> = {}): LabelEventData {
  return {
    label: 'UAT passed',
    login: 'maintainer',
    type: 'User',
    createdAt: '2026-09-24T10:00:00Z',
    ...overrides,
  };
}

/** A PR approved by a maintainer whose verdict says UAT is `uat`. */
function makeApprovedClient(uat: string, labels: string[] = []): FakeGitHubClient {
  const client = new FakeGitHubClient(makePullRequestData({ labels }), [
    makeReviewData({ body: makeVerdictBody('approved', HEAD_SHA, { uat }) }),
  ]);
  client.permissions.set('maintainer', { permission: 'write', roleName: 'write' });
  return client;
}

function postedChecks(client: FakeGitHubClient): CheckRunWrite[] {
  return client.writes
    .filter((call) => call.method === 'createCheckRun')
    .map((call) => call.args[0] as CheckRunWrite);
}

describe('gatherFacts — UAT overrides', () => {
  it('reads nothing for the gate when --uat-gate is off', async () => {
    const client = makeApprovedClient('required', ['UAT passed']);
    await gatherFacts(client, 7, {});

    const methods = client.calls.map((call) => call.method);
    expect([methods.includes('listLabelEvents'), methods.includes('listCheckRuns')]).toEqual([
      false,
      false,
    ]);
  });

  it('skips the events read when no override label is on the PR', async () => {
    const client = makeApprovedClient('required', ['UAT ready']);
    await gatherFacts(client, 7, GATE);

    expect(client.calls.some((call) => call.method === 'listLabelEvents')).toBe(false);
  });

  it('records who applied an override, with their permission', async () => {
    const client = makeApprovedClient('required', ['UAT passed']);
    client.labelEvents = [makeLabelEvent()];
    const { facts } = await gatherFacts(client, 7, GATE);

    expect(facts.uatOverrides).toEqual([
      {
        label: 'UAT passed',
        appliedBy: { login: 'maintainer', type: 'User', permission: 'write' },
      },
    ]);
  });

  it('takes the latest labeling: a bot re-applying the label replaces the person', async () => {
    const client = makeApprovedClient('required', ['UAT passed']);
    client.labelEvents = [
      makeLabelEvent({ createdAt: '2026-09-24T10:00:00Z' }),
      makeLabelEvent({
        login: 'github-actions[bot]',
        type: 'Bot',
        createdAt: '2026-09-24T11:00:00Z',
      }),
    ];
    const { facts } = await gatherFacts(client, 7, GATE);

    expect(facts.uatOverrides[0]?.appliedBy).toEqual({
      login: 'github-actions[bot]',
      type: 'Bot',
      permission: 'none',
    });
  });

  it('reads the old `tested` name as UAT passed', async () => {
    const client = makeApprovedClient('required', ['tested']);
    client.labelEvents = [makeLabelEvent({ label: 'tested' })];
    const { facts } = await gatherFacts(client, 7, GATE);

    expect(facts.uatOverrides[0]?.label).toBe('UAT passed');
  });

  it('leaves the applier unknown when no labeled event names one', async () => {
    const client = makeApprovedClient('required', ['no UAT needed']);
    const { facts } = await gatherFacts(client, 7, GATE);

    expect(facts.uatOverrides).toEqual([{ label: 'no UAT needed', appliedBy: undefined }]);
  });

  it('leaves the applier unknown when their account was deleted', async () => {
    const client = makeApprovedClient('required', ['UAT passed']);
    client.labelEvents = [makeLabelEvent({ login: undefined, type: 'Bot' })];
    const { facts } = await gatherFacts(client, 7, GATE);

    expect(facts.uatOverrides).toEqual([{ label: 'UAT passed', appliedBy: undefined }]);
  });

  it('does not look up a permission for a bot applier', async () => {
    const client = makeApprovedClient('required', ['UAT passed']);
    client.labelEvents = [makeLabelEvent({ login: 'some-app[bot]', type: 'Bot' })];
    await gatherFacts(client, 7, GATE);

    const looked = client.calls.filter((call) => call.method === 'getCollaboratorPermission');
    expect(looked.map((call) => call.args[0])).toEqual(['maintainer']);
  });
});

describe('reconcilePullRequest — the uat check-run', () => {
  it('posts a hold while the verdict requires UAT', async () => {
    const client = makeApprovedClient('required');
    await reconcilePullRequest(client, 7, GATE);

    expect(postedChecks(client)).toEqual([
      expect.objectContaining({
        name: UAT_CHECK_NAME,
        headSha: HEAD_SHA,
        status: 'in_progress',
        conclusion: undefined,
        title: 'Waiting for UAT',
      }),
    ]);
  });

  it('posts success for a UAT-exempt verdict', async () => {
    const client = makeApprovedClient('exempt');
    await reconcilePullRequest(client, 7, GATE);

    expect(postedChecks(client)).toEqual([
      expect.objectContaining({ status: 'completed', conclusion: 'success' }),
    ]);
  });

  it('does not re-post an unchanged result', async () => {
    const client = makeApprovedClient('required');
    await reconcilePullRequest(client, 7, GATE);
    await reconcilePullRequest(client, 7, GATE);

    expect(postedChecks(client)).toHaveLength(1);
  });

  it('re-posts when a person passes UAT', async () => {
    const client = makeApprovedClient('required');
    await reconcilePullRequest(client, 7, GATE);
    client.pull.labels = ['UAT passed'];
    client.labelEvents = [makeLabelEvent()];
    await reconcilePullRequest(client, 7, GATE);

    expect(postedChecks(client).map((run) => run.title)).toEqual(['Waiting for UAT', 'UAT passed']);
  });

  it('posts the result before arming', async () => {
    const client = makeApprovedClient('exempt');
    await reconcilePullRequest(client, 7, { ...GATE, armAutoMerge: true });

    const order = client.writes
      .map((call) => call.method)
      .filter((method) => method === 'createCheckRun' || method === 'enableAutoMerge');
    expect(order).toEqual(['createCheckRun', 'enableAutoMerge']);
  });

  it('posts nothing in a dry run', async () => {
    const client = makeApprovedClient('required');
    await reconcilePullRequest(client, 7, GATE, { dryRun: true });

    expect(postedChecks(client)).toEqual([]);
  });

  it('posts nothing for a closed PR', async () => {
    const client = makeApprovedClient('required');
    client.pull.state = 'closed';
    await reconcilePullRequest(client, 7, GATE);

    expect(postedChecks(client)).toEqual([]);
  });
});

describe('uatCheckRun text', () => {
  it.each([
    ['verdict-exempt', true, undefined, 'UAT not required'],
    ['bot-eligible', true, undefined, 'UAT not required'],
    ['override', true, 'UAT passed', 'UAT passed'],
    ['override', true, 'no UAT needed', 'UAT waived'],
    ['verdict-required', false, undefined, 'Waiting for UAT'],
    ['verdict-unspecified', false, undefined, 'Waiting for UAT'],
    ['no-verdict', false, undefined, 'Waiting for review'],
  ] as const)('titles %s (%s, %s) as "%s"', (reason, passes, override, title) => {
    const gate: UatGate = { passes, required: reason !== 'verdict-exempt', reason, override };

    expect(uatCheckRun(gate, HEAD_SHA).title).toBe(title);
  });

  it('tells a person how to pass a held gate', () => {
    const gate: UatGate = {
      passes: false,
      required: true,
      reason: 'verdict-required',
      override: undefined,
    };

    expect(uatCheckRun(gate, HEAD_SHA).summary).toContain('`UAT passed`');
  });
});

describe('isUatCheckCurrent', () => {
  const hold = uatCheckRun(
    { passes: false, required: true, reason: 'no-verdict', override: undefined },
    HEAD_SHA,
  );
  const holdRun = {
    name: UAT_CHECK_NAME,
    status: 'in_progress',
    conclusion: null,
    completedAt: null,
    title: 'Waiting for review',
  };

  it('is current when every uat run matches', () => {
    expect(isUatCheckCurrent([holdRun], hold)).toBe(true);
  });

  it('is not current with no run yet', () => {
    expect(isUatCheckCurrent([], hold)).toBe(false);
  });

  it("is not current when another app's run disagrees", () => {
    const spoof = { ...holdRun, status: 'completed', conclusion: 'success', title: 'ok' };

    expect(isUatCheckCurrent([holdRun, spoof], hold)).toBe(false);
  });
});
