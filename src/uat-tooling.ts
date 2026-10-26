import { parse } from 'yaml';

import { asNameList, asRecord } from './ci-change/structure.js';
import { isWorkflowPath } from './ci-change/workflow-paths.js';
import type { FileChange } from './facts.js';
import { trivialCategories } from './uat-paths.js';

/**
 * The repo's own CI and tooling, judged from the changed paths (docs/uat.md).
 * UAT is only for the product's user-facing functional behavior, and tooling is
 * never user-facing: a PR that changes nothing but tooling and trivial paths
 * needs no UAT. Whether a tooling change weakens a check is a CI-governance
 * question, answered by the loosening rules and the CI sign-off, never by UAT.
 *
 * Kept apart from `trivialCategories`, which means "statically safe, no sign-off
 * of any kind" and decides whether a `ci:` PR needs the CI sign-off.
 */

/**
 * Linter, formatter, test-runner, and repo-tooling config, by file name at any
 * depth: pr-policy's `tooling-config` path kind. Build, app, and deploy config
 * (`tsconfig.json`, `next.config.*`, bundler config, `vercel.json`) is absent on
 * purpose: it changes what ships.
 */
const TOOLING_CONFIG = new RegExp(
  [
    String.raw`^eslint\.config\.[cm]?[jt]s$`,
    String.raw`^\.eslintrc(\..+)?$`,
    String.raw`^\.eslintignore$`,
    String.raw`^prettier\.config\.[cm]?[jt]s$`,
    String.raw`^\.prettierrc(\..+)?$`,
    String.raw`^\.prettierignore$`,
    String.raw`^(vitest|jest|playwright|cypress)\.config\.[cm]?[jt]s$`,
    String.raw`^vitest\.workspace\.[cm]?[jt]s$`,
    String.raw`^\.?ruff\.toml$`,
    String.raw`^\.flake8$`,
    String.raw`^\.?pylintrc$`,
    String.raw`^\.?mypy\.ini$`,
    String.raw`^pytest\.ini$`,
    String.raw`^\.coveragerc$`,
    String.raw`^\.markdownlint(-cli2)?(\..+)?$`,
    String.raw`^\.yamllint(\..+)?$`,
    String.raw`^\.pre-commit-config\.ya?ml$`,
    String.raw`^\.repo-hygiene\.ya?ml$`,
    String.raw`^\.releaserc(\..+)?$`,
    String.raw`^release\.config\.[cm]?[jt]s$`,
    String.raw`^commitlint\.config\.[cm]?[jt]s$`,
    String.raw`^\.commitlintrc(\..+)?$`,
    String.raw`^\.lintstagedrc(\..+)?$`,
    String.raw`^lint-staged\.config\.[cm]?[jt]s$`,
    String.raw`^\.?codecov\.ya?ml$`,
  ].join('|'),
);

/** The workflow's text: its head side, or its base side for a deletion. */
function workflowText(change: FileChange | undefined): string | undefined {
  return change?.headText ?? change?.baseText;
}

/**
 * Whether a workflow's only trigger is `workflow_call`: a shipped reusable
 * workflow, which in an Action or reusable-workflow repo is the product its
 * consumers call, not this repo's CI. `undefined` when the text wasn't read or
 * won't parse, so the caller can fail closed.
 */
export function isShippedReusableWorkflow(change: FileChange | undefined): boolean | undefined {
  const text = workflowText(change);
  if (text === undefined) {
    return undefined;
  }
  let doc: unknown;
  try {
    doc = parse(text) as unknown;
  } catch {
    return undefined;
  }
  const on = asRecord(doc)?.on;
  const events = asRecord(on);
  const triggers = events === undefined ? asNameList(on) : Object.keys(events);
  return triggers.length > 0 && triggers.every((trigger) => trigger === 'workflow_call');
}

/**
 * Whether a changed path is the repo's own CI or tooling. A workflow counts only
 * when its text was read and it isn't a shipped reusable workflow; an unread or
 * unparseable one is treated as product (fails closed).
 */
export function isToolingPath(path: string, workflows: readonly FileChange[] = []): boolean {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  if (isWorkflowPath(path)) {
    const shipped = isShippedReusableWorkflow(workflows.find((change) => change.path === path));
    return shipped === false;
  }
  if (path.startsWith('.github/workflows/') || path.startsWith('.github/actions/')) {
    return true;
  }
  if (TOOLING_CONFIG.test(name)) {
    return true;
  }
  // The repo's own scripts (audits, CI checks, release helpers), at the top level.
  return parts[0] === 'scripts' && parts.length > 1;
}

/**
 * Whether no changed path is the product's user-facing behavior: each is
 * statically trivial or the repo's CI and tooling. Unknown paths (an incomplete
 * listing) aren't.
 */
export function onlyNonUserFacingPaths(
  paths: readonly string[] | undefined,
  manifests: readonly FileChange[] = [],
  workflows: readonly FileChange[] = [],
): boolean {
  if (paths === undefined) {
    return false;
  }
  const others = paths.filter((path) => !isToolingPath(path, workflows));
  return trivialCategories(others, manifests) !== undefined;
}
