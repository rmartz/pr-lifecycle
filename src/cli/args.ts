import type { ReconcilePolicy } from '../facts.js';

/**
 * Argument parsing for `ai-pr-lifecycle`. Pure: argv in, a parsed command or a
 * usage error out, so every flag is tested without a process. The contract is
 * recorded on #6 and in docs/cli.md.
 */

export interface ReconcileArgs {
  command: 'reconcile';
  owner: string;
  repo: string;
  pr: number;
  policy: ReconcilePolicy;
  dryRun: boolean;
  json: boolean;
  /** Comment on the PR when arming is skipped for want of a release token. */
  tokenAdvisory: boolean;
}

export type ParsedArgs =
  ReconcileArgs | { command: 'help' } | { command: 'error'; message: string };

type ValueOption = '--hold-checks' | '--ignore-checks' | '--pr' | '--repo' | '--trusted-authors';

const REPO_PATTERN = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const PR_PATTERN = /^[1-9][0-9]*$/;

function usageError(message: string): ParsedArgs {
  return { command: 'error', message };
}

/** Split a comma list, dropping blanks, so `--trusted-authors "a, b,"` is `['a', 'b']`. */
function parseList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseReconcile(args: readonly string[]): ParsedArgs {
  const values: Partial<Record<ValueOption, string>> = {};
  let armAutoMerge = false;
  let autoUpdate = false;
  let skipCopilotReview = false;
  let dryRun = false;
  let json = false;
  let tokenAdvisory = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    switch (arg) {
      case '--arm-auto-merge':
        armAutoMerge = true;
        break;
      case '--auto-update':
        autoUpdate = true;
        break;
      case '--skip-copilot-review':
        skipCopilotReview = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--json':
        json = true;
        break;
      case '--no-token-advisory':
        tokenAdvisory = false;
        break;
      case '--repo':
      case '--pr':
      case '--trusted-authors':
      case '--hold-checks':
      case '--ignore-checks': {
        const value = args[index + 1];
        if (value === undefined || value.startsWith('--')) {
          return usageError(`${arg} requires a value`);
        }
        index += 1;
        values[arg] = value;
        break;
      }
      default:
        return usageError(`Unknown option: ${arg}`);
    }
  }

  const repoArg = values['--repo'];
  const prArg = values['--pr'];
  const repoMatch = repoArg === undefined ? null : REPO_PATTERN.exec(repoArg);
  if (repoMatch?.[1] === undefined || repoMatch[2] === undefined) {
    return usageError('--repo <owner/repo> is required');
  }
  if (prArg === undefined || !PR_PATTERN.test(prArg)) {
    return usageError('--pr <number> is required and must be a positive integer');
  }
  const trustedAuthors = listOption(values['--trusted-authors']);
  // An empty allowlist would silently trust nobody; treat it as a mistake.
  if (trustedAuthors?.length === 0) {
    return usageError('--trusted-authors needs at least one login');
  }
  // An empty check list is meaningful (e.g. `--ignore-checks ''` counts every
  // required check), so unlike trusted authors it is allowed.
  const holdChecks = listOption(values['--hold-checks']);
  const ignoredChecks = listOption(values['--ignore-checks']);

  return {
    command: 'reconcile',
    owner: repoMatch[1],
    repo: repoMatch[2],
    pr: Number(prArg),
    policy: {
      armAutoMerge,
      autoUpdate,
      skipCopilotReview,
      ...(trustedAuthors === undefined ? {} : { trustedAuthors }),
      ...(holdChecks === undefined ? {} : { holdChecks }),
      ...(ignoredChecks === undefined ? {} : { ignoredChecks }),
    },
    dryRun,
    json,
    tokenAdvisory,
  };
}

function listOption(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : parseList(value);
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    return { command: 'help' };
  }
  if (command === 'reconcile') {
    return parseReconcile(rest);
  }
  return usageError(`Unknown command: ${command}`);
}
