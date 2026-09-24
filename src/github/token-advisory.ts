import type { GitHubClient } from './client.js';

/**
 * The advisory comment posted when a PR is ready to arm or merge but no release
 * token is configured (modelled on storybook-ci's missing-PAT advisory). It is the
 * one signal a human will actually see — a warning in the job log goes unread —
 * and it is posted at most once per PR, found again by its marker.
 */

export const TOKEN_ADVISORY_MARKER = '<!-- pr-lifecycle:release-token-missing -->';

export const RELEASE_TOKEN_DOCS_URL =
  'https://github.com/rmartz/pr-lifecycle/blob/main/docs/cli.md#release-token';

/** Pure, so it is unit-tested. */
export function buildTokenAdvisoryBody(skipped: 'arm' | 'merge'): string {
  const action = skipped === 'merge' ? 'merged' : 'armed for auto-merge';
  return [
    TOKEN_ADVISORY_MARKER,
    '## PR lifecycle: auto-merge skipped',
    `This PR is approved and would have been **${action}**, but no release token is configured (the \`release-token\` input, \`PR_LIFECYCLE_RELEASE_TOKEN\` to the CLI).`,
    "A merge made with `GITHUB_TOKEN` doesn't trigger `on: push` workflows such as releases, so the lifecycle doesn't fall back to it. Labels are still kept up to date; merge this PR by hand, or add the token and re-run.",
    `To fix it, store a fine-grained PAT with **Contents** and **Pull requests** read/write on this repository as an Actions secret, **and** as a Dependabot secret if bot PRs are auto-merged (Dependabot-triggered runs only see Dependabot secrets). See ${RELEASE_TOKEN_DOCS_URL}.`,
    '<sub>pr-lifecycle</sub>',
  ].join('\n\n');
}

/**
 * Post the advisory unless the PR already has one. Returns whether a comment was
 * posted, so callers can report it.
 */
export async function postTokenAdvisory(
  client: GitHubClient,
  pr: number,
  skipped: 'arm' | 'merge',
): Promise<boolean> {
  const comments = await client.listIssueComments(pr);
  if (comments.some((body) => body.includes(TOKEN_ADVISORY_MARKER))) {
    return false;
  }
  await client.createIssueComment(pr, buildTokenAdvisoryBody(skipped));
  return true;
}
