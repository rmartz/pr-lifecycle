import type { BotEligibility } from '../bot-eligibility.js';
import {
  classifyBotPr,
  DEPENDABOT_LOGIN,
  isDependabotSecurityUpdate,
  parseDependabotUpdateType,
  RELEASE_PLEASE_BRANCH_PREFIX,
} from '../bot-eligibility.js';
import { listAllChangedFiles } from './changed-files.js';
import type { GitHubClient, PullRequestData } from './client.js';

/**
 * Gathers the facts bot eligibility needs, fetching only what can change the
 * answer: a same-repo Dependabot PR's commits (plus its changed files when a
 * commit has no explicit update type), or a same-repo release-please branch's
 * changed files. The same commits say whether a Dependabot PR is a security
 * update. See docs/bot-eligibility.md.
 */

export interface BotFacts {
  eligibility: BotEligibility;
  /** A same-repo Dependabot security update (see `isDependabotSecurityUpdate`). */
  securityUpdate: boolean;
}

export async function gatherBotFacts(
  client: GitHubClient,
  pr: number,
  pull: PullRequestData,
): Promise<BotFacts> {
  const sameRepo = !pull.isCrossRepository;
  const isDependabot = pull.authorLogin === DEPENDABOT_LOGIN;
  const isReleaseBranch = !isDependabot && pull.headRef.startsWith(RELEASE_PLEASE_BRANCH_PREFIX);
  const [commits, releaseFiles] = await Promise.all([
    sameRepo && isDependabot ? client.listCommits(pr) : [],
    sameRepo && isReleaseBranch ? listAllChangedFiles(client, pr, pull) : undefined,
  ]);
  // A Dependabot commit without an explicit update type (a security update) has
  // its type derived from its versions, corroborated by the diff, so only then
  // are the files read. An omitted patch adds no evidence, so a partial list is fine.
  const needsDiff = commits.some(
    (commit) => parseDependabotUpdateType(commit.message) === undefined,
  );
  const changedFiles =
    isDependabot && needsDiff ? await client.listPullRequestFiles(pr) : releaseFiles;
  const botPr = {
    authorLogin: pull.authorLogin ?? 'ghost',
    headRef: pull.headRef,
    isCrossRepository: pull.isCrossRepository,
    commits,
    changedFiles,
  };
  return { eligibility: classifyBotPr(botPr), securityUpdate: isDependabotSecurityUpdate(botPr) };
}
