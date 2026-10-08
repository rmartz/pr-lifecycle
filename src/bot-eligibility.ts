import type { DependabotUpdateType } from './dependabot-versions.js';
import { commitUpdateType, DEPENDABOT_UPDATE_TYPES } from './dependabot-versions.js';
import type { ChangedFile } from './release-diff.js';
import { classifyReleaseDiff } from './release-diff.js';

export type { DependabotUpdateType } from './dependabot-versions.js';
export { DEPENDABOT_UPDATE_TYPES, parseDependabotUpdateType } from './dependabot-versions.js';

/**
 * Bot-PR eligibility: is this a bot PR trusted enough to count as `approved`
 * without a review (state priority 8 in docs/reconciler-design.md)? Ported from
 * @rmartz/bot-automerge's classifier, with deliberate tightenings: the head
 * branch must live in the base repository, and a release-please PR is recognized
 * by its branch and a release-only diff, never by a label. See
 * docs/bot-eligibility.md.
 *
 * FAIL-SAFE: every uncertain or unrecognized case is not eligible.
 */

export const DEPENDABOT_LOGIN = 'dependabot[bot]';
export const RELEASE_PLEASE_BRANCH_PREFIX = 'release-please--';

const ELIGIBLE_UPDATE_TYPES: ReadonlySet<DependabotUpdateType> = new Set([
  'version-update:semver-patch',
  'version-update:semver-minor',
]);

export type BotPrType = 'dependabot' | 'release-please';

export interface BotPrCommit {
  /** The commit author's GitHub login; undefined when not linked to an account. */
  authorLogin: string | undefined;
  message: string;
}

export interface BotPrFacts {
  authorLogin: string;
  headRef: string;
  /** True when the head branch lives in a fork, not the base repository. */
  isCrossRepository: boolean;
  /** The PR's commits; only consulted for Dependabot PRs. */
  commits: readonly BotPrCommit[];
  /**
   * The PR's changed files. A release-please PR needs them read in full; a
   * Dependabot security update uses them to corroborate its versions. Undefined
   * when not fetched (or, for release-please, not read in full), which never
   * makes a PR eligible on their account.
   */
  changedFiles: readonly ChangedFile[] | undefined;
}

export interface BotEligibility {
  eligible: boolean;
  /** One-line justification, positive or negative, for dry-run output and logs. */
  reason: string;
  prType: BotPrType | undefined;
  updateType: DependabotUpdateType | undefined;
}

function result(
  eligible: boolean,
  reason: string,
  prType?: BotPrType,
  updateType?: DependabotUpdateType,
): BotEligibility {
  return { eligible, reason, prType, updateType };
}

function classifyDependabot(
  commits: readonly BotPrCommit[],
  changedFiles: readonly ChangedFile[] | undefined,
): BotEligibility {
  if (commits.length === 0) {
    return result(false, 'Dependabot PR with no commits — not eligible', 'dependabot');
  }
  // Someone else pushed onto the branch (e.g. a fix for a breaking bump): it is
  // no longer a pure dependency bump, so it needs a human review.
  if (commits.some((commit) => commit.authorLogin !== DEPENDABOT_LOGIN)) {
    return result(
      false,
      'Dependabot PR has non-Dependabot commits — held for review',
      'dependabot',
    );
  }
  let highest = -1;
  let derived = false;
  for (const commit of commits) {
    const commitType = commitUpdateType(commit.message, changedFiles);
    if (commitType.type === undefined) {
      return result(
        false,
        `Dependabot update type unavailable (${commitType.reason}) — not eligible`,
        'dependabot',
      );
    }
    highest = Math.max(highest, DEPENDABOT_UPDATE_TYPES.indexOf(commitType.type));
    derived ||= commitType.derived;
  }
  const updateType = DEPENDABOT_UPDATE_TYPES[highest];
  // A security update carries no update-type line, so its type came from its versions.
  const how = derived ? ' (derived from the versions)' : '';
  if (updateType !== undefined && ELIGIBLE_UPDATE_TYPES.has(updateType)) {
    return result(true, `Dependabot ${updateType}${how} — eligible`, 'dependabot', updateType);
  }
  return result(
    false,
    `Dependabot ${updateType}${how} — held for review`,
    'dependabot',
    updateType,
  );
}

export function classifyBotPr(facts: BotPrFacts): BotEligibility {
  // A fork controls its own branch names and commits, so no fork PR is ever a
  // trusted bot PR — bot branches always live in the base repository, where
  // pushing already requires write access.
  if (facts.isCrossRepository) {
    return result(false, 'head branch is in a fork — never a trusted bot PR');
  }
  if (facts.authorLogin === DEPENDABOT_LOGIN) {
    return classifyDependabot(facts.commits, facts.changedFiles);
  }
  // Only the branch identifies release-please: pushing one needs write access,
  // while a label can be applied with triage alone. The branch still isn't
  // enough on its own — anyone with write access can push arbitrary code to one
  // — so the diff must be a pure release too.
  if (facts.headRef.startsWith(RELEASE_PLEASE_BRANCH_PREFIX)) {
    const diff = classifyReleaseDiff(facts.changedFiles);
    return diff.release
      ? result(true, 'release-please release PR — eligible', 'release-please')
      : result(
          false,
          `release-please branch, but not a pure release (${diff.reason}) — held for review`,
          'release-please',
        );
  }
  return result(false, 'not a recognized bot PR');
}
