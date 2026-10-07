import { createHttpClient } from '../../src/github/http-client.js';

/**
 * A fake transport for the real HTTP client: records each request and answers
 * from a queue, so tests assert the exact request mapping without touching the
 * network or the global fetch.
 */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

export function makeTransport(responses: { status?: number; json?: unknown; text?: string }[]) {
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
