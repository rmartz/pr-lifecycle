import type { CiCheckPolicy, CiStatus } from '../ci.js';
import { checkRunOutcome, commitStatusOutcome, computeCiStatus } from '../ci.js';
import type { GitHubClient, PullRequestData } from './client.js';
import { GitHubApiError } from './client.js';

/**
 * Gathers the CI-gate facts for a PR: the status of its head's required checks,
 * and — only when that is failing — whether the base branch is failing the same
 * checks (so a PR broken by a red base is held, not routed to a fix). See
 * docs/reconciler-design.md §CI gate.
 */

export interface CiFacts {
  ciStatus: CiStatus;
  baseCiFailing: boolean;
}

const NO_CI: CiFacts = { ciStatus: 'passing', baseCiFailing: false };

// GitHub's answer when the repo's plan can't use rulesets (a private repo on
// GitHub Free): "Upgrade to GitHub Pro or make this repository public to enable
// this feature." The repository checklist treats that as a valid, ruleset-less
// repo, so it means "no required checks" — not a failure.
const PLAN_LIMITATION = /upgrade to github pro|make this repository public/i;

/**
 * The required checks for a branch. A plan-limitation 403 means none; any other
 * error (including a 403 for missing permissions) propagates, so a misconfigured
 * token fails loudly instead of silently switching the CI gate off.
 */
async function requiredChecks(client: GitHubClient, branch: string): Promise<string[]> {
  try {
    return await client.getRequiredStatusChecks(branch);
  } catch (error) {
    if (
      error instanceof GitHubApiError &&
      error.status === 403 &&
      PLAN_LIMITATION.test(error.message)
    ) {
      return [];
    }
    throw error;
  }
}

async function statusAt(
  client: GitHubClient,
  sha: string,
  required: readonly string[],
  policy: CiCheckPolicy,
): Promise<CiStatus> {
  const [runs, statuses] = await Promise.all([
    client.listCheckRuns(sha),
    client.listCommitStatuses(sha),
  ]);
  const results = [
    ...runs.map((run) => ({ name: run.name, outcome: checkRunOutcome(run) })),
    ...statuses.map((status) => ({
      name: status.context,
      outcome: commitStatusOutcome(status.state),
    })),
  ];
  return computeCiStatus(results, required, policy);
}

export async function gatherCiFacts(
  client: GitHubClient,
  pull: PullRequestData,
  policy: CiCheckPolicy,
): Promise<CiFacts> {
  // A settled PR has no lifecycle left to gate, so spend no calls on it.
  if (pull.state !== 'open') {
    return NO_CI;
  }
  const required = await requiredChecks(client, pull.baseRef);
  if (required.length === 0) {
    return NO_CI;
  }
  const ciStatus = await statusAt(client, pull.headSha, required, policy);
  if (ciStatus !== 'failing') {
    return { ciStatus, baseCiFailing: false };
  }
  const baseSha = await client.getBranchHeadSha(pull.baseRef);
  const baseStatus = await statusAt(client, baseSha, required, policy);
  return { ciStatus, baseCiFailing: baseStatus === 'failing' };
}
