import { describe, expect, it } from 'vitest';

import { GitHubApiError } from '../../src/github/client.js';
import { HEAD_SHA } from '../fixtures.js';
import { makeTransport } from './http-fake.js';

const EVENTS_URL = 'https://api.github.com/repos/rmartz/demo/issues/7/events?per_page=100&page=1';

describe('listLabelApplications', () => {
  it('maps only the applications of the label, oldest first', async () => {
    const { client, requests } = makeTransport([
      {
        json: [
          {
            event: 'labeled',
            created_at: '2026-10-19T09:00:00Z',
            actor: { login: 'rmartz', type: 'User' },
            label: { name: 'no UAT needed' },
          },
          {
            event: 'labeled',
            created_at: '2026-10-19T09:30:00Z',
            actor: { login: 'rmartz', type: 'User' },
            label: { name: 'approved' },
          },
          {
            event: 'unlabeled',
            created_at: '2026-10-19T10:00:00Z',
            actor: { login: 'rmartz', type: 'User' },
            label: { name: 'no UAT needed' },
          },
          {
            event: 'labeled',
            created_at: '2026-10-19T11:00:00Z',
            actor: { login: 'pr-lifecycle[bot]', type: 'Bot' },
            label: { name: 'no UAT needed' },
          },
        ],
      },
    ]);

    const applications = await client.listLabelApplications(7, 'no UAT needed');

    expect([requests[0]?.url, applications]).toEqual([
      EVENTS_URL,
      [
        { login: 'rmartz', type: 'User', appliedAt: '2026-10-19T09:00:00Z' },
        { login: 'pr-lifecycle[bot]', type: 'Bot', appliedAt: '2026-10-19T11:00:00Z' },
      ],
    ]);
  });

  it('reads a deleted account as an untrusted bot', async () => {
    const { client } = makeTransport([
      {
        json: [
          {
            event: 'labeled',
            created_at: '2026-10-19T09:00:00Z',
            actor: null,
            label: { name: 'UAT passed' },
          },
        ],
      },
    ]);

    expect(await client.listLabelApplications(7, 'UAT passed')).toEqual([
      { login: undefined, type: 'Bot', appliedAt: '2026-10-19T09:00:00Z' },
    ]);
  });
});

describe('listTitleChanges', () => {
  it('maps the renamed events to their times', async () => {
    const { client } = makeTransport([
      {
        json: [
          { event: 'renamed', created_at: '2026-10-19T09:00:00Z' },
          { event: 'labeled', created_at: '2026-10-19T09:30:00Z', label: { name: 'x' } },
        ],
      },
    ]);

    expect(await client.listTitleChanges(7)).toEqual(['2026-10-19T09:00:00Z']);
  });
});

describe('listCheckSuites', () => {
  it('maps each suite’s branch and creation time across pages', async () => {
    const full = Array.from({ length: 100 }, () => ({
      head_branch: 'feature/thing',
      created_at: '2026-10-19T10:00:00Z',
    }));
    const { client, requests } = makeTransport([
      { json: { check_suites: full } },
      { json: { check_suites: [{ head_branch: null, created_at: '2026-10-19T11:00:00Z' }] } },
    ]);

    const suites = await client.listCheckSuites(HEAD_SHA);

    expect([requests.map((request) => request.url), suites.length, suites.at(-1)]).toEqual([
      [
        `https://api.github.com/repos/rmartz/demo/commits/${HEAD_SHA}/check-suites?per_page=100&page=1`,
        `https://api.github.com/repos/rmartz/demo/commits/${HEAD_SHA}/check-suites?per_page=100&page=2`,
      ],
      101,
      { headBranch: undefined, createdAt: '2026-10-19T11:00:00Z' },
    ]);
  });
});

describe('getFileText', () => {
  it('decodes the file at the ref', async () => {
    const content = Buffer.from('{"name":"demo"}').toString('base64');
    const { client, requests } = makeTransport([{ json: { encoding: 'base64', content } }]);

    const text = await client.getFileText('packages/a b/package.json', HEAD_SHA);

    expect([requests[0]?.url, text]).toEqual([
      `https://api.github.com/repos/rmartz/demo/contents/packages/a%20b/package.json?ref=${HEAD_SHA}`,
      '{"name":"demo"}',
    ]);
  });

  it('reads a missing file as absent', async () => {
    const { client } = makeTransport([{ status: 404, text: 'Not Found' }]);

    expect(await client.getFileText('package.json', HEAD_SHA)).toBeUndefined();
  });

  it('reads a file too large to inline as unknown', async () => {
    const { client } = makeTransport([{ json: { encoding: 'none', content: '' } }]);

    expect(await client.getFileText('package.json', HEAD_SHA)).toBeUndefined();
  });

  it('propagates any other failure', async () => {
    const { client } = makeTransport([{ status: 403, text: 'forbidden' }]);

    await expect(client.getFileText('package.json', HEAD_SHA)).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });
});

describe('listPullRequestFiles — renames', () => {
  it('maps a renamed file’s old path', async () => {
    const { client } = makeTransport([
      {
        json: [
          { filename: 'docs/a.md', status: 'renamed', previous_filename: 'src/a.ts' },
          { filename: 'b.ts', status: 'modified', patch: '@@' },
        ],
      },
    ]);

    expect(await client.listPullRequestFiles(7)).toEqual([
      { filename: 'docs/a.md', status: 'renamed', patch: undefined, previousFilename: 'src/a.ts' },
      { filename: 'b.ts', status: 'modified', patch: '@@' },
    ]);
  });
});
