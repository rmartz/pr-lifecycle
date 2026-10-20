import { isWorkflowPath } from '../ci-change/workflow-paths.js';
import type { FileChange, SignOffStatusFact } from '../facts.js';
import type { ChangedFile } from '../release-diff.js';
import { SIGN_OFF_STATUS_CONTEXT } from '../sign-off-plan.js';
import type { GitHubClient, PullRequestData } from './client.js';

/**
 * Gathers the facts behind the sign-off status (docs/sign-off-status.md): the
 * text of each changed workflow, for the CI loosening rules, and the status
 * already on the head, so an unchanged one isn't posted again.
 */

/** More changed workflows than this aren't read; an unread workflow counts as a loosening. */
export const MAX_WORKFLOW_READS = 20;

/**
 * Merge-base and head text of each changed `.github/workflows/**` file, read at
 * the merge base so a change merged into the base after the PR branched isn't
 * attributed to it. A rename is read from its old path. Over the cap, nothing is
 * read, and every workflow then counts as a loosening.
 */
export async function gatherWorkflowChanges(
  client: Pick<GitHubClient, 'compareCommits' | 'getFileText'>,
  pull: Pick<PullRequestData, 'baseRef' | 'headSha'>,
  files: readonly ChangedFile[],
): Promise<FileChange[]> {
  const workflows = files.filter(
    (file) =>
      isWorkflowPath(file.filename) ||
      (file.previousFilename !== undefined && isWorkflowPath(file.previousFilename)),
  );
  if (workflows.length === 0 || workflows.length > MAX_WORKFLOW_READS) {
    return [];
  }
  const { mergeBaseSha } = await client.compareCommits(pull.baseRef, pull.headSha);
  const changes = await Promise.all(
    workflows.map(async (file): Promise<FileChange[]> => {
      const basePath = file.previousFilename ?? file.filename;
      const baseText =
        file.status === 'added' ? undefined : await client.getFileText(basePath, mergeBaseSha);
      const headText =
        file.status === 'removed'
          ? undefined
          : await client.getFileText(file.filename, pull.headSha);
      if (file.previousFilename === undefined || file.previousFilename === file.filename) {
        return [{ path: file.filename, baseText, headText }];
      }
      // A rename within the workflows is a change of that workflow, as pr-policy
      // reads it; the old path is accounted for, with nothing left to compare.
      // Moved out of the workflows, it is gone: a removal.
      return isWorkflowPath(file.filename)
        ? [
            { path: file.filename, baseText, headText },
            { path: file.previousFilename, baseText: undefined, headText: undefined },
          ]
        : [{ path: file.previousFilename, baseText, headText: undefined }];
    }),
  );
  return changes.flat();
}

/** The latest `pr-lifecycle/sign-off` status on the head, if any. */
export async function gatherSignOffStatus(
  client: Pick<GitHubClient, 'listStatuses'>,
  headSha: string,
): Promise<SignOffStatusFact | undefined> {
  const latest = (await client.listStatuses(headSha)).find(
    (status) => status.context === SIGN_OFF_STATUS_CONTEXT,
  );
  return latest === undefined
    ? undefined
    : {
        state: latest.state,
        description: latest.description,
        creatorType: latest.creatorType,
      };
}
