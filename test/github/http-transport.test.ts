import { describe, expect, it } from 'vitest';

import { createTransport } from '../../src/github/http-transport.js';

/**
 * Transient-failure classification: a rate limit, a GitHub outage, or a network
 * failure says nothing about the PR, so the error carries `transient: true` and
 * the CLI exits EXIT_TRANSIENT instead of failing (see docs/cli.md).
 */

interface FakeResponse {
  status: number;
  text?: string;
  json?: unknown;
  headers?: Record<string, string>;
}

function makeTransport(respond: FakeResponse | Error) {
  const fakeFetch = (): Promise<Response> => {
    if (respond instanceof Error) {
      return Promise.reject(respond);
    }
    const payload = respond.text ?? JSON.stringify(respond.json ?? null);
    return Promise.resolve(
      new Response(payload, {
        status: respond.status,
        ...(respond.headers === undefined ? {} : { headers: respond.headers }),
      }),
    );
  };
  return createTransport({ token: 't0k', owner: 'rmartz', repo: 'demo', fetch: fakeFetch });
}

describe('createTransport — transient REST failures', () => {
  it('marks a 429 transient', async () => {
    const transport = makeTransport({ status: 429, text: 'Too Many Requests' });

    await expect(transport.request('GET', '/x')).rejects.toMatchObject({
      status: 429,
      transient: true,
    });
  });

  it('marks a 502 transient', async () => {
    const transport = makeTransport({ status: 502, text: 'Bad Gateway' });

    await expect(transport.request('GET', '/x')).rejects.toMatchObject({
      status: 502,
      transient: true,
    });
  });

  it('marks a 403 with an exhausted primary rate limit transient', async () => {
    const transport = makeTransport({
      status: 403,
      text: 'Forbidden',
      headers: { 'x-ratelimit-remaining': '0' },
    });

    await expect(transport.request('GET', '/x')).rejects.toMatchObject({ transient: true });
  });

  it('marks a 403 secondary rate limit transient', async () => {
    const transport = makeTransport({
      status: 403,
      text: '{"message":"You have exceeded a secondary rate limit."}',
      headers: { 'x-ratelimit-remaining': '4321' },
    });

    await expect(transport.request('GET', '/x')).rejects.toMatchObject({ transient: true });
  });

  it('marks a 403 carrying retry-after transient', async () => {
    const transport = makeTransport({
      status: 403,
      text: 'Forbidden',
      headers: { 'retry-after': '60' },
    });

    await expect(transport.request('GET', '/x')).rejects.toMatchObject({ transient: true });
  });

  it('marks a network failure transient with status 0', async () => {
    const transport = makeTransport(new TypeError('fetch failed'));

    await expect(transport.request('GET', '/x')).rejects.toMatchObject({
      status: 0,
      transient: true,
      message: 'GET /x → network error: fetch failed',
    });
  });
});

describe('createTransport — non-transient REST failures', () => {
  it('keeps a plain 403 permission error non-transient', async () => {
    const transport = makeTransport({
      status: 403,
      text: '{"message":"Resource not accessible by integration"}',
      headers: { 'x-ratelimit-remaining': '4321' },
    });

    await expect(transport.request('GET', '/x')).rejects.toMatchObject({
      status: 403,
      transient: false,
    });
  });

  it('keeps a 404 non-transient', async () => {
    const transport = makeTransport({ status: 404, text: 'Not Found' });

    await expect(transport.request('GET', '/x')).rejects.toMatchObject({ transient: false });
  });

  it('keeps a 422 non-transient', async () => {
    const transport = makeTransport({ status: 422, text: 'Validation Failed' });

    await expect(transport.request('GET', '/x')).rejects.toMatchObject({ transient: false });
  });
});

describe('createTransport — GraphQL errors', () => {
  it('marks a RATE_LIMITED GraphQL error transient', async () => {
    const transport = makeTransport({
      status: 200,
      json: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
    });

    await expect(transport.graphql('query', {})).rejects.toMatchObject({
      status: 200,
      transient: true,
    });
  });

  it('keeps any other GraphQL error non-transient', async () => {
    const transport = makeTransport({
      status: 200,
      json: { errors: [{ type: 'UNPROCESSABLE', message: 'Pull request is in clean status' }] },
    });

    await expect(transport.graphql('query', {})).rejects.toMatchObject({ transient: false });
  });
});
