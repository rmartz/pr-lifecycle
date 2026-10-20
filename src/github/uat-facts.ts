import type { FileChange, ReconcilePolicy, UatSignOffLabel } from '../facts.js';
import { UAT_SIGN_OFF_LABELS } from '../facts.js';
import type { ChangedFile } from '../release-diff.js';
import { isPackageManifest, trivialCategories } from '../uat-paths.js';
import { isUatExemptTitle } from '../uat-title.js';
import { listAllChangedFiles, touchedPaths } from './changed-files.js';
import type { GitHubClient, LabelApplicationData, PullRequestData } from './client.js';

/**
 * Gathers the facts the UAT classifier needs (docs/uat.md), reading only what
 * can change its answer: nothing when UAT isn't reconciled or the PR is closed;
 * the changed paths only when the title doesn't already exempt the PR; and the
 * sign-off history only when a sign-off label is on the PR. Trust and head
 * binding are decided later, in the core.
 */

/** More changed manifests than this aren't read: such a PR isn't exempt by its paths. */
export const MAX_MANIFEST_READS = 10;

/** Whether the UAT facts matter at all for this PR. */
export function uatActive(policy: ReconcilePolicy, pull: Pick<PullRequestData, 'state'>): boolean {
  return policy.uat === 'on' && pull.state === 'open';
}

/** The UAT sign-off labels on the PR, when they can count. */
export function presentSignOffs(
  policy: ReconcilePolicy,
  pull: Pick<PullRequestData, 'labels' | 'state'>,
): UatSignOffLabel[] {
  return uatActive(policy, pull)
    ? UAT_SIGN_OFF_LABELS.filter((label) => pull.labels.includes(label))
    : [];
}

export interface SignOffApplication {
  label: UatSignOffLabel;
  application: LabelApplicationData;
}

/**
 * The latest application of each sign-off label present: re-applying a label
 * replaces who applied it, as in pr-policy. A label with no `labeled` event
 * (applied before the events were kept) has no sign-off, so it never counts.
 */
export async function gatherSignOffApplications(
  client: Pick<GitHubClient, 'listLabelApplications'>,
  pr: number,
  labels: readonly UatSignOffLabel[],
): Promise<SignOffApplication[]> {
  const found = await Promise.all(
    labels.map(async (label) => {
      const application = (await client.listLabelApplications(pr, label)).at(-1);
      return application === undefined ? [] : [{ label, application }];
    }),
  );
  return found.flat();
}

/**
 * When each commit first had a check suite on the PR's branch. A suite for the
 * same commit on another branch doesn't count: the commit could have been pushed
 * there long before it reached this PR.
 */
export async function gatherCommitArrivals(
  client: Pick<GitHubClient, 'listCheckSuites'>,
  pull: Pick<PullRequestData, 'headRef'>,
  commits: readonly string[],
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    [...new Set(commits)].map(async (sha) => {
      const times = (await client.listCheckSuites(sha))
        .filter((suite) => suite.headBranch === pull.headRef)
        .map((suite) => suite.createdAt)
        .filter((createdAt) => !Number.isNaN(Date.parse(createdAt)))
        .toSorted((a, b) => Date.parse(a) - Date.parse(b));
      const first = times[0];
      return first === undefined ? [] : [[sha, first] as const];
    }),
  );
  return Object.fromEntries(entries.flat());
}

/**
 * Base (merge base) and head text of each changed `package.json`, read only
 * when every other path is already exempt, since otherwise their content can't
 * change the answer.
 */
async function gatherManifestChanges(
  client: Pick<GitHubClient, 'compareCommits' | 'getFileText'>,
  pull: Pick<PullRequestData, 'baseRef' | 'headSha'>,
  files: readonly ChangedFile[],
): Promise<FileChange[]> {
  const manifests = files.filter(
    (file) =>
      isPackageManifest(file.filename) ||
      (file.previousFilename !== undefined && isPackageManifest(file.previousFilename)),
  );
  const others = touchedPaths(files.filter((file) => !manifests.includes(file)));
  if (
    manifests.length === 0 ||
    manifests.length > MAX_MANIFEST_READS ||
    trivialCategories(others) === undefined
  ) {
    return [];
  }
  const { mergeBaseSha } = await client.compareCommits(pull.baseRef, pull.headSha);
  return Promise.all(
    manifests.map(async (file): Promise<FileChange> => {
      const baseText =
        file.status === 'added'
          ? undefined
          : await client.getFileText(file.previousFilename ?? file.filename, mergeBaseSha);
      const headText =
        file.status === 'removed'
          ? undefined
          : await client.getFileText(file.filename, pull.headSha);
      return {
        path: file.filename,
        ...(baseText === undefined ? {} : { baseText }),
        ...(headText === undefined ? {} : { headText }),
      };
    }),
  );
}

export interface PathFacts {
  changedPaths?: string[];
  manifestChanges?: FileChange[];
}

/**
 * The changed paths for the path fallback, gathered only when UAT is on and the
 * title doesn't exempt the PR. An incomplete listing leaves `changedPaths`
 * absent, which exempts nothing.
 */
export async function gatherPathFacts(
  client: Pick<GitHubClient, 'compareCommits' | 'getFileText' | 'listPullRequestFiles'>,
  pr: number,
  pull: PullRequestData,
  policy: ReconcilePolicy,
): Promise<PathFacts> {
  if (!uatActive(policy, pull) || isUatExemptTitle(pull.title)) {
    return {};
  }
  const files = await listAllChangedFiles(client, pr, pull);
  if (files === undefined) {
    return {};
  }
  return {
    changedPaths: touchedPaths(files),
    manifestChanges: await gatherManifestChanges(client, pull, files),
  };
}
