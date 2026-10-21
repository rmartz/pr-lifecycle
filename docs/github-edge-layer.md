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
add/remove PR labels, list/post PR comments, find the last ready-for-review time,
enable/disable auto-merge, merge, and update the branch. All decisions live in
`gather.ts` and `execute.ts`, which are tested against an in-memory fake
(`test/github/fake-client.ts`). The real implementation, `createHttpClient`
(`http-client.ts`, with `http-checks.ts` and `http-history.ts`), only maps
requests and responses: REST for reads and labels, GraphQL for the auto-merge
mutations and the force-pushes (REST lacks both). It uses the runtime's
`fetch`, so it has no dependencies, and failures throw `GitHubApiError` with the
HTTP status (0 for a network failure) and a `transient` flag: set for a rate
limit, a 5xx, or a network failure, so the CLI can
[exit 75 instead of 1](cli.md#exit-codes).

## Gather

- **Everything is read before anything is written.** A run never reacts to its own
  writes: its output depends only on the facts read at the start.
- **Permissions** (`permissions.ts`). Each distinct review author, each person
  who removed `escalation needed`, and each person who applied a UAT sign-off is
  looked up once via the collaborator-permission API. The fine-grained `role_name` is preferred, since
  it distinguishes `maintain` and `triage`. A custom role falls back to the legacy
  `permission` level, and an unrecognized value maps to `none`. A 404
  (non-collaborator) means `none`; any other error aborts the run.
- **Untrusted by construction.** Bots and deleted ("ghost") accounts skip the
  lookup and get `none`, so they can never cast a counting verdict. The HTTP
  client maps an unrecognized review state to `DISMISSED` and any non-`User` actor
  type (e.g. `Organization`) to `Bot`, so new GitHub values fail closed.
- **Bot eligibility** is computed with `classifyBotPr` (see
  [Bot-PR eligibility](bot-eligibility.md)) from the PR author, head ref,
  and whether the head is in a fork. The PR's commits are fetched only for a
  Dependabot PR from this repository, and its changed files only for a same-repo
  `release-please--` branch: the cases where they can change the answer
  (`bot-facts.ts`). The verdict, with its `reason`, is returned alongside the facts.
- **Branch updater.** A PR authored by `dependabot[bot]` is left to Dependabot
  (`updater: dependabot`) and never updated; see [Auto-update](#auto-update).
- **Dependabot rebasing** (`dependabotRebasing`) is read from the PR body
  already fetched, so it costs no extra request; it is `false` for any PR not
  authored by `dependabot[bot]`, since anyone can paste the notice into a body.
- **Escalation removals** (`escalationRemovals`) are the `unlabeled` issue events
  for `escalation needed`, each with its actor. They are read only when some
  review is an escalation verdict, the only case where they can change the answer
  (`escalation-facts.ts`; see
  [State](reconciler-design.md#state-in-priority-order)). A removal by a deleted
  account reads as a `Bot`, so it can't be trusted.
- **Force-pushes** (`forcePushes`) are the timeline's `HeadRefForcePushedEvent`s
  (GraphQL: the REST event names only the new head), each with the commit it
  made the head, the head it replaced, and its time. They are read only when
  some review is a verdict or a UAT sign-off label is present, since they can
  only stop one from counting (`force-push-facts.ts`; see
  [Verdicts](reconciler-design.md#verdicts) and [UAT labels](uat.md)). A push
  without a commit reads as unattributed, which fails closed.
- **UAT facts** (`uat-facts.ts`) are read only when `policy.uat` is set and the
  PR is open. The changed paths (a rename's old path included) are listed only
  when the title doesn't already exempt the PR, and a changed `package.json` is
  read at the merge base and the head only when every other path is exempt. The
  sign-off history is read only when `no UAT needed` or `UAT passed` is on the
  PR: the latest `labeled` event of each (its actor's permission looked up like
  a review author's), the title changes, and the first check suite on the PR's
  branch for the head and each carried commit. See [UAT labels](uat.md).
- **Pending bot reviewers** come from the PR's own `requested_reviewers`
  (entries of type `Bot`), so they cost no extra request.
- **Settle wait.** On the transition into `review-requested`, a PR opened or
  marked ready less than 30s ago is gathered again after the rest of that window,
  so a bot review request that lands a few seconds late is still seen. The last
  ready time comes from the issue events, read only on that transition
  (`settle.ts`; see
  [Waiting for bot reviewers](reconciler-design.md#waiting-for-bot-reviewers)).

## Execute

Writes happen in a **fail-safe order**: disarm auto-merge → remove labels → add
labels → arm (or merge) → update. If a run dies partway, auto-merge is never
left armed on a PR that isn't approved, arming happens only after the labels that
explain it are written, and the update, which moves the head, comes last.

- **Tolerated errors.** Removing a label that's already gone (404) and creating a
  label that already exists (422, e.g. from a concurrent run) both mean the goal
  state is reached. An arm or merge that loses the [merge-state race](#the-merge-state-race)
  twice is deferred, not failed. Every other error propagates. A failed run is safe to retry,
  because the next event recomputes from facts.
- **UAT labels are written by the real actor.** Adds and removals of the four
  UAT labels go through `UatLabelWrites` (`options.uatWrites`, the release token
  in the CLI), so pr-policy sees a person's sign-off and gets a `labeled` run.
  `uatWrites: 'unavailable'` applies `withoutUatWaiver`: the other UAT labels are
  written with the main client, `no UAT needed` is never applied, and the skip
  is reported as `skippedUatWaiver` (see [UAT labels](uat.md#real-actor-token)).
- **Missing labels.** Before adding labels, the repo's labels are listed once, and
  any owned label the repo lacks is created from the fleet roster definition
  (`label-roster.ts`), so a consumer that hasn't seeded the roster still gets
  correctly colored labels. An existing label is never modified.
- An empty plan makes **no** API calls.

## Arming and merging

- **Merge or arm.** The plan says `merge` for an approved PR GitHub would merge
  right now and `arm` otherwise (see [Plan](reconciler-design.md#plan)), matching
  `gh pr merge --auto`. Both are squash.
- **Bound to the planned head.** Both mutations pass `expectedHeadOid` = the head
  the plan was computed for. If a commit lands mid-run, GitHub rejects the merge
  or arm instead of merging an unreviewed commit, and the error is not retried.
- **Fallbacks for the merge-state race.** Arming and merging each fall back to
  the other once, bound to the same head; see
  [The merge-state race](#the-merge-state-race).
- **A real-actor token.** A merge made with `GITHUB_TOKEN` triggers no `on: push`
  workflows (releases, CI on `main`). So arming, merging, and [updating](#auto-update) go through `ReleaseActions`
  (`enableAutoMerge`, `mergePullRequest`, `updateBranch`),
  a client built from a separate release token that is never used for anything
  else but UAT label writes, reads included. Disarming (`disableAutoMerge`) goes through it too: GitHub
  refuses the disarm from a workflow token with only `contents: read`
  (`Resource not accessible by integration`), so the actor that armed the PR
  disarms it.
  `reconcilePullRequest` takes it as `options.release`, defaulting to the main
  client, which is right when that token is itself a real actor.
- **No release token.** `release: 'unavailable'` applies `withoutReleaseActions`
  to the plan: labels converge, the arm, merge, or update is skipped (reported as
  `skippedAutoMerge` / `skippedUpdate`), and a disarm is still attempted with the
  main client. Arming, merging, and updating never fall back to the main token: a
  stub that refuses those calls stands in, so a regression fails loudly instead. The CLI's handling (a warning and an advisory comment) is in
  [the CLI](cli.md#release-token).

### The merge-state race

GitHub has no atomic "merge if mergeable, else arm": arming a PR that is already
mergeable fails (_"Pull request is in clean status"_, or _unstable status_ when
only non-required checks are failing or pending), and merging one whose
required checks haven't finished fails (_"Required status check … is queued"_,
or _expected_, _pending_, _in progress_). The plan chooses from the merge state
it read, and that state can change before the write, often because of the run's
own label writes: a consumer's merge-safety workflow runs on `labeled` and
`unlabeled`, so writing `approved` queues a fresh required `merge-safety` check
before the merge (rmartz/hidden-role-game#988).

- **Each falls back to the other once.** A refused arm is retried as a merge, and
  a merge refused for a pending required check is retried as an arm. Exactly one
  of the two always applies to a PR's current state, so the fallback succeeds
  unless the state flips again in between.
- **A second loss defers.** If the fallback is refused for its own race reason,
  the run stops there without error, reports the action as deferred
  (`autoMergeDeferred` in the [CLI's JSON](cli.md#output)), and leaves it to
  the next event: the check finishing, a review, or a push. A deferred PR keeps
  any planned update, which moves the head and re-triggers the reconcile.
- **Narrow on purpose.** Only those two refusals count. A failed required check, a
  moved head, a permission error, or anything else propagates and is never
  retried, so the fallback can't arm a PR on a red check or merge an unreviewed
  commit.
- **What was done is reported.** `executePlan` returns the action actually taken.
  The result's `autoMerge` (and the CLI's) can differ from the plan's: `arm` for a
  planned merge, `merge` for a planned arm, `none` when deferred. A merge, planned
  or by fallback, skips any update.
- **No `merge-safety` re-trigger.** Callers don't list `merge-safety` in
  `workflow_run`. Merge-safety re-runs on every label event and on each push to
  the base, so that would roughly double the reconcile runs, and with the
  fallbacks only a double flip within one run is left for the next event to
  settle.

## Auto-update

When the plan says `update` (see [Plan](reconciler-design.md#plan)):

- **`update-branch`** calls `PUT /pulls/{n}/update-branch` with
  `expected_head_sha` = the planned head. A 422 (the head moved, or the base has
  nothing new) is a no-op: the push that caused it triggers a fresh run. Any
  other error propagates.
- **A Dependabot PR is never updated.** `update-branch` would put a foreign
  commit on its branch, which permanently breaks Dependabot's own rebasing. Asking
  doesn't work either: Dependabot refuses `@dependabot rebase` from a GitHub App
  (_"Sorry, only users with push access can use that command"_). It refused every
  request in the 2026-10 rollout pilots (rmartz/pr-lifecycle#97,
  rmartz/hidden-role-game#985 and #986, rmartz/personal-budget#559–#561), while
  the same command from a person worked. So an approved Dependabot PR flagged
  `update required` stays as it is: a person comments `@dependabot rebase` (or
  `recreate`), or Dependabot rebases it on its own (it does so on a conflict). The
  rebase is a new head, and the PR is reconciled from there. A clean rebase keeps
  the approval ([Rebased heads](approval-carry-over.md#rebased-heads)).
- **Afterwards.** [Carry-over](approval-carry-over.md) keeps the
  PR `approved` across the verified clean merge, CI runs on the new head (it was
  pushed by a real actor), merge-safety clears `update required`, and armed
  auto-merge lands the PR once required checks pass.
