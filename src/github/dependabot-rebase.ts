/**
 * Asking Dependabot to rebase its own PR — the only way a Dependabot PR is ever
 * brought up to date. The request is made at most once per head: after asking,
 * the reconciler waits for Dependabot to either rebase (a new head, which may be
 * asked again) or reply with an error (the head is unchanged, so it stays quiet
 * and leaves the PR to a person). See docs/github-edge-layer.md §Auto-update.
 */

export const DEPENDABOT_REBASE_COMMAND = '@dependabot rebase';

/** Dependabot puts this in the PR body while a rebase runs, and removes it after. */
export const DEPENDABOT_REBASING_NOTICE = 'Dependabot is rebasing this PR';

/** The same notice for `@dependabot recreate`, which force-pushes a fresh branch. */
export const DEPENDABOT_RECREATING_NOTICE = 'Dependabot is recreating this PR';

/**
 * Whether Dependabot says, in the PR body, that it is rebasing or recreating the
 * branch right now. Only Dependabot's own notice counts — not our request marker,
 * which means "asked", not "running".
 */
export function isDependabotRebasing(prBody: string): boolean {
  return (
    prBody.includes(DEPENDABOT_REBASING_NOTICE) || prBody.includes(DEPENDABOT_RECREATING_NOTICE)
  );
}

/** Hidden marker recording which head a request was made for. */
export function rebaseRequestMarker(headSha: string): string {
  return `<!-- pr-lifecycle:dependabot-rebase head=${headSha} -->`;
}

/** The command on its own first line, as Dependabot parses it, then the marker. */
export function buildRebaseRequestBody(headSha: string): string {
  return `${DEPENDABOT_REBASE_COMMAND}\n\n${rebaseRequestMarker(headSha)}`;
}

/**
 * Whether asking again would only add noise: a rebase is already running, or one
 * was already requested for this head. A forged marker can only suppress a
 * request, never cause one, so the comment author doesn't matter.
 */
export function isRebasePending(
  prBody: string,
  comments: readonly string[],
  headSha: string,
): boolean {
  if (isDependabotRebasing(prBody)) {
    return true;
  }
  const marker = rebaseRequestMarker(headSha);
  return comments.some((comment) => comment.includes(marker));
}
