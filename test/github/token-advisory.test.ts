import { describe, expect, it } from 'vitest';

import {
  buildTokenAdvisoryBody,
  postTokenAdvisory,
  RELEASE_TOKEN_DOCS_URL,
  TOKEN_ADVISORY_MARKER,
} from '../../src/github/token-advisory.js';
import { FakeGitHubClient } from './fake-client.js';

describe('buildTokenAdvisoryBody', () => {
  it('starts with the marker, so the comment is found again', () => {
    expect(buildTokenAdvisoryBody('arm').startsWith(TOKEN_ADVISORY_MARKER)).toBe(true);
  });

  it.each([
    ['arm', 'armed for auto-merge'],
    ['merge', 'merged'],
  ] as const)('says what a skipped %s would have done', (skipped, phrase) => {
    expect(buildTokenAdvisoryBody(skipped)).toContain(`would have been **${phrase}**`);
  });

  it('links the release-token docs', () => {
    expect(buildTokenAdvisoryBody('arm')).toContain(RELEASE_TOKEN_DOCS_URL);
  });

  // Dependabot-triggered runs see only Dependabot secrets — the easy-to-miss half.
  it('names both secret stores', () => {
    expect(buildTokenAdvisoryBody('arm')).toMatch(/Actions secret.*Dependabot secret/s);
  });
});

describe('postTokenAdvisory', () => {
  it('posts the advisory on a PR without one', async () => {
    const client = new FakeGitHubClient();

    const posted = await postTokenAdvisory(client, 7, 'arm');

    expect([posted, client.comments]).toEqual([true, [buildTokenAdvisoryBody('arm')]]);
  });

  it('posts at most once per PR', async () => {
    const client = new FakeGitHubClient();
    client.comments = ['unrelated', `${TOKEN_ADVISORY_MARKER}\nolder advisory`];

    const posted = await postTokenAdvisory(client, 7, 'merge');

    expect([posted, client.comments.length]).toEqual([false, 2]);
  });
});
