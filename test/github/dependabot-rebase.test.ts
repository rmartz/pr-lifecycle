import { describe, expect, it } from 'vitest';

import {
  buildRebaseRequestBody,
  DEPENDABOT_REBASE_COMMAND,
  DEPENDABOT_REBASING_NOTICE,
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

describe('isRebasePending', () => {
  it('is pending while the PR body says Dependabot is rebasing', () => {
    const body = `Bumps x.\n\n> **Note**\n> ${DEPENDABOT_REBASING_NOTICE}`;

    expect(isRebasePending(body, [], HEAD_SHA)).toBe(true);
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
