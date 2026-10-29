---
type: Reference
title: The sign-off status
description: The pr-lifecycle/sign-off commit status — a versioned contract with pr-policy that says which human sign-off a PR's head needs (none, ci, or uat), the UAT sign-off found for it (v2) or whether a person's waiver counts (v1), and whether a workflow loosens CI; its exact grammar, who posts it, and when.
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
`src/sign-off-plan.ts` (what to report, and when to post), `src/github/execute.ts`
(posting).

## The status

| Field         | Value                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| `context`     | `pr-lifecycle/sign-off`                                                                  |
| commit        | the PR's head SHA the reconcile planned for                                              |
| `state`       | always `success`: the status reports a classification, it is not a gate                  |
| `description` | the versioned summary below                                                              |
| creator       | `rmartz-pr-lifecycle[bot]` (the App's installation token), see [below](#when-its-posted) |

## The description

Space-separated tokens, at most 140 characters, in this order:

```
v2 requirement=<none|ci|uat> [signoff=<waived|passed|absent>] [loosening=<yes|no>]
v1 requirement=<none|ci|uat> [waiver=<current|stale|absent>] [loosening=<yes|no>]
```

- **The version** comes first. Adding a key or a value needs a new version:
  pr-policy rejects an unknown version, an unknown key, a repeated key, or an
  unknown value. Each version rejects the other's UAT key.
- **`requirement`** is the sign-off the head needs:
  - `none`: UAT is off for the repo, the PR is a statically safe CI change, or
    it is approved through [bot eligibility](bot-eligibility.md) with no verdict
    over it ([UAT rule 3](uat.md#rules));
  - `ci`: the CI sign-off (`CI change approved`), not UAT;
  - `uat`: UAT.
- **`signoff`** (`v2`) is **required** with `requirement=uat` and **forbidden**
  otherwise. It is the UAT sign-off [the UAT rules](uat.md#rules) found for the
  head, from people's labels and the review agent's verdict records:
  - `passed`: a person's `UAT passed` counts, for the head, a carried commit, or
    attested by the review (rules 4–5);
  - `waived`: a person's `no UAT needed` counts, or the review recorded
    `uat: not-needed` (rules 6–7);
  - `absent`: neither (rules 8–9).
- **`waiver`** (`v1`) is **required** with `requirement=uat` and **forbidden**
  otherwise. It says whether a trusted person's `no UAT needed` counts for this
  head: `current` (for the head or a carried commit), `stale` (for an earlier
  head), or `absent` (none, or not from a trusted person). The gate reads the
  `UAT passed` label itself, bound to the exact head.
- **`loosening`** is `yes` or `no`, and means `no` when omitted. pr-lifecycle
  writes `loosening=yes` whenever a changed workflow loosens CI, whatever the
  requirement, so the gate can still ask for `CI change approved` on a PR that
  bundled a loosening into another type. It omits `loosening=no`.

Examples: `v2 requirement=uat signoff=waived`, `v2 requirement=none`,
`v1 requirement=uat waiver=absent loosening=yes`, `v1 requirement=ci loosening=yes`.

### Choosing the version

`v1` is the default (`--sign-off-status`, `policy.signOffStatus`). Under `v2`,
pr-policy trusts the status alone for UAT (rmartz/pr-policy#109), so the review
agent's decisions and carried or attested passes reach the gate. Under `v1` they
don't: the gate still reads a person's labels, so a review's `not-needed` holds
until a person waives, and a carried `UAT passed` needs a re-test. Switch a repo
to `v2` once its pr-policy accepts it (`@rmartz/pr-policy` 1.8.0, through
pr-policy-action); an older one rejects the unknown version and holds every PR.

## The classification

Decided in order (`src/sign-off.ts`). A **CI change** is a PR with a `ci:`
title, or one whose changed paths are all CI (`.github/workflows/`,
`.github/actions/`) or otherwise statically safe, at least one of them CI.
Statically safe paths are Markdown and `docs/`, tests and Storybook stories,
lockfiles and `requirements*.txt`, a `package.json` that changes only
dependency versions, and repo metadata (`src/uat-paths.ts`). They decide only
whether a PR is a CI change: no title or path exempts a PR from UAT
([UAT labels](uat.md#who-decides)).

| Rule | When                                                                                                     | `requirement` |
| ---- | -------------------------------------------------------------------------------------------------------- | ------------- |
| 1    | a CI change, and a changed workflow loosens CI                                                           | `ci`          |
| 2    | a CI change, and every non-workflow path is statically safe (its workflow changes don't loosen)          | `none`        |
| 3    | a CI change, otherwise (a composite action, `scripts/**`, linter or test-runner config, a dev-tool bump) | `ci`          |
| 4    | UAT is off for the repo (`--uat off`)                                                                    | `none`        |
| 5    | otherwise                                                                                                | `uat`         |

The status then reports `none` for a `uat` PR approved through bot eligibility
([UAT rule 3](uat.md#rules)).

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

The JSON `signOff.reason` names the rule: `ci-loosening` (1), `ci-safe` (2),
`ci-paths` (3), `uat-off` (4), `needs-uat` (5).

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
  `success`, and a `User` creator (`isPosted` in `src/sign-off-plan.ts`), so a
  status the App created is posted again on each reconcile: redundant, not
  harmful.
- **With the real-actor token** (`PR_LIFECYCLE_TOKEN`, the
  [release token](cli.md#release-token)), for two reasons:
  - a status created with `GITHUB_TOKEN` triggers no workflow, so pr-policy
    wouldn't re-run;
  - pr-policy rejects a status created by `github-actions[bot]`, since any
    workflow can post as it.
- **Who creates it.** Both the action and the hosted App
  ([`rmartz/pr-lifecycle-app`](https://github.com/rmartz/pr-lifecycle-app)) post
  it with the `rmartz-pr-lifecycle` App's installation token, so GitHub reports
  the creator as `rmartz-pr-lifecycle[bot]`. pr-policy trusts a `User` with
  write, maintain, or admin permission, or a `Bot` named in its
  `sign-off-status-creators` input (exact login; its own default names none,
  and the fleet's callers set `rmartz-pr-lifecycle[bot]`). A PAT is not needed.
- **Fails closed.** Without the token, no status is posted, and the gate holds.
  The skip is reported like the arming skip: a stderr warning,
  `signOffStatusSkipped` in the `--json` output, and the one-time
  [token advisory](cli.md#release-token) comment.
- **Write order.** After the labels and before arming (see
  [Execute](github-edge-layer.md#execute)).

pr-policy re-runs on the status through `pr-policy evaluate --sha <sha>`; the
action's `status` trigger, filtered on this context, is a follow-up there.
