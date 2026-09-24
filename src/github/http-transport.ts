import { GitHubApiError } from './client.js';

/**
 * The HTTP transport under the real GitHubClient: authenticated REST requests,
 * pagination, and GraphQL, each throwing GitHubApiError on failure. Split out of
 * http-client.ts so the client modules only map requests and responses.
 */

export interface HttpClientOptions {
  token: string;
  owner: string;
  repo: string;
  /** Defaults to GitHub.com; pass GITHUB_API_URL for GHES. */
  apiUrl?: string;
  fetch?: typeof fetch;
}

export const PAGE_SIZE = 100;

interface GraphQlResponse {
  errors?: { message: string }[];
}

export interface HttpTransport {
  /** `/repos/{owner}/{repo}`, URL-encoded, for building REST paths. */
  repoPath: string;
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  /** Every page of a list endpoint that returns a bare array. */
  paginate: <T>(path: string) => Promise<T[]>;
  graphql: (query: string, variables: Record<string, string>) => Promise<void>;
}

export function createTransport(options: HttpClientOptions): HttpTransport {
  let apiUrl = options.apiUrl ?? 'https://api.github.com';
  while (apiUrl.endsWith('/')) {
    apiUrl = apiUrl.slice(0, -1);
  }
  const doFetch = options.fetch ?? fetch;
  const repoPath = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await doFetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'rmartz-pr-lifecycle',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new GitHubApiError(
        response.status,
        `${method} ${path} → ${response.status}: ${detail}`,
      );
    }
    return response.status === 204 ? undefined : response.json();
  }

  async function paginate<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page += 1) {
      const batch = (await request('GET', `${path}?per_page=${PAGE_SIZE}&page=${page}`)) as T[];
      items.push(...batch);
      if (batch.length < PAGE_SIZE) {
        return items;
      }
    }
  }

  async function graphql(query: string, variables: Record<string, string>): Promise<void> {
    const result = (await request('POST', '/graphql', { query, variables })) as GraphQlResponse;
    if (result.errors !== undefined && result.errors.length > 0) {
      const messages = result.errors.map((error) => error.message).join('; ');
      throw new GitHubApiError(200, `GraphQL error: ${messages}`);
    }
  }

  return { repoPath, request, paginate, graphql };
}
