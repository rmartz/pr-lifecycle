/**
 * Command-line entry for `ai-pr-lifecycle`. Kept free of `process` so it is fully
 * testable: the bin shim (src/bin/pr-lifecycle.ts) supplies argv and the output
 * streams and turns the returned code into the process exit status.
 *
 * The `reconcile` command (recompute a PR's lifecycle state from its current facts
 * and converge its labels) is not implemented yet — see docs/overview.md.
 */

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export const USAGE = `Usage: ai-pr-lifecycle <command> [options]

Commands:
  help    Show this message

Options:
  -h, --help    Show this message`;

export function runCli(argv: readonly string[], io: CliIo): number {
  const [command] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.stdout(USAGE);
    return 0;
  }
  io.stderr(`Unknown command: ${command}`);
  io.stderr(USAGE);
  return 2;
}
