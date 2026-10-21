import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli.js';
import { gatherFacts } from '../../src/github/gather.js';
import { reconcilePullRequest } from '../../src/github/reconcile.js';
import { MAX_WORKFLOW_READS } from '../../src/github/sign-off-facts.js';
import { buildTokenAdvisoryBody } from '../../src/github/token-advisory.js';
import { BASE_WORKFLOW } from '../ci-change/fixtures/workflow.js';
import { makeDeps, makeIo, makeSourceClient, RECONCILE } from '../cli-fixtures.js';
import { HEAD_SHA, makeChangedFile } from '../fixtures.js';
import { FakeGitHubClient, makePullRequestData } from './fake-client.js';
import { makeTransport } from './http-fake.js';

// The pr-lifecycle/sign-off status at the edge: the facts behind it, posting it
// with the real actor, not reposting an unchanged one, and failing closed.

const ON = { uat: 'on' } as const;
const NO_RELEASE_TOKEN = { GITHUB_TOKEN: 't0k' };
const CONTEXT = 'pr-lifecycle/sign-off';
const WORKFLOW = '.github/workflows/ci.yml';
const MERGE_BASE = 'e'.repeat(40);

function makeWorkflowClient(title: string, files = [makeChangedFile({ filename: WORKFLOW })]) {
  const client = new FakeGitHubClient(
    makePullRequestData({ title, changedFileCount: files.length }),
  );
  client.files = files;
  client.comparisons.set(`main...${HEAD_SHA}`, { status: 'ahead', mergeBaseSha: MERGE_BASE });
  client.fileTexts.set(`${MERGE_BASE}:${WORKFLOW}`, BASE_WORKFLOW);
  client.fileTexts.set(`${HEAD_SHA}:${WORKFLOW}`, `${BASE_WORKFLOW}# a comment\n`);
  return client;
}

function postedStatuses(client: FakeGitHubClient) {
  return client.calls.filter((call) => call.method === 'createCommitStatus').map((c) => c.args);
}

describe('gatherFacts — workflow changes', () => {
  it('reads a changed workflow at the merge base and the head', async () => {
    const { facts } = await gatherFacts(makeWorkflowClient('ci: comment'), 7, ON);

    expect(facts.workflowChanges).toEqual([
      { path: WORKFLOW, baseText: BASE_WORKFLOW, headText: `${BASE_WORKFLOW}# a comment\n` },
    ]);
  });

  it('reads no base text for an added workflow, and no head text for a removed one', async () => {
    const client = makeWorkflowClient('ci: a', [
      makeChangedFile({ filename: '.github/workflows/new.yml', status: 'added' }),
      makeChangedFile({ filename: WORKFLOW, status: 'removed' }),
    ]);

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.workflowChanges).toEqual([
      { path: '.github/workflows/new.yml', baseText: undefined, headText: undefined },
      { path: WORKFLOW, baseText: BASE_WORKFLOW, headText: undefined },
    ]);
  });

  it('reads a rename within the workflows as a change of that workflow', async () => {
    const renamed = '.github/workflows/build.yml';
    const client = makeWorkflowClient('ci: rename', [
      makeChangedFile({ filename: renamed, status: 'renamed', previousFilename: WORKFLOW }),
    ]);
    client.fileTexts.set(`${HEAD_SHA}:${renamed}`, BASE_WORKFLOW);

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.workflowChanges).toEqual([
      { path: renamed, baseText: BASE_WORKFLOW, headText: BASE_WORKFLOW },
      { path: WORKFLOW, baseText: undefined, headText: undefined },
    ]);
  });

  it('reads a workflow moved out of the workflows as removed', async () => {
    const client = makeWorkflowClient('ci: move', [
      makeChangedFile({ filename: 'old/ci.yml', status: 'renamed', previousFilename: WORKFLOW }),
    ]);

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.workflowChanges).toEqual([
      { path: WORKFLOW, baseText: BASE_WORKFLOW, headText: undefined },
    ]);
  });

  it('reads no workflow over the cap, so each counts as a loosening', async () => {
    const files = Array.from({ length: MAX_WORKFLOW_READS + 1 }, (_, i) =>
      makeChangedFile({ filename: `.github/workflows/w${i}.yml` }),
    );

    const { plan } = await reconcilePullRequest(makeWorkflowClient('ci: many', files), 7, ON, {
      dryRun: true,
    });

    expect([plan.signOff?.requirement, plan.signOff?.loosening]).toEqual(['ci', true]);
  });

  it('reads the latest sign-off status on the head', async () => {
    const client = makeSourceClient();
    client.statuses.set(HEAD_SHA, [
      { context: 'other', state: 'failure', description: 'x', creatorType: 'Bot' },
      {
        context: CONTEXT,
        state: 'success',
        description: 'v1 requirement=none',
        creatorType: 'User',
      },
      {
        context: CONTEXT,
        state: 'success',
        description: 'v1 requirement=uat',
        creatorType: 'User',
      },
    ]);

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.signOffStatus).toEqual({
      state: 'success',
      description: 'v1 requirement=none',
      creatorType: 'User',
    });
  });

  it('reads no status without a UAT setting', async () => {
    const client = makeSourceClient();

    await gatherFacts(client, 7);

    expect(client.calls.some((call) => call.method === 'listStatuses')).toBe(false);
  });
});

