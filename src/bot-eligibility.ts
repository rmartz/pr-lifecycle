/**
 * Bot-PR eligibility: is this a bot PR trusted enough to count as `approved`
 * without a review (state priority 4 in docs/reconciler-design.md)? Ported from
 * @rmartz/bot-automerge's classifier, with one deliberate tightening: the head
 * branch must live in the base repository. See docs/bot-eligibility.md.
 *
 * FAIL-SAFE: every uncertain or unrecognized case is not eligible.
 */

export const DEPENDABOT_LOGIN = 'dependabot[bot]';
export const RELEASE_PLEASE_BRANCH_PREFIX = 'release-please--';
export const RELEASE_PLEASE_PENDING_LABEL = 'autorelease: pending';

/** Dependabot's semver update types, lowest to highest risk. */
export const DEPENDABOT_UPDATE_TYPES = [
  'version-update:semver-patch',
  'version-update:semver-minor',
  'version-update:semver-major',
] as const;
export type DependabotUpdateType = (typeof DEPENDABOT_UPDATE_TYPES)[number];

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
  labels: readonly string[];
  /** The PR's commits; only consulted for Dependabot PRs. */
  commits: readonly BotPrCommit[];
}

export interface BotEligibility {
  eligible: boolean;
  /** One-line justification, positive or negative, for dry-run output and logs. */
  reason: string;
  prType: BotPrType | undefined;
  updateType: DependabotUpdateType | undefined;
}

function isUpdateType(value: string): value is DependabotUpdateType {
  return DEPENDABOT_UPDATE_TYPES.some((type) => type === value);
}

/**
 * The highest update type in a Dependabot commit's `updated-dependencies`
 * metadata block, or undefined when the block is missing or any entry's type is
 * unrecognized (fail-safe). A grouped update lists several dependencies; the
 * riskiest one decides. Scans line by line — commit messages are untrusted
 * input, so no backtracking regex runs over the whole message.
 */
export function parseDependabotUpdateType(message: string): DependabotUpdateType | undefined {
  const lines = message.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'updated-dependencies:');
  if (start === -1) {
    return undefined;
  }
  let highest = -1;
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed === '...') {
      break;
    }
    if (!trimmed.startsWith('update-type:')) {
      continue;
    }
    const value = trimmed.slice('update-type:'.length).trim();
    if (!isUpdateType(value)) {
      return undefined;
    }
    highest = Math.max(highest, DEPENDABOT_UPDATE_TYPES.indexOf(value));
  }
  return DEPENDABOT_UPDATE_TYPES[highest];
}

function result(
  eligible: boolean,
  reason: string,
  prType?: BotPrType,
  updateType?: DependabotUpdateType,
): BotEligibility {
  return { eligible, reason, prType, updateType };
}

function classifyDependabot(commits: readonly BotPrCommit[]): BotEligibility {
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
  for (const commit of commits) {
    const type = parseDependabotUpdateType(commit.message);
    if (type === undefined) {
      return result(false, 'Dependabot update type unavailable — not eligible', 'dependabot');
    }
    highest = Math.max(highest, DEPENDABOT_UPDATE_TYPES.indexOf(type));
  }
  const updateType = DEPENDABOT_UPDATE_TYPES[highest];
  if (updateType !== undefined && ELIGIBLE_UPDATE_TYPES.has(updateType)) {
    return result(true, `Dependabot ${updateType} — eligible`, 'dependabot', updateType);
  }
  return result(false, `Dependabot ${updateType} — held for review`, 'dependabot', updateType);
}

export function classifyBotPr(facts: BotPrFacts): BotEligibility {
  // A fork controls its own branch names and commits, so no fork PR is ever a
  // trusted bot PR — bot branches always live in the base repository, where
  // pushing already requires write access.
  if (facts.isCrossRepository) {
    return result(false, 'head branch is in a fork — never a trusted bot PR');
  }
  if (facts.authorLogin === DEPENDABOT_LOGIN) {
    return classifyDependabot(facts.commits);
  }
  if (
    facts.headRef.startsWith(RELEASE_PLEASE_BRANCH_PREFIX) ||
    facts.labels.includes(RELEASE_PLEASE_PENDING_LABEL)
  ) {
    return result(true, 'release-please release PR — eligible', 'release-please');
  }
  return result(false, 'not a recognized bot PR');
}
