import { describe, expect, it } from 'vitest';

import {
  DEPENDABOT_REBASING_NOTICE,
  DEPENDABOT_RECREATING_NOTICE,
  isDependabotRebasing,
} from '../../src/github/dependabot-rebase.js';

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

  // A person's request lives in a comment, never the body, and means "asked", not
  // "running".
  it('is not rebasing on a rebase request alone', () => {
    expect(isDependabotRebasing('@dependabot rebase')).toBe(false);
  });

  it('is not rebasing once the notice is gone', () => {
    expect(isDependabotRebasing('Bumps x from 1.0.0 to 1.0.1.')).toBe(false);
  });
});
