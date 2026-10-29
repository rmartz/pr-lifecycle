import { describe, expect, it } from 'vitest';

import { gatherFacts } from '../../src/github/gather.js';
import { planReconcile } from '../../src/plan.js';
import { MAX_ATTESTED_COMMITS, MAX_MANIFEST_READS } from '../../src/github/uat-facts.js';
import { HEAD_SHA, makeChangedFile, makeDimensionedVerdictBody, OLD_SHA } from '../fixtures.js';
import { FakeGitHubClient, makePullRequestData, makeReviewData } from './fake-client.js';

// The UAT facts at the edge: what is read, and only when it can matter.

const ON = { uat: 'on' } as const;
const MERGE_BASE = 'e'.repeat(40);
const MANIFEST = '{"name":"demo","dependencies":{"a":"^1.0.0"}}';
const BUMPED = '{"name":"demo","dependencies":{"a":"^1.1.0"}}';

function makeFilesClient(filenames: string[], title = 'build: bump a') {
  const client = new FakeGitHubClient(
    makePullRequestData({ title, changedFileCount: filenames.length }),
  );
  client.files = filenames.map((filename) => makeChangedFile({ filename }));
  return client;
}

function called(client: FakeGitHubClient, method: string): boolean {
  return client.calls.some((call) => call.method === method);
}

describe('gatherFacts — changed paths for UAT', () => {
  it('reads nothing for UAT without a UAT setting', async () => {
    const client = makeFilesClient(['src/a.ts']);

    const { facts } = await gatherFacts(client, 7);

    expect([called(client, 'listPullRequestFiles'), facts.changedPaths]).toEqual([
      false,
      undefined,
    ]);
  });

  it('reads the paths even when the title exempts the PR, for the loosening check', async () => {
    const client = makeFilesClient(['src/a.ts'], 'docs: a');

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.changedPaths).toEqual(['src/a.ts']);
  });

  it('reads the paths, a rename’s old path included', async () => {
    const client = makeFilesClient(['docs/a.md']);
    client.files = [makeChangedFile({ filename: 'docs/a.md', previousFilename: 'src/a.ts' })];

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.changedPaths).toEqual(['src/a.ts', 'docs/a.md']);
  });

  it('leaves the paths unknown when the listing is truncated', async () => {
    const client = makeFilesClient(['pnpm-lock.yaml']);
    client.pull.changedFileCount = 3001;

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.changedPaths).toBeUndefined();
  });

  it('reads a changed package.json at the merge base and the head', async () => {
    const client = makeFilesClient(['package.json', 'pnpm-lock.yaml']);
    client.comparisons.set(`main...${HEAD_SHA}`, { status: 'ahead', mergeBaseSha: MERGE_BASE });
    client.fileTexts.set(`${MERGE_BASE}:package.json`, MANIFEST);
    client.fileTexts.set(`${HEAD_SHA}:package.json`, BUMPED);

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.manifestChanges).toEqual([
      { path: 'package.json', baseText: MANIFEST, headText: BUMPED },
    ]);
  });

  it('reads no base text for an added package.json, and no head text for a removed one', async () => {
    const client = makeFilesClient([]);
    client.files = [
      makeChangedFile({ filename: 'a/package.json', status: 'added' }),
      makeChangedFile({ filename: 'b/package.json', status: 'removed' }),
    ];
    client.pull.changedFileCount = 2;
    client.fileTexts.set(`${HEAD_SHA}:a/package.json`, MANIFEST);
    client.fileTexts.set(`${'0'.repeat(40)}:b/package.json`, MANIFEST);

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.manifestChanges).toEqual([
      { path: 'a/package.json', headText: MANIFEST },
      { path: 'b/package.json', baseText: MANIFEST },
    ]);
  });

  it('skips the manifests when another path already needs UAT', async () => {
    const client = makeFilesClient(['package.json', 'src/a.ts']);

    const { facts } = await gatherFacts(client, 7, ON);

    expect([called(client, 'getFileText'), facts.manifestChanges]).toEqual([false, []]);
  });

  it('skips the manifests when there are too many to read', async () => {
    const names = Array.from({ length: MAX_MANIFEST_READS + 1 }, (_, i) => `p${i}/package.json`);
    const client = makeFilesClient(names);

    await gatherFacts(client, 7, ON);

    expect(called(client, 'getFileText')).toBe(false);
  });
});

