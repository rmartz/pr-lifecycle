import type { BotEligibility } from '../bot-eligibility.js';
import {
  classifyBotPr,
  DEPENDABOT_LOGIN,
  RELEASE_PLEASE_BRANCH_PREFIX,
} from '../bot-eligibility.js';
import type { ChangedFile } from '../release-diff.js';
import type { GitHubClient, PullRequestData } from './client.js';

/**
 * Gathers the facts bot eligibility needs, fetching only what can change the
 * answer: a same-repo Dependabot PR's commits, or a same-repo release-please
 * branch's changed files. See docs/bot-eligibility.md.
 */

/**
 * The PR's changed files, or undefined when the list is incomplete: GitHub lists
 * at most 3,000, so a count short of `changed_files` fails closed.
 */
async function listAllChangedFiles(
  client: GitHubClient,
  pr: number,
  pull: PullRequestData,
): Promise<ChangedFile[] | undefined> {
  const files = await client.listPullRequestFiles(pr);
  return files.length === pull.changedFileCount ? files : undefined;
}

export async function gatherBotEligibility(
  client: GitHubClient,
  pr: number,
  pull: PullRequestData,
): Promise<BotEligibility> {
  const sameRepo = !pull.isCrossRepository;
  const isDependabot = pull.authorLogin === DEPENDABOT_LOGIN;
  const isReleaseBranch = !isDependabot && pull.headRef.startsWith(RELEASE_PLEASE_BRANCH_PREFIX);
  const [commits, changedFiles] = await Promise.all([
    sameRepo && isDependabot ? client.listCommits(pr) : [],
    sameRepo && isReleaseBranch ? listAllChangedFiles(client, pr, pull) : undefined,
  ]);
  return classifyBotPr({
    authorLogin: pull.authorLogin ?? 'ghost',
    headRef: pull.headRef,
    isCrossRepository: pull.isCrossRepository,
    commits,
    changedFiles,
  });
}
