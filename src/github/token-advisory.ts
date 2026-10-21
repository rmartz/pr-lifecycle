import type { GitHubClient } from './client.js';

/**
 * The advisory comment posted when no release token is configured but a PR is
 * ready to arm or merge, or its sign-off status can't be posted (modelled on
 * storybook-ci's missing-PAT advisory). It is the
 * one signal a human will actually see — a warning in the job log goes unread —
 * and it is posted at most once per PR, found again by its marker.
 */

export const TOKEN_ADVISORY_MARKER = '<!-- pr-lifecycle:token-missing -->';

export const RELEASE_TOKEN_DOCS_URL =
  'https://github.com/rmartz/pr-lifecycle/blob/main/docs/cli.md#release-token';

/** What a missing release token made the run skip. */
export type SkippedForToken = 'arm' | 'merge' | 'sign-off-status';

const NO_TOKEN =
  "no release token is configured (the action's `token` input, or `PR_LIFECYCLE_TOKEN` for the CLI)";

function skippedParagraphs(skipped: SkippedForToken): [string, string, string] {
  switch (skipped) {
    case 'arm':
    case 'merge': {
      const action = skipped === 'merge' ? 'merged' : 'armed for auto-merge';
      return [
        '## PR lifecycle: auto-merge skipped',
        `This PR is approved and would have been **${action}**, but ${NO_TOKEN}.`,
        "A merge made with `GITHUB_TOKEN` doesn't trigger `on: push` workflows such as releases, so the lifecycle doesn't fall back to it. Labels are still kept up to date; merge this PR by hand, or add the token and re-run.",
      ];
    }
    case 'sign-off-status':
      return [
        '## PR lifecycle: sign-off status skipped',
        `pr-policy needs the \`pr-lifecycle/sign-off\` status to know which sign-off this PR needs, but ${NO_TOKEN}.`,
        "pr-policy trusts the status only from a person, and a status created with `GITHUB_TOKEN` triggers no workflow, so the lifecycle doesn't fall back to it. Until the token is added, pr-policy holds this PR.",
      ];
  }
}

/** Pure, so it is unit-tested. */
export function buildTokenAdvisoryBody(skipped: SkippedForToken): string {
  return [
    TOKEN_ADVISORY_MARKER,
    ...skippedParagraphs(skipped),
    `To fix it, store a fine-grained PAT with **Contents** and **Pull requests** read/write on this repository as the \`PR_LIFECYCLE_TOKEN\` Actions secret, **and** as a Dependabot secret of the same name if bot PRs are auto-merged (Dependabot-triggered runs only see Dependabot secrets). See ${RELEASE_TOKEN_DOCS_URL}.`,
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
  skipped: SkippedForToken,
): Promise<boolean> {
  const comments = await client.listIssueComments(pr);
  if (comments.some((body) => body.includes(TOKEN_ADVISORY_MARKER))) {
    return false;
  }
  await client.createIssueComment(pr, buildTokenAdvisoryBody(skipped));
  return true;
}
