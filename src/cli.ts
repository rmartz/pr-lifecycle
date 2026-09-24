import { parseArgs } from './cli/args.js';
import { formatSummary, toReconcileJson } from './cli/output.js';
import type { GitHubClient } from './github/client.js';
import type { HttpClientOptions } from './github/http-client.js';
import { createHttpClient } from './github/http-client.js';
import { reconcilePullRequest } from './github/reconcile.js';
import { postTokenAdvisory } from './github/token-advisory.js';
import type { GitRunner } from './lineage/git.js';
import { createGitRunner } from './lineage/git.js';

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
  /** Runs git for approval carry-over; tests inject one. Defaults to the real binary. */
  git?: GitRunner;
}

export const USAGE = `Usage: ai-pr-lifecycle <command> [options]

Commands:
  reconcile   Recompute a PR's lifecycle state and converge its labels
  help        Show this message

reconcile options:
  --repo <owner/repo>       Repository (required)
  --pr <number>             Pull request number (required)
  --arm-auto-merge          Arm/disarm native auto-merge from the state
  --auto-update             Update approved PRs merge-safety flags 'update required'
                            (Dependabot PRs are asked to rebase, never updated)
  --trusted-authors <a,b>   Only these logins (with write access) may cast verdicts
  --skip-copilot-review     Don't wait for a Copilot review
  --hold-checks <a,b>       Required checks whose pending is a hold (default: pr-policy)
  --ignore-checks <a,b>     Required checks CI never counts (default: merge-safety)
  --dry-run                 Compute the plan without writing anything
  --json                    Print one JSON object (schemaVersion 1) on stdout
  --no-token-advisory       Don't comment on the PR when arming lacks a release token

Environment:
  GITHUB_TOKEN              Token for reads and writes (required)
  PR_LIFECYCLE_TOKEN
                            Real-actor token for arming, merging, and updating;
                            without it, labels are kept but those are skipped
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
  const clientFor = (clientToken: string): GitHubClient =>
    createClient({
      token: clientToken,
      owner: args.owner,
      repo: args.repo,
      ...(apiUrl === undefined || apiUrl === '' ? {} : { apiUrl }),
    });
  const client = clientFor(token);
  const releaseToken = deps.env['PR_LIFECYCLE_TOKEN'];
  const hasReleaseToken = releaseToken !== undefined && releaseToken !== '';
  const target = { owner: args.owner, repo: args.repo, pr: args.pr, dryRun: args.dryRun };

  try {
    const result = await reconcilePullRequest(client, args.pr, args.policy, {
      dryRun: args.dryRun,
      lineage: { git: deps.git ?? createGitRunner(), token },
      // Only arming, merging, and updating use the release token (never reads).
      // Without one they are skipped, not done with GITHUB_TOKEN; see docs/cli.md.
      release: hasReleaseToken ? clientFor(releaseToken) : 'unavailable',
    });
    if (result.skippedAutoMerge !== undefined) {
      io.stderr(
        `warning: ${args.owner}/${args.repo}#${args.pr} is approved, but auto-merge ${result.skippedAutoMerge} was skipped: PR_LIFECYCLE_TOKEN is not set`,
      );
      if (args.tokenAdvisory && !args.dryRun) {
        await adviseMissingToken(client, args.pr, result.skippedAutoMerge, io);
      }
    }
    if (result.skippedUpdate !== undefined) {
      io.stderr(
        `warning: ${args.owner}/${args.repo}#${args.pr} needs an update, but ${result.skippedUpdate} was skipped: PR_LIFECYCLE_TOKEN is not set`,
      );
    }
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

/** Best effort: the reconcile already succeeded, so a failed comment only warns. */
async function adviseMissingToken(
  client: GitHubClient,
  pr: number,
  skipped: 'arm' | 'merge',
  io: CliIo,
): Promise<void> {
  try {
    await postTokenAdvisory(client, pr, skipped);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`warning: could not post the missing-token advisory: ${message}`);
  }
}
