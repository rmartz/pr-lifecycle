---
type: Library
title: GitHub edge layer
description: How the reconciler reads a PR's facts from GitHub and applies a reconcile plan — the GitHubClient seam, permission mapping, fail-safe write order, tolerated errors, and the HTTP client.
resource: src/github/reconcile.ts
tags: [github, edge, labels, auto-merge, security]
---

# GitHub edge layer

The edge layer connects the pure [reconciler core](reconciler-design.md) to GitHub.
`reconcilePullRequest(client, pr, policy)` runs one full pass: **gather** the
PR's facts, **plan** with `planReconcile`, and **execute** the plan (skipped with
`dryRun`). It returns the plan so callers can report what changed.

Source: `src/github/`.

## The client seam

`GitHubClient` (`client.ts`) is a narrow, domain-shaped interface: get the PR,
list reviews, get a collaborator's permission, list/create repo labels,
add/remove PR labels, and enable/disable auto-merge. All decisions live in
`gather.ts` and `execute.ts`, which are tested against an in-memory fake
(`test/github/fake-client.ts`). The real implementation, `createHttpClient`
(`http-client.ts`), only maps requests and responses: REST for reads and labels,
GraphQL for the auto-merge mutations (REST has none). It uses the runtime's
`fetch`, so it has no dependencies, and failures throw `GitHubApiError` with the
HTTP status.

## Gather

- **Everything is read before anything is written.** A run never reacts to its own
  writes (ai-tools#306, constraint 3).
- **Permissions.** Each distinct review author is looked up once via the
  collaborator-permission API. The fine-grained `role_name` is preferred, since
  it distinguishes `maintain` and `triage`. A custom role falls back to the legacy
  `permission` level, and an unrecognized value maps to `none`. A 404
  (non-collaborator) means `none`; any other error aborts the run.
- **Untrusted by construction.** Bots and deleted ("ghost") accounts skip the
  lookup and get `none`, so they can never cast a counting verdict. The HTTP
  client maps an unrecognized review state to `DISMISSED` and any non-`User` actor
  type (e.g. `Organization`) to `Bot`, so new GitHub values fail closed.
- `botEligible` is passed in by the caller; it is `false` until the eligibility
  predicate lands (#5).

## Execute

Writes happen in a **fail-safe order**: disarm auto-merge → remove labels → add
labels → arm auto-merge. If a run dies partway, auto-merge is never left armed
on a PR that isn't approved, and arming happens only after the labels that
explain it are written.

- **Tolerated errors.** Removing a label that's already gone (404) and creating a
  label that already exists (422, e.g. from a concurrent run) both mean the goal
  state is reached. Every other error propagates. A failed run is safe to retry,
  because the next event recomputes from facts.
- **Missing labels.** Before adding labels, the repo's labels are listed once, and
  any owned label the repo lacks is created from the fleet roster definition
  (`label-roster.ts`), so a consumer that hasn't seeded the roster still gets
  correctly colored labels (ai-tools#281). An existing label is never modified.
- An empty plan makes **no** API calls.

## Known limitation: arming an already-mergeable PR

`enablePullRequestAutoMerge` fails with _"Pull request is in clean status"_ when
the PR is already mergeable, e.g. it is approved _after_ every required check
passed. Auto-merge can't be armed then; `gh pr merge --auto` works around this by
merging immediately. How the reconciler should handle this (merge directly, or
leave it for the next trigger) is part of the arming work in #7.
