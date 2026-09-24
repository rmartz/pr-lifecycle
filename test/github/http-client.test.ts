import { describe, expect, it } from 'vitest';

import { GitHubApiError } from '../../src/github/client.js';
import { createHttpClient } from '../../src/github/http-client.js';

/**
 * A fake transport: records each request and answers from a queue, so tests
 * assert the exact request mapping without touching the network or the global
 * fetch.
 */
interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

function makeTransport(responses: { status?: number; json?: unknown; text?: string }[]) {
  const requests: RecordedRequest[] = [];
  const queue = [...responses];
  const fakeFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const bodyText = typeof init?.body === 'string' ? init.body : undefined;
    requests.push({
      url: urlOf(input),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: bodyText === undefined ? undefined : JSON.parse(bodyText),
    });
    const next = queue.shift() ?? { status: 204 };
    const status = next.status ?? 200;
    const payload = next.text ?? (next.json === undefined ? null : JSON.stringify(next.json));
    return Promise.resolve(new Response(status === 204 ? null : payload, { status }));
  };
  const client = createHttpClient({
    token: 't0k',
    owner: 'rmartz',
    repo: 'demo',
    fetch: fakeFetch,
  });
  return { client, requests };
}

const REST_PULL = {
  node_id: 'PR_kw',
  state: 'open',
  merged: false,
  draft: true,
  title: 'feat: x',
  user: { login: 'dependabot[bot]' },
  head: { sha: 'abc', ref: 'dependabot/x', repo: { id: 11 } },
  base: { repo: { id: 11 } },
  labels: [{ name: 'approved' }],
  auto_merge: { merge_method: 'squash' },
};

function makeRestReview(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user: { login: 'maintainer', type: 'User' },
    commit_id: 'abc',
    state: 'APPROVED',
    body: 'ok',
    submitted_at: '2026-09-23T12:00:00Z',
    ...overrides,
  };
}