describe('gatherFacts — UAT sign-offs', () => {
  function makeSignedClient(labels: string[]) {
    const client = makeFilesClient(['src/a.ts']);
    client.pull.labels = labels;
    client.permissions.set('rmartz', { permission: 'admin', roleName: 'admin' });
    client.labelApplications.set('no UAT needed', [
      { login: 'helper', type: 'User', appliedAt: '2026-10-19T09:00:00Z' },
      { login: 'rmartz', type: 'User', appliedAt: '2026-10-19T11:00:00Z' },
    ]);
    return client;
  }

  it('reads no history when no sign-off label is present', async () => {
    const client = makeFilesClient(['src/a.ts']);

    const { facts } = await gatherFacts(client, 7, ON);

    expect([
      called(client, 'listLabelApplications'),
      called(client, 'listForcePushes'),
      called(client, 'listCheckSuites'),
      facts.uatSignOffs,
    ]).toEqual([false, false, false, undefined]);
  });

  it('takes the latest application of each sign-off, with its actor’s permission', async () => {
    const client = makeSignedClient(['no UAT needed']);

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.uatSignOffs).toEqual([
      {
        label: 'no UAT needed',
        actor: { login: 'rmartz', type: 'User', permission: 'admin' },
        appliedAt: '2026-10-19T11:00:00Z',
      },
    ]);
  });

  it('reads the force-pushes alongside', async () => {
    const client = makeSignedClient(['no UAT needed']);
    client.forcePushes = [
      { headSha: HEAD_SHA, beforeSha: OLD_SHA, pushedAt: '2026-10-19T10:00:00Z' },
    ];

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.forcePushes).toEqual([
      { headSha: HEAD_SHA, beforeSha: OLD_SHA, pushedAt: '2026-10-19T10:00:00Z' },
    ]);
  });

  it('records a sign-off label with no application as no sign-off', async () => {
    const client = makeSignedClient(['UAT passed']);

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.uatSignOffs).toEqual([]);
  });

  it('dates the head by its first check suite on the PR’s branch', async () => {
    const client = makeSignedClient(['no UAT needed']);
    client.checkSuites.set(HEAD_SHA, [
      { headBranch: 'feature/thing', createdAt: '2026-10-19T10:05:00Z' },
      { headBranch: 'elsewhere', createdAt: '2026-10-18T00:00:00Z' },
      { headBranch: 'feature/thing', createdAt: '2026-10-19T10:00:00Z' },
      { headBranch: undefined, createdAt: '2026-10-17T00:00:00Z' },
      { headBranch: 'feature/thing', createdAt: 'garbled' },
    ]);

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.commitArrivals).toEqual({ [HEAD_SHA]: '2026-10-19T10:00:00Z' });
  });

  it('leaves a commit with no suite on the branch undated', async () => {
    const client = makeSignedClient(['no UAT needed']);
    client.checkSuites.set(HEAD_SHA, [
      { headBranch: 'elsewhere', createdAt: '2026-10-19T10:00:00Z' },
    ]);

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.commitArrivals).toEqual({});
  });

  it('reads no sign-offs on a closed PR', async () => {
    const client = makeSignedClient(['no UAT needed']);
    client.pull.state = 'closed';

    await gatherFacts(client, 7, ON);

    expect(called(client, 'listLabelApplications')).toBe(false);
  });
});

describe('gatherFacts — an attested UAT pass', () => {
  const PASSED_AT = '2026-10-19T09:00:00Z';

  /** A PR whose review attests that a pass on OLD_SHA still holds; the label is gone. */
  function makeAttestingClient() {
    const client = makeFilesClient(['src/a.ts']);
    client.reviews = [
      makeReviewData({
        state: 'COMMENTED',
        body: makeDimensionedVerdictBody(
          { code: 'approved', uat: 'unchanged' },
          { uat_since: OLD_SHA },
        ),
        submittedAt: '2026-10-19T10:30:00Z',
      }),
    ];
    client.permissions.set('rmartz', { permission: 'admin', roleName: 'admin' });
    client.labelApplications.set('UAT passed', [
      { login: 'rmartz', type: 'User', appliedAt: PASSED_AT },
    ]);
    client.commits = [
      { sha: OLD_SHA, authorLogin: 'rmartz', message: 'feat: a' },
      { sha: HEAD_SHA, authorLogin: 'rmartz', message: 'Merge main' },
    ];
    client.checkSuites.set(OLD_SHA, [
      { headBranch: 'feature/thing', createdAt: '2026-10-19T08:00:00Z' },
    ]);
    client.checkSuites.set(HEAD_SHA, [
      { headBranch: 'feature/thing', createdAt: '2026-10-19T10:00:00Z' },
    ]);
    return client;
  }

  it('reads the pass history, even with the label removed', async () => {
    const { facts } = await gatherFacts(makeAttestingClient(), 7, ON);

    expect(facts.uatPassedHistory).toEqual([
      {
        label: 'UAT passed',
        actor: { login: 'rmartz', type: 'User', permission: 'admin' },
        appliedAt: PASSED_AT,
      },
    ]);
  });

  it('reads the arrival of every commit on the PR', async () => {
    const { facts } = await gatherFacts(makeAttestingClient(), 7, ON);

    expect(facts.commitArrivals).toEqual({
      [HEAD_SHA]: '2026-10-19T10:00:00Z',
      [OLD_SHA]: '2026-10-19T08:00:00Z',
    });
  });

  it('resolves the attested pass end to end', async () => {
    const client = makeAttestingClient();
    client.permissions.set('maintainer', { permission: 'write', roleName: 'write' });

    const { facts } = await gatherFacts(client, 7, ON);

    expect(planReconcile(facts, ON).uat).toBe('passed-attested');
  });

  it('reads no history without an attesting review', async () => {
    const client = makeAttestingClient();
    client.reviews = [];

    await gatherFacts(client, 7, ON);

    expect([called(client, 'listCommits'), called(client, 'listLabelApplications')]).toEqual([
      false,
      false,
    ]);
  });

  it('reads no history on a PR with too many commits to date', async () => {
    const client = makeAttestingClient();
    client.commits = Array.from({ length: MAX_ATTESTED_COMMITS + 1 }, (_, index) => ({
      sha: index.toString(16).padStart(40, '0'),
      authorLogin: 'rmartz',
      message: 'wip',
    }));

    const { facts } = await gatherFacts(client, 7, ON);

    expect(facts.uatPassedHistory).toBeUndefined();
  });
});