describe('reconcilePullRequest — the sign-off status', () => {
  it('posts the status on the head with the release token', async () => {
    const client = makeSourceClient();
    const release = new FakeGitHubClient();

    await reconcilePullRequest(client, 7, ON, { release });

    expect([postedStatuses(release), postedStatuses(client)]).toEqual([
      [
        [
          HEAD_SHA,
          { state: 'success', context: CONTEXT, description: 'v1 requirement=uat waiver=absent' },
        ],
      ],
      [],
    ]);
  });

  it('posts a ci PR loosening a workflow as requirement=ci loosening=yes', async () => {
    const client = makeWorkflowClient('ci: let it fail');
    client.fileTexts.set(
      `${HEAD_SHA}:${WORKFLOW}`,
      BASE_WORKFLOW.replace(
        '    runs-on: ubuntu-latest',
        '    runs-on: ubuntu-latest\n    continue-on-error: true',
      ),
    );

    await reconcilePullRequest(client, 7, ON);

    expect(postedStatuses(client)[0]?.[1]).toMatchObject({
      description: 'v1 requirement=ci loosening=yes',
    });
  });

  it('does not repost an unchanged status', async () => {
    const client = makeSourceClient();
    await reconcilePullRequest(client, 7, ON);

    await reconcilePullRequest(client, 7, ON);

    expect(postedStatuses(client)).toHaveLength(1);
  });

  it('reposts a status a bot created', async () => {
    const client = makeSourceClient();
    client.statuses.set(HEAD_SHA, [
      {
        context: CONTEXT,
        state: 'success',
        description: 'v1 requirement=uat waiver=absent',
        creatorType: 'Bot',
      },
    ]);

    await reconcilePullRequest(client, 7, ON);

    expect(postedStatuses(client)).toHaveLength(1);
  });

  it('posts nothing without a release token, and reports the skip', async () => {
    const client = makeSourceClient();

    const result = await reconcilePullRequest(client, 7, ON, { release: 'unavailable' });

    expect([postedStatuses(client), result.skippedSignOffStatus]).toEqual([[], true]);
  });

  it('posts nothing on a dry run', async () => {
    const client = makeSourceClient();

    const { plan } = await reconcilePullRequest(client, 7, ON, { dryRun: true });

    expect([postedStatuses(client), plan.signOffStatus?.post]).toEqual([[], true]);
  });

  it('posts nothing on a closed PR', async () => {
    const client = makeSourceClient(makePullRequestData({ state: 'closed' }));

    await reconcilePullRequest(client, 7, ON);

    expect(postedStatuses(client)).toEqual([]);
  });

  it('gives a ci PR no UAT label', async () => {
    const client = makeSourceClient(makePullRequestData({ title: 'ci: add a lint script' }));

    await reconcilePullRequest(client, 7, ON);

    expect(client.pull.labels).toEqual(['review requested']);
  });
});

describe('runCli — the sign-off status', () => {
  it('warns and advises when the status is skipped for want of a token', async () => {
    const client = makeSourceClient();
    const { err, io } = makeIo();

    await runCli(RECONCILE, io, makeDeps(client, NO_RELEASE_TOKEN).deps);

    expect([err, client.comments]).toEqual([
      [
        'warning: rmartz/demo#7: the sign-off status was not posted, so pr-policy holds the PR: PR_LIFECYCLE_TOKEN is not set',
      ],
      [buildTokenAdvisoryBody('sign-off-status')],
    ]);
  });

  it('reports the skip in --json', async () => {
    const { out, io } = makeIo();

    await runCli([...RECONCILE, '--json'], io, makeDeps(makeSourceClient(), NO_RELEASE_TOKEN).deps);

    const json = JSON.parse(out[0] ?? '{}') as Record<string, unknown>;
    expect([json['signOff'], json['signOffStatusSkipped']]).toEqual([
      {
        requirement: 'uat',
        reason: 'needs-uat',
        loosening: false,
        status: 'v1 requirement=uat waiver=absent',
        statusPosted: false,
      },
      { reason: 'token-missing' },
    ]);
  });

  it('reports no uat field for a ci PR', async () => {
    const client = makeSourceClient(makePullRequestData({ title: 'ci: add a lint script' }));
    const { out, io } = makeIo();

    await runCli([...RECONCILE, '--json'], io, makeDeps(client).deps);

    const json = JSON.parse(out[0] ?? '{}') as Record<string, unknown>;
    expect([json['uat'], (json['signOff'] as { requirement: string }).requirement]).toEqual([
      null,
      'ci',
    ]);
  });
});

describe('http client — statuses', () => {
  it('lists statuses with their description and creator', async () => {
    const { client, requests } = makeTransport([
      {
        json: [
          {
            context: CONTEXT,
            state: 'success',
            description: 'v1 requirement=none',
            creator: { login: 'rmartz', type: 'User' },
          },
          { context: 'x', state: 'pending', description: null, creator: null },
        ],
      },
    ]);

    const statuses = await client.listStatuses(HEAD_SHA);

    expect([requests[0]?.url, statuses]).toEqual([
      `https://api.github.com/repos/rmartz/demo/commits/${HEAD_SHA}/statuses?per_page=100&page=1`,
      [
        {
          context: CONTEXT,
          state: 'success',
          description: 'v1 requirement=none',
          creatorType: 'User',
        },
        { context: 'x', state: 'pending', description: '', creatorType: 'Bot' },
      ],
    ]);
  });

  it('creates a status on the commit', async () => {
    const { client, requests } = makeTransport([{ json: {} }]);
    const status = {
      state: 'success',
      context: CONTEXT,
      description: 'v1 requirement=none',
    } as const;

    await client.createCommitStatus(HEAD_SHA, status);

    expect([requests[0]?.method, requests[0]?.url, requests[0]?.body]).toEqual([
      'POST',
      `https://api.github.com/repos/rmartz/demo/statuses/${HEAD_SHA}`,
      status,
    ]);
  });
});
