/**
 * Reading Dependabot's own rebase notice. The reconciler never asks Dependabot to
 * rebase — it refuses commands from a GitHub App — but a person may, and
 * Dependabot also rebases on its own; while it does, the PR shows the
 * `dependabot rebasing` label. See docs/reconciler-design.md §Dependabot rebasing
 * label.
 */

/** Dependabot puts this in the PR body while a rebase runs, and removes it after. */
export const DEPENDABOT_REBASING_NOTICE = 'Dependabot is rebasing this PR';

/** The same notice for `@dependabot recreate`, which force-pushes a fresh branch. */
export const DEPENDABOT_RECREATING_NOTICE = 'Dependabot is recreating this PR';

/**
 * Whether Dependabot says, in the PR body, that it is rebasing or recreating the
 * branch right now.
 */
export function isDependabotRebasing(prBody: string): boolean {
  return (
    prBody.includes(DEPENDABOT_REBASING_NOTICE) || prBody.includes(DEPENDABOT_RECREATING_NOTICE)
  );
}
