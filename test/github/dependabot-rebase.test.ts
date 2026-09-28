import { describe, expect, it } from 'vitest';

import {
  buildRebaseRequestBody,
  DEPENDABOT_REBASE_COMMAND,
  DEPENDABOT_REBASING_NOTICE,
  DEPENDABOT_RECREATING_NOTICE,
  isDependabotRebasing,
  isRebasePending,
  rebaseRequestMarker,
} from '../../src/github/dependabot-rebase.js';
import { HEAD_SHA, OLD_SHA } from '../fixtures.js';

describe('buildRebaseRequestBody', () => {
  it('puts the command alone on the first line, where Dependabot reads it', () => {
    expect(buildRebaseRequestBody(HEAD_SHA).split('\n')[0]).toBe(DEPENDABOT_REBASE_COMMAND);
  });

  it('records the head it was requested for', () => {
    expect(buildRebaseRequestBody(HEAD_SHA)).toContain(rebaseRequestMarker(HEAD_SHA));
  });
});

/** Dependabot's notice as it actually appears at the top of the PR body. */
function noticeBody(notice: string): string {
  return `[//]: # (dependabot-start)\n⚠️  **${notice}** ⚠️ \n\nBumps x from 1.0.0 to 1.0.1.`;
}

describe('isDependabotRebasing', () => {
  it('is rebasing while the PR body carries the rebasing notice', () => {
    expect(isDependabotRebasing(noticeBody(DEPENDABOT_REBASING_NOTICE))).toBe(true);
  });

  it('is rebasing while the PR body carries the recreating notice', () => {
    expect(isDependabotRebasing(noticeBody(DEPENDABOT_RECREATING_NOTICE))).toBe(true);
  });

  // Our marker lives in a comment, never the body, and means "asked", not "running".
  it('is not rebasing on our own request marker alone', () => {
    expect(isDependabotRebasing(buildRebaseRequestBody(HEAD_SHA))).toBe(false);
  });

  it('is not rebasing once the notice is gone', () => {
    expect(isDependabotRebasing('Bumps x from 1.0.0 to 1.0.1.')).toBe(false);
  });
});

describe('isRebasePending', () => {
  it('is pending while the PR body says Dependabot is rebasing', () => {
    const body = `Bumps x.\n\n> **Note**\n> ${DEPENDABOT_REBASING_NOTICE}`;

    expect(isRebasePending(body, [], HEAD_SHA)).toBe(true);
  });

  it('is pending while the PR body says Dependabot is recreating', () => {
    expect(isRebasePending(noticeBody(DEPENDABOT_RECREATING_NOTICE), [], HEAD_SHA)).toBe(true);
  });

  it('is pending once a rebase was requested for this head', () => {
    expect(isRebasePending('', [buildRebaseRequestBody(HEAD_SHA)], HEAD_SHA)).toBe(true);
  });

  // Dependabot replied with an error instead of rebasing: the head is unchanged,
  // so the earlier request still counts and nothing is re-requested.
  it('stays pending after Dependabot replies with an error', () => {
    const comments = [buildRebaseRequestBody(HEAD_SHA), 'Dependabot could not rebase this PR.'];

    expect(isRebasePending('', comments, HEAD_SHA)).toBe(true);
  });

  it('is not pending when the request was for an earlier head', () => {
    expect(isRebasePending('', [buildRebaseRequestBody(OLD_SHA)], HEAD_SHA)).toBe(false);
  });

  it('is not pending with no request and no rebase running', () => {
    expect(isRebasePending('Bumps x.', ['@dependabot squash and merge'], HEAD_SHA)).toBe(false);
  });
});
