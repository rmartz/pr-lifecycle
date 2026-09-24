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
`dryRun`). It returns the plan and the bot-eligibility verdict, so callers can
report what changed and why.

Source: `src/github/`.

## The client seam

`GitHubClient` (`client.ts`) is a narrow, domain-shaped interface: get the PR,
list reviews, list commits, get a collaborator's permission, list/create repo labels,
add/remove PR labels, list/post PR comments, enable/disable auto-merge, and merge. All decisions live in
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
- **Bot eligibility** is computed here with `classifyBotPr` (see
  [Bot-PR eligibility](bot-eligibility.md)) from the PR author, head ref, labels,
  and whether the head is in a fork. The PR's commits are fetched only for a
  Dependabot PR from this repository, the one case where they can change the
  answer. The verdict, with its `reason`, is returned alongside the facts.

## Execute

Writes happen in a **fail-safe order**: disarm auto-merge → remove labels → add
labels → arm (or merge). If a run dies partway, auto-merge is never left armed
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

## Arming and merging

- **Merge or arm.** The plan says `merge` for an approved PR GitHub would merge
  right now and `arm` otherwise (see [Plan](reconciler-design.md#plan)), matching
  `gh pr merge --auto`. Both are squash.
- **Bound to the planned head.** Both mutations pass `expectedHeadOid` = the head
  the plan was computed for. If a commit lands mid-run, GitHub rejects the merge
  or arm instead of merging an unreviewed commit, and the error is not retried.
- **Clean-status fallback.** If arming fails with _"…clean status"_ (the PR became
  mergeable between the read and the arm), the executor merges instead, bound to
  the same head. Any other arming error propagates.
- **A real-actor token.** A merge made with `GITHUB_TOKEN` triggers no `on: push`
  workflows (releases, CI on `main`). So arming and merging go through
  `ReleaseActions` (`Pick<GitHubClient, 'enableAutoMerge' | 'mergePullRequest'>`),
  a client built from a separate release token that is never used for anything
  else, reads included. Disarming uses the main client, since any token may do it.
  `reconcilePullRequest` takes it as `options.release`, defaulting to the main
  client, which is right when that token is itself a real actor.
- **No release token.** `release: 'unavailable'` applies `withoutArming` to the
  plan: labels converge, the arm or merge is skipped (reported as
  `skippedAutoMerge`), and a disarm still happens. It never falls back to the
  main token. A stub that refuses both calls stands in, so a regression fails
  loudly instead. The CLI's handling (a warning and an advisory comment) is in
  [the CLI](cli.md#release-token).
