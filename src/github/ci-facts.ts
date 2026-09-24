import type { CiCheckPolicy, CiStatus } from '../ci.js';
import { checkRunOutcome, commitStatusOutcome, computeCiStatus } from '../ci.js';
import type { GitHubClient, PullRequestData } from './client.js';

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
  const required = await client.getRequiredStatusChecks(pull.baseRef);
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