describe('createHttpClient requests', () => {
  it('authenticates and pins the API version', async () => {
    const { client, requests } = makeTransport([{ json: REST_PULL }]);

    await client.getPullRequest(7);

    expect(requests[0]?.headers).toMatchObject({
      Authorization: 'Bearer t0k',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('honors a custom API URL', async () => {
    const requests: string[] = [];
    const client = createHttpClient({
      token: 't',
      owner: 'o',
      repo: 'r',
      apiUrl: 'https://ghe.example.com/api/v3/',
      fetch: (input) => {
        requests.push(urlOf(input));
        return Promise.resolve(new Response(JSON.stringify(REST_PULL), { status: 200 }));
      },
    });

    await client.getPullRequest(1);

    expect(requests[0]).toBe('https://ghe.example.com/api/v3/repos/o/r/pulls/1');
  });

  it('maps a pull request', async () => {
    const { client } = makeTransport([{ json: REST_PULL }]);

    expect(await client.getPullRequest(7)).toEqual({
      nodeId: 'PR_kw',
      state: 'open',
      merged: false,
      draft: true,
      title: 'feat: x',
      headSha: 'abc',
      labels: ['approved'],
      autoMergeEnabled: true,
      authorLogin: 'dependabot[bot]',
      headRef: 'dependabot/x',
      isCrossRepository: false,
    });
  });

  it('detects a fork by repo id', async () => {
    const fork = { ...REST_PULL, head: { ...REST_PULL.head, repo: { id: 99 } } };
    const { client } = makeTransport([{ json: fork }]);

    expect((await client.getPullRequest(7)).isCrossRepository).toBe(true);
  });

  it('treats a deleted head repo as a fork', async () => {
    const orphan = { ...REST_PULL, head: { ...REST_PULL.head, repo: null } };
    const { client } = makeTransport([{ json: orphan }]);

    expect((await client.getPullRequest(7)).isCrossRepository).toBe(true);
  });

  it.each([
    [true, true],
    [false, false],
    [null, undefined],
  ])('maps mergeable %j to %j', async (mergeable, expected) => {
    const { client } = makeTransport([{ json: { ...REST_PULL, mergeable } }]);

    expect((await client.getPullRequest(7)).mergeable).toBe(expected);
  });

  it('maps a deleted PR author to undefined', async () => {
    const { client } = makeTransport([{ json: { ...REST_PULL, user: null } }]);

    expect((await client.getPullRequest(7)).authorLogin).toBeUndefined();
  });

  it('lists commits with their author logins', async () => {
    const { client, requests } = makeTransport([
      {
        json: [
          { author: { login: 'dependabot[bot]' }, commit: { message: 'bump' } },
          { author: null, commit: { message: 'unlinked' } },
        ],
      },
    ]);

    const commits = await client.listCommits(7);

    expect([commits, requests[0]?.url]).toEqual([
      [
        { authorLogin: 'dependabot[bot]', message: 'bump' },
        { authorLogin: undefined, message: 'unlinked' },
      ],
      'https://api.github.com/repos/rmartz/demo/pulls/7/commits?per_page=100&page=1',
    ]);
  });

  it('reads a null auto_merge as disarmed', async () => {
    const { client } = makeTransport([{ json: { ...REST_PULL, auto_merge: null } }]);

    expect((await client.getPullRequest(7)).autoMergeEnabled).toBe(false);
  });

  it('paginates reviews until a short page', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => makeRestReview(index));
    const { client, requests } = makeTransport([
      { json: fullPage },
      { json: [makeRestReview(100)] },
    ]);

    const reviews = await client.listReviews(7);

    expect([reviews.length, requests.map((request) => request.url)]).toEqual([
      101,
      [
        'https://api.github.com/repos/rmartz/demo/pulls/7/reviews?per_page=100&page=1',
        'https://api.github.com/repos/rmartz/demo/pulls/7/reviews?per_page=100&page=2',
      ],
    ]);
  });

  it('maps a review', async () => {
    const { client } = makeTransport([{ json: [makeRestReview(5)] }]);

    expect(await client.listReviews(7)).toEqual([
      {
        id: 5,
        login: 'maintainer',
        type: 'User',
        commitSha: 'abc',
        state: 'APPROVED',
        body: 'ok',
        submittedAt: '2026-09-23T12:00:00Z',
      },
    ]);
  });

  it('maps a deleted author, null body, and missing submission time', async () => {
    const { client } = makeTransport([
      { json: [makeRestReview(5, { user: null, body: null, submitted_at: null })] },
    ]);

    expect((await client.listReviews(7))[0]).toMatchObject({
      login: undefined,
      body: '',
      submittedAt: undefined,
    });
  });

  it('maps an unknown review state to DISMISSED so it never counts', async () => {
    const { client } = makeTransport([{ json: [makeRestReview(5, { state: 'SOMETHING_NEW' })] }]);

    expect((await client.listReviews(7))[0]?.state).toBe('DISMISSED');
  });

  it('treats a non-User actor type as a Bot', async () => {
    const { client } = makeTransport([
      { json: [makeRestReview(5, { user: { login: 'acme', type: 'Organization' } })] },
    ]);

    expect((await client.listReviews(7))[0]?.type).toBe('Bot');
  });

  it('reads the collaborator permission and role', async () => {
    const { client, requests } = makeTransport([
      { json: { permission: 'write', role_name: 'maintain' } },
    ]);

    const result = await client.getCollaboratorPermission('some user');

    expect([result, requests[0]?.url]).toEqual([
      { permission: 'write', roleName: 'maintain' },
      'https://api.github.com/repos/rmartz/demo/collaborators/some%20user/permission',
    ]);
  });

  it('lists repo label names', async () => {
    const { client } = makeTransport([{ json: [{ name: 'approved' }, { name: 'DevOps' }] }]);

    expect(await client.listRepoLabels()).toEqual(['approved', 'DevOps']);
  });

  it('creates a label', async () => {
    const { client, requests } = makeTransport([{ status: 201, json: {} }]);
    const label = { name: 'approved', color: '2DA44E', description: 'ok' };

    await client.createLabel(label);

    expect([requests[0]?.method, requests[0]?.body]).toEqual(['POST', label]);
  });

  it('adds labels to the PR', async () => {
    const { client, requests } = makeTransport([{ json: [] }]);

    await client.addLabels(7, ['approved']);

    expect([requests[0]?.url, requests[0]?.body]).toEqual([
      'https://api.github.com/repos/rmartz/demo/issues/7/labels',
      { labels: ['approved'] },
    ]);
  });

  it('removes a label with its name URL-encoded', async () => {
    const { client, requests } = makeTransport([{ json: [] }]);

    await client.removeLabel(7, 'review requested');

    expect([requests[0]?.method, requests[0]?.url]).toEqual([
      'DELETE',
      'https://api.github.com/repos/rmartz/demo/issues/7/labels/review%20requested',
    ]);
  });

  it.each([
    ['enableAutoMerge', 'enablePullRequestAutoMerge'],
    ['disableAutoMerge', 'disablePullRequestAutoMerge'],
  ] as const)('%s sends the %s mutation for the node', async (method, mutation) => {
    const { client, requests } = makeTransport([{ json: { data: {} } }]);

    await client[method]('PR_kw');

    const body = requests[0]?.body as { query: string; variables: unknown };
    expect([body.query.includes(mutation), body.variables]).toEqual([true, { id: 'PR_kw' }]);
  });

  it('arms with the squash merge method', async () => {
    const { client, requests } = makeTransport([{ json: { data: {} } }]);

    await client.enableAutoMerge('PR_kw');

    expect((requests[0]?.body as { query: string }).query).toContain('mergeMethod: SQUASH');
  });
});

describe('createHttpClient responses', () => {
  it('accepts a 204 with no body', async () => {
    const { client } = makeTransport([{ status: 204 }]);

    await expect(client.removeLabel(7, 'approved')).resolves.toBeUndefined();
  });
});

describe('createHttpClient errors', () => {
  it('throws a GitHubApiError carrying the status', async () => {
    const { client } = makeTransport([{ status: 404, text: 'Not Found' }]);

    await expect(client.getCollaboratorPermission('nobody')).rejects.toMatchObject({
      name: 'GitHubApiError',
      status: 404,
    });
  });

  it('includes the response detail in the message', async () => {
    const { client } = makeTransport([{ status: 422, text: 'already_exists' }]);

    await expect(
      client.createLabel({ name: 'x', color: '000000', description: '' }),
    ).rejects.toThrow(/422: already_exists/);
  });

  it('throws on GraphQL errors returned with a 200', async () => {
    const { client } = makeTransport([
      { json: { errors: [{ message: 'Pull request is in clean status' }] } },
    ]);

    await expect(client.enableAutoMerge('PR_kw')).rejects.toBeInstanceOf(GitHubApiError);
  });
});
