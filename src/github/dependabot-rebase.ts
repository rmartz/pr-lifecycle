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
  if (prBody.includes(DEPENDABOT_REBASING_NOTICE)) {
    return true;
  }
  const marker = rebaseRequestMarker(headSha);
  return comments.some((comment) => comment.includes(marker));
}
