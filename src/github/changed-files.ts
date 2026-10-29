import type { ChangedFile } from '../release-diff.js';
import type { GitHubClient, PullRequestData } from './client.js';

/**
 * The PR's changed files, the one fact-gathering step the path-based rules share
 * (bot eligibility's release check and the CI classification). Each rule keeps
 * its own predicate over the list.
 */

/**
 * The PR's changed files, or undefined when the list is incomplete: GitHub lists
 * at most 3,000, so a count short of `changed_files` fails closed.
 */
export async function listAllChangedFiles(
  client: Pick<GitHubClient, 'listPullRequestFiles'>,
  pr: number,
  pull: Pick<PullRequestData, 'changedFileCount'>,
): Promise<ChangedFile[] | undefined> {
  const files = await client.listPullRequestFiles(pr);
  return files.length === pull.changedFileCount ? files : undefined;
}

/** Every path the files touch, a rename's old path included: moving code into docs/ isn't docs-only. */
export function touchedPaths(files: readonly ChangedFile[]): string[] {
  return files.flatMap((file) =>
    file.previousFilename === undefined ? [file.filename] : [file.previousFilename, file.filename],
  );
}
