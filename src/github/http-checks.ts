import type { CheckRunData, CommitStatusData, GitHubClient } from './client.js';
import type { HttpTransport } from './http-transport.js';
import { PAGE_SIZE } from './http-transport.js';
import type { RestCheckRun, RestRule } from './rest-payloads.js';

/**
 * The real GitHubClient's check and status reads: the required checks, and the
 * check-runs and commit statuses on a commit.
 */

export type CheckMethods = Pick<
  GitHubClient,
  'getRequiredStatusChecks' | 'listCheckRuns' | 'listCommitStatuses'
>;

export function createCheckMethods({ repoPath, request, paginate }: HttpTransport): CheckMethods {
  return {
    async getRequiredStatusChecks(branch) {
      // Rules from every active ruleset that targets the branch; several rulesets
      // can each require checks, so take the union.
      const rules = await paginate<RestRule>(
        `${repoPath}/rules/branches/${encodeURIComponent(branch)}`,
      );
      const contexts = rules
        .filter((rule) => rule.type === 'required_status_checks')
        .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
        .map((check) => check.context);
      return [...new Set(contexts)];
    },
    async listCheckRuns(sha): Promise<CheckRunData[]> {
      // The default filter=latest returns only the most recent run per name, so
      // a re-run replaces the failure it retried.
      const runs: RestCheckRun[] = [];
      for (let page = 1; ; page += 1) {
        const batch = (await request(
          'GET',
          `${repoPath}/commits/${sha}/check-runs?per_page=${PAGE_SIZE}&page=${page}`,
        )) as { check_runs: RestCheckRun[] };
        runs.push(...batch.check_runs);
        if (batch.check_runs.length < PAGE_SIZE) {
          break;
        }
      }
      return runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        completedAt: run.completed_at,
      }));
    },
    async listCommitStatuses(sha): Promise<CommitStatusData[]> {
      // The combined status holds the latest status per context.
      const combined = (await request('GET', `${repoPath}/commits/${sha}/status`)) as {
        statuses: { context: string; state: string }[];
      };
      return combined.statuses.map((status) => ({ context: status.context, state: status.state }));
    },
  };
}
