import { parseArgs } from './cli/args.js';
import { formatSummary, toReconcileJson } from './cli/output.js';
import type { GitHubClient } from './github/client.js';
import type { HttpClientOptions } from './github/http-client.js';
import { createHttpClient } from './github/http-client.js';
import { reconcilePullRequest } from './github/reconcile.js';

/**
 * Command-line entry for `ai-pr-lifecycle`. Kept free of `process` so it is fully
 * testable: the bin shim (src/bin/pr-lifecycle.ts) supplies argv, the environment,
 * and the output streams, and turns the returned code into the exit status.
 *
 * Exit codes (a contract with rmartz/pr-lifecycle-action; see docs/cli.md):
 * 0 reconciled (including "nothing to do" and a skipped closed PR), 1 a GitHub or
 * other runtime failure, 2 a usage or configuration error.
 */

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface CliDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** Builds the GitHub client; tests inject a fake. */
  createClient?: (options: HttpClientOptions) => GitHubClient;
}

export const USAGE = `Usage: ai-pr-lifecycle <command> [options]

Commands:
  reconcile   Recompute a PR's lifecycle state and converge its labels
  help        Show this message

reconcile options:
  --repo <owner/repo>       Repository (required)
  --pr <number>             Pull request number (required)
  --arm-auto-merge          Arm/disarm native auto-merge from the state
  --trusted-authors <a,b>   Only these logins (with write access) may cast verdicts
  --skip-copilot-review     Don't wait for a Copilot review
  --hold-checks <a,b>       Required checks whose pending is a hold (default: pr-policy)
  --ignore-checks <a,b>     Required checks CI never counts (default: merge-safety)
  --dry-run                 Compute the plan without writing anything
  --json                    Print one JSON object (schemaVersion 1) on stdout

Environment:
  GITHUB_TOKEN              Token for reads and writes (required)
  GITHUB_API_URL            API base URL (GitHub Enterprise Server)`;

export async function runCli(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'help':
      io.stdout(USAGE);
      return 0;
    case 'error':
      io.stderr(args.message);
      io.stderr(USAGE);
      return 2;
    case 'reconcile':
      break;
  }

  const token = deps.env['GITHUB_TOKEN'];
  if (token === undefined || token === '') {
    io.stderr('GITHUB_TOKEN is not set');
    return 2;
  }
  const createClient = deps.createClient ?? createHttpClient;
  const apiUrl = deps.env['GITHUB_API_URL'];
  const client = createClient({
    token,
    owner: args.owner,
    repo: args.repo,
    ...(apiUrl === undefined || apiUrl === '' ? {} : { apiUrl }),
  });
  const target = { owner: args.owner, repo: args.repo, pr: args.pr, dryRun: args.dryRun };

  try {
    const result = await reconcilePullRequest(client, args.pr, args.policy, {
      dryRun: args.dryRun,
    });
    if (args.json) {
      io.stdout(JSON.stringify(toReconcileJson(target, result)));
    } else {
      io.stdout(formatSummary(target, result));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`reconcile failed for ${args.owner}/${args.repo}#${args.pr}: ${message}`);
    return 1;
  }
}
