---
type: Reference
title: The sign-off status
description: The pr-lifecycle/sign-off commit status — a versioned contract with pr-policy that says which human sign-off a PR's head needs (none, ci, or uat), whether a trusted waiver counts, and whether a workflow loosens CI; its exact grammar, who posts it, and when.
resource: src/sign-off-plan.ts
tags: [contract, sign-off, uat, ci, pr-policy, status]
---

# The sign-off status

pr-lifecycle decides which human sign-off a PR's head needs and tells
[pr-policy](https://github.com/rmartz/pr-policy), the gate, through one commit
status. Labels are for people; this status is the machine signal. GitHub ties a
status to the commit it describes, so it can't go stale across a push and needs
no timestamp binding.

This page is a **contract** with pr-policy (rmartz/pr-policy#92). pr-policy
rejects a status that doesn't match it exactly, and holds the PR. Change both
sides together.

Source: `src/sign-off.ts` (the classification and the description),
`src/sign-off-plan.ts` (when to post), `src/github/execute.ts` (posting).

## The status

| Field         | Value                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| `context`     | `pr-lifecycle/sign-off`                                                   |
| commit        | the PR's head SHA the reconcile planned for                               |
| `state`       | always `success`: the status reports a classification, it is not a gate   |
| `description` | the versioned summary below                                               |
| creator       | a `User` with write, maintain, or admin permission (the real-actor token) |

## The description, version `v1`

Space-separated tokens, at most 140 characters, in this order:

```
v1 requirement=<none|ci|uat> [waiver=<current|stale|absent>] [loosening=<yes|no>]
```

- **`v1`** comes first. Adding a key or a value needs a new version: pr-policy
  rejects an unknown version, an unknown key, a repeated key, or an unknown
  value.
- **`requirement`** is the sign-off the head needs:
  - `none`: UAT is off for the repo, or the PR is statically safe;
  - `ci`: the CI sign-off (`CI change approved`), not UAT;
  - `uat`: UAT.
- **`waiver`** is **required** with `requirement=uat` and **forbidden**
  otherwise. It says whether a trusted `no UAT needed` counts for this head:
  - `current`: it does, applied for this head or for a commit whose verified
    clean rebase or base merge this head is (a check only pr-lifecycle can make);
  - `stale`: a trusted one is on the PR, but for an earlier head or before the
    title last changed;
  - `absent`: none is on the PR, or the latest one wasn't applied by a trusted
    person.
- **`loosening`** is `yes` or `no`, and means `no` when omitted. pr-lifecycle
  writes `loosening=yes` whenever a changed workflow loosens CI, whatever the
  requirement, so the gate can still ask for `CI change approved` on a PR that
  bundled a loosening into another type. It omits `loosening=no`.

Examples: `v1 requirement=none`, `v1 requirement=uat waiver=current`,
`v1 requirement=uat waiver=absent loosening=yes`, `v1 requirement=ci loosening=yes`.

## The classification

Decided in order (`src/sign-off.ts`). A **CI change** is a PR with a `ci:`
title, or one whose changed paths are all CI (`.github/workflows/`,
`.github/actions/`) or otherwise [statically safe](uat.md#which-prs-cant-be-user-facing),
at least one of them CI. A `ci:` title is decided first; a CI change by its
paths is decided after rule 4.

| Rule | When                                                                                                     | `requirement` |
| ---- | -------------------------------------------------------------------------------------------------------- | ------------- |
| 1    | a CI change, and a changed workflow loosens CI                                                           | `ci`          |
| 2    | a CI change, and every non-workflow path is statically safe (its workflow changes don't loosen)          | `none`        |
| 3    | a CI change, otherwise (a composite action, `scripts/**`, linter or test-runner config, a dev-tool bump) | `ci`          |
| 4    | a `docs`, `test`, or `refactor` title (pr-policy holds each to its paths)                                | `none`        |
| 5    | every changed path is statically safe, none of them CI                                                   | `none`        |
| 6    | UAT is off for the repo (`--uat off`)                                                                    | `none`        |
| 7    | otherwise, `chore` included                                                                              | `uat`         |

- **`ci` and `uat` are mutually exclusive.** A person is asked for one sign-off.
  A `ci` PR shows `CI approval needed` and `no UAT needed` (every PR carries
  exactly one UAT label; see [UAT labels](uat.md#always-exactly-one)).
  A CI change is statically safe or needs the CI sign-off, whatever the UAT
  setting: CI isn't user-facing, so it never needs UAT. A Dependabot action pin
  bump (`chore(deps):`, only `uses:` refs moved) is rule 2.
- **A shipped reusable workflow isn't CI.** One whose only trigger is
  `workflow_call` is product code, so a PR changing it isn't a CI change by its
  paths.
- **A loosening under another type is reported, not reclassified.** A `feat:`
  that also loosens a workflow is a bundling violation the review rejects. Until
  it's split it is `uat`, with `loosening=yes`.
- **Loosening detection** is ported from pr-policy's `ci-change` check: see
  [CI loosening](ci-loosening.md).
- **Fails closed.** An incomplete file list, a changed workflow whose text
  wasn't read, or more than 20 changed workflows counts as a loosening. An
  incomplete file list is never statically safe.

The JSON `signOff.reason` names the rule: `ci-loosening` (1), `trivial-paths`
(2, 5), `ci-paths` (3), `safe-title` (4), `uat-off` (6), `needs-uat` (7).

## CI approval needed

The label people see for the CI sign-off, written from the same classification
with `github-token` like every label (`src/sign-off-plan.ts`), by pr-policy's
policy ("The CI approval label and `/review`" in its `decisions.md`):

- **Present** while the head needs the CI sign-off: `requirement=ci`, or a
  loosening bundled into another type (`loosening=yes`).
- **Removed** when a later push takes that need away.
- **Never removed** once a trusted person (a `User` with write, maintain, or
  admin, as for every sign-off) has applied `CI change approved`: the label then
  stays as the audit record. One applied by a bot or a triage user doesn't count.
- **`CI change approved` is never written here.** It is the person's sign-off.

The gate reads `CI change approved` and the status, never this label.

## When it's posted

- **On every reconcile of an open PR**, draft or not, once the head is
  classified. A closed PR gets none.
- **Idempotent.** It isn't posted again when the head's latest
  `pr-lifecycle/sign-off` status already has the same description, state
  `success`, and a `User` creator. One a bot created is replaced.
- **With the real-actor token** (`PR_LIFECYCLE_TOKEN`, the
  [release token](cli.md#release-token)), for two reasons:
  - a status created with `GITHUB_TOKEN` triggers no workflow, so pr-policy
    wouldn't re-run;
  - pr-policy rejects a status whose creator isn't a trusted `User`, since any
    workflow can post as `github-actions[bot]`. A GitHub App installation token
    reads as a bot too, so the token must be a person's (a fine-grained PAT).
- **Fails closed.** Without the token, no status is posted, and the gate holds.
  The skip is reported like the arming skip: a stderr warning,
  `signOffStatusSkipped` in the `--json` output, and the one-time
  [token advisory](cli.md#release-token) comment.
- **Write order.** After the labels and before arming (see
  [Execute](github-edge-layer.md#execute)).

pr-policy re-runs on the status through `pr-policy evaluate --sha <sha>`; the
action's `status` trigger, filtered on this context, is a follow-up there.
