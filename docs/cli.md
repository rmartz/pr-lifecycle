---
type: Script
title: The ai-pr-lifecycle CLI
description: The `ai-pr-lifecycle reconcile` command — its flags, environment, exit codes, and the versioned `--json` output contract that rmartz/pr-lifecycle-action builds on.
resource: src/cli.ts
tags: [cli, contract, reconcile, json]
---

# The `ai-pr-lifecycle` CLI

`ai-pr-lifecycle reconcile` runs one full reconcile pass for a PR, as described in
the [GitHub edge layer](github-edge-layer.md): gather facts, plan, execute. The
CLI owns every decision. The composite action in
[`rmartz/pr-lifecycle-action`](https://github.com/rmartz/pr-lifecycle-action) only
installs a pinned version and invokes it, so everything on this page is a
**contract** with that repo. Change it deliberately (see [Versioning](#versioning)).

## Usage

```
ai-pr-lifecycle reconcile --repo <owner/repo> --pr <n>
  [--arm-auto-merge] [--trusted-authors a,b] [--skip-copilot-review] [--dry-run] [--json]
```

| Flag                      | Effect                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--repo <owner/repo>`     | Repository (required).                                                                                           |
| `--pr <n>`                | Pull request number (required, a positive integer).                                                              |
| `--arm-auto-merge`        | Arm/disarm native auto-merge from the state (`policy.armAutoMerge`). Off by default.                             |
| `--trusted-authors <a,b>` | Narrow trust to these logins; they still need write access (`policy.trustedAuthors`). An empty list is an error. |
| `--skip-copilot-review`   | Don't wait for a Copilot review (`policy.skipCopilotReview`).                                                    |
| `--dry-run`               | Gather and plan, but write nothing.                                                                              |
| `--json`                  | Print the result as one JSON object (below) instead of a summary line.                                           |

The policy options are described in the [core design](reconciler-design.md).

## Environment

| Variable         | Use                                                                 |
| ---------------- | ------------------------------------------------------------------- |
| `GITHUB_TOKEN`   | Token for all reads and writes (required; missing → exit 2).        |
| `GITHUB_API_URL` | API base URL for GitHub Enterprise Server (defaults to github.com). |

A separate real-actor token for arming and merging, so merges re-trigger
`on: push` release pipelines, is added in #7.

## Exit codes

| Code | Meaning                                                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Reconciled, including "nothing to do" and a closed PR skipped.                                                                                        |
| `1`  | A GitHub API or other runtime failure. The message is on stderr. Writes are fail-safe ordered, so auto-merge is never left armed on an unapproved PR. |
| `2`  | A usage or configuration error (bad flags, missing `GITHUB_TOKEN`). Nothing is read or written.                                                       |

## Output

Without `--json`, one summary line goes to stdout, e.g.

```
rmartz/demo#7 → approved: +approved, +auto-merge enabled, auto-merge arm (bot: not a recognized bot PR)
```

With `--json`, stdout carries **exactly one JSON object and nothing else**;
errors go to stderr. Every field is always present, and an absent value is `null`,
never omitted:

```json
{
  "schemaVersion": 1,
  "repo": "rmartz/demo",
  "pr": 7,
  "dryRun": false,
  "state": "approved",
  "addLabels": ["approved", "auto-merge enabled"],
  "removeLabels": [],
  "autoMerge": "arm",
  "botEligibility": {
    "eligible": false,
    "reason": "not a recognized bot PR",
    "prType": null,
    "updateType": null
  }
}
```

`state` is one of the lifecycle states in the
[core design](reconciler-design.md#state-in-priority-order). `autoMerge` is `arm`,
`disarm`, or `none`. `botEligibility` is described in
[Bot-PR eligibility](bot-eligibility.md).

## Versioning

The `--json` shape is pinned in full by `test/cli.test.ts`.

- **Adding** a field is not breaking: extend the pinned expectation.
- **Renaming, removing, or retyping** a field is breaking: bump `SCHEMA_VERSION`
  (`src/cli/output.ts`), mark the PR `!`, and coordinate with pr-lifecycle-action,
  which should fail loudly on an unknown `schemaVersion`.
- Flags, environment variables and exit codes follow the same rule.
