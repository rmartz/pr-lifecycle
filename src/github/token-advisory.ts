import type { GitHubClient } from './client.js';

/**
 * The advisory comment posted when a PR is ready to arm or merge, or to be
 * labeled `no UAT needed`, but no release token is configured (modelled on
 * storybook-ci's missing-PAT advisory). It is the
 * one signal a human will actually see — a warning in the job log goes unread —
 * and it is posted at most once per PR, found again by its marker.
 */

export const TOKEN_ADVISORY_MARKER = '<!-- pr-lifecycle:token-missing -->';

export const RELEASE_TOKEN_DOCS_URL =
  'https://github.com/rmartz/pr-lifecycle/blob/main/docs/cli.md#release-token';

/** What a missing release token made the run skip: an arm, a merge, or a UAT waiver. */
export type SkippedForToken = 'arm' | 'merge' | 'uat-waiver';

function skippedParagraphs(skipped: SkippedForToken): [string, string, string] {
  const noToken =
    "no release token is configured (the action's `token` input, or `PR_LIFECYCLE_TOKEN` for the CLI)";
  switch (skipped) {
    case 'arm':
    case 'merge': {
      const action = skipped === 'merge' ? 'merged' : 'armed for auto-merge';
      return [
        '## PR lifecycle: auto-merge skipped',
        `This PR is approved and would have been **${action}**, but ${noToken}.`,
        "A merge made with `GITHUB_TOKEN` doesn't trigger `on: push` workflows such as releases, so the lifecycle doesn't fall back to it. Labels are still kept up to date; merge this PR by hand, or add the token and re-run.",
      ];
    }
    case 'uat-waiver':
      return [
        '## PR lifecycle: `no UAT needed` skipped',
        `This PR can't be user-facing and would have been labeled **\`no UAT needed\`**, but ${noToken}.`,
        "pr-policy only accepts a UAT sign-off a person applied, so a label applied with `GITHUB_TOKEN` couldn't pass its gate. Other labels are still kept up to date; apply `no UAT needed` by hand, or add the token and re-run.",
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
