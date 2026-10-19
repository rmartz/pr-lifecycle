---
type: Design
title: Reconciler core design
description: How the pure reconciler core turns a PR's facts into a lifecycle state, a minimal label plan, an auto-merge action, and a branch update — the fact model, trust rules, state priority, and the properties the tests guarantee.
tags: [reconciler, design, labels, auto-merge, security]
---

# Reconciler core design

The core is a **pure function**: `planReconcile(facts, policy)` returns the PR's
lifecycle state plus the label, auto-merge, and branch-update changes that
converge the PR to it.
It performs no I/O. A separate edge layer gathers the facts from GitHub and applies
the plan. Because the output depends only on current facts, never on the event
that triggered the run, replaying, reordering or dropping events cannot drive a PR
into a wrong state.

Source: `src/` (`facts.ts`, `verdict.ts`, `head-binding.ts`, `state.ts`, `plan.ts`).

## Facts

| Fact                   | Source (edge layer)                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`               | PR `state` / `merged`: `open`, `closed`, or `merged`                                                                                          |
| `isDraft`, `title`     | PR fields; a `[WIP]` title (any case) is treated like a draft                                                                                 |
| `headSha`              | PR `head.sha`                                                                                                                                 |
| `labels`               | current label names                                                                                                                           |
| `autoMergeEnabled`     | PR `auto_merge` is non-null                                                                                                                   |
| `botEligible`          | [bot-PR eligibility](bot-eligibility.md): same-repo Dependabot patch/minor, release-please pure release                                       |
| `mergeable`            | PR `mergeable`: `true`, `false` (merge conflict), or unknown (`null` → `undefined`: still computing)                                          |
| `immediatelyMergeable` | PR `mergeable_state` is `clean`, `has_hooks`, or `unstable`: GitHub would merge now, so auto-merge can't be armed                             |
| `ciStatus`             | [CI gate](#ci-gate) over the head's required checks: `passing`, `failing`, or `pending`                                                       |
| `baseCiFailing`        | the same required checks are failing on the base branch head (fetched only when `ciStatus` is `failing`)                                      |
| `cleanAncestors`       | commits whose reviews carry over to the head (see [Approval carry-over](approval-carry-over.md)); verified at the edge                        |
| `cleanRebaseSources`   | reviewed commits a force-push removed, whose reviews carry over (see [Rebased heads](approval-carry-over.md#rebased-heads)); verified at edge |
| `updater`              | `dependabot` for a PR opened by `dependabot[bot]` (it rebases its own branch), else `github` (`update-branch`)                                |
| `dependabotRebasing`   | Dependabot PRs only: the PR body carries Dependabot's own rebasing or recreating notice; a rebase request doesn't count                       |
| `reviews`              | PR reviews: author login, type (`User`/`Bot`), repo permission, `commit_id`, state, body, submitted time                                      |
| `forcePushes`          | `head_ref_force_pushed` issue events: the commit each made the head, and when (read only when some review is a verdict)                       |
| `pendingBotReviewers`  | PR `requested_reviewers` entries of type `Bot` (Copilot appears as `Copilot`); users and teams are left out                                   |

The author's **repo permission** is a fact gathered at the edge (the collaborator
permission API), so trust evaluation stays pure.

## Verdicts

The `/review` marker's `skill`, `outcome`, and `pr_head` fields are a contract
with the agent tooling that writes them, documented on that side in
rmartz/dotfiles `docs/scripts/skill-meta.md`. Change both sides together.

A `DISMISSED` review (revoked by a maintainer) or `PENDING` review (never
submitted) is **never** a verdict, whatever its body says. Dismissing is how a
maintainer revokes an approval, so a marker must not outlive it. Otherwise, a
review is a **verdict** when either:

- its body carries a `skill-meta` marker with `"skill": "review"`. The marker's
  `outcome` is the verdict: canonically `approved`, `blocked`,
  `changes-requested`, or `escalation-needed`. `blocked` means the change is
  ready but waits on another PR or issue. It is a hold that the next `/review`
  replaces when that ref closes, never an escalation. The legacy spelling
  `changes requested` in older markers is still read as `changes-requested`. A
  `skipped` outcome is **not** a verdict: `/review`
  deliberately did nothing. Any other outcome fails closed to
  `escalation-needed`, including a missing or non-string one. An unreadable
  `/review` verdict must never let an earlier approval stand, so a human looks
  at it. The marker stays authoritative in every case, and the review never
  falls back to its native state. Or:
- it has no such marker and its native state is `APPROVED` or `CHANGES_REQUESTED`.

The marker wins over the native state. A self-authored verdict is posted as a
`COMMENTED` review, so the marker is the only place its verdict lives.

Review bodies are attacker-controlled, so marker parsing must stay
**linear-time**. It finds the opening with a regex that has no overlapping
quantifiers, then scans to `-->` with `indexOf`. A one-regex
`<!--\s*skill-meta:\s*(.*?)\s*-->` backtracks cubically, and a malicious comment
could stall the reconcile job (CodeQL `js/polynomial-redos`). A timing test
guards against a regression.

A verdict **counts** only when all of the following hold:

1. **Trusted author.** The author is a `User` (never a `Bot`) with `write`,
   `maintain`, or `admin` permission, and, when `policy.trustedAuthors` is set,
   their login is on that list (case-insensitive). The marker never contributes
   trust: anyone can write one into a comment. This boundary grants no new
   privilege, because a write-permission user can already merge a PR once its
   required checks pass.
2. **Bound to the current head.** The commit the review covered (the marker's
   `pr_head` when it names one, else the review's `commit_id`) is the head, a
   [clean ancestor](approval-carry-over.md), or a
   [clean rebase source](approval-carry-over.md#rebased-heads). When the marker names a different commit
   than `commit_id`, it counts only if the marker's commit is a clean ancestor or
   rebase source. A marker can never claim the head for a review GitHub bound to
   another commit. A verdict on any other commit never counts, so a real push
   after approval un-approves the PR without extra logic.
   **A review GitHub moved by a force-push binds only through its marker.**
   GitHub moves an `APPROVED` review's `commit_id` onto the new head when a
   force-push leaves the PR's diff unchanged, for example a clean rebase such as
   `@dependabot rebase`. A `COMMENTED` review, or a push that changes the diff,
   keeps its original commit. A moved review reads as bound to a commit its
   author never saw, so its `commit_id` can't bind it at all. A review counts as
   moved when a force-push to its commit happened at or after it was submitted.
   It then counts only when its marker's `pr_head` names a verified
   [clean rebase source](approval-carry-over.md#rebased-heads) (or clean ancestor), never the head. A
   native approval has no marker, so a moved one is inert: without this rule it
   would survive the rebase and stay armed on a new combination of code that
   nobody reviewed. The rule fails closed. A push GitHub didn't name the commit
   of, or a review with no readable submission time, counts as moved. A commit
   force-pushed away and then back drops the reviews made before it came back.

The **latest** counting verdict (by submitted time, then review id) decides.

## State, in priority order

| #   | Condition                                                               | State                 | Lifecycle label              |
| --- | ----------------------------------------------------------------------- | --------------------- | ---------------------------- |
| 1   | status is `closed` or `merged`                                          | `closed`              | untouched (no plan)          |
| 2   | the `escalation needed` label is present (sticky, however applied)      | `escalation-needed`   | `escalation needed`          |
| 3   | draft, or `[WIP]` title                                                 | `draft`               | none                         |
| 4   | `mergeable` is `false` (merge conflict)                                 | `fix-required`        | `fix required`               |
| 5   | `ciStatus` is `failing` and `baseCiFailing`                             | `blocked-base-red`    | none                         |
| 6   | `ciStatus` is `failing`                                                 | `ci-failing`          | `fix required`, `ci failing` |
| 7   | counting verdict `approved`                                             | `approved`            | `approved`                   |
| 7   | counting verdict `blocked`                                              | `blocked`             | `blocked`                    |
| 7   | counting verdict `changes-requested`                                    | `changes-requested`   | `changes requested`          |
| 7   | counting verdict `escalation-needed`                                    | `escalation-needed`   | `escalation needed`          |
| 8   | `botEligible`                                                           | `approved`            | `approved`                   |
| 9   | `ciStatus` is `pending`                                                 | `awaiting-ci`         | none                         |
| 10  | a bot review is requested and not yet submitted (`pendingBotReviewers`) | `awaiting-bot-review` | none                         |
| 11  | otherwise                                                               | `review-requested`    | `review requested`           |

**A present `escalation needed` label is sticky and outranks everything but
`closed`.** The label is itself the escalation, whoever applied it: a `/review`
`escalation-needed` verdict, a `/merge` hard-reject, or a person holding the PR
by hand. The reconciler keeps it and never removes it, even after a push
invalidates the verdict that added it, and no verdict, green CI, or bot
eligibility can approve or arm the PR while it is present. Only a person or a new
`/review` verdict (which replaces the verdict labels) clears it, by removing the
label; the next reconcile then computes the state from the facts as usual.

**Removing the label resolves an escalation verdict.** People resolve an
escalation by removing `escalation needed` once the problem is addressed; they
don't post verdicts. So an `escalation-needed` verdict stops counting once a
**trusted** actor removes the label after it was posted. That is the same rule as
for a verdict author: a `User` with `write`, `maintain` or `admin`, narrowed by
`trusted-authors`. Otherwise the verdict would re-apply the label on the next
reconcile.

- The PR then has no counting verdict, so it goes back to `review requested`, or
  to `approved` if it is an eligible bot PR. The approvals the escalation
  superseded stay superseded: a removal never approves a human-authored PR by
  itself.
- A removal by a bot or a non-writer doesn't count, so the label comes back.
- So does a removal in the same instant as the post, because
  `post-review-verdict.py` may clear a stale label while posting a fresh
  escalation.
- An escalation posted after the removal counts as usual.

The removals are read from the PR's issue events, and only when some review is an
escalation verdict.

**A merge conflict outranks every verdict.** It needs a code change, and the
resolution is a new commit that no approval could survive anyway, so an approved
PR that develops a conflict loses `approved` and is disarmed. `fix required`
(a statically detected problem) is deliberately distinct from `changes requested`
(a reviewer's verdict): it tells fix-review there are no review threads to work
from. merge-safety's own `merge conflict` label, if present, says why; it isn't
owned here. An unknown `mergeable` (GitHub computes it lazily, and `null` means
"not yet") is **not** a conflict: the rule doesn't fire, and the next event
re-evaluates.

**Failing CI outranks every verdict; pending CI only gates the no-verdict path.**
Failing CI needs a fix (a new commit), so like a conflict it drops `approved` and
disarms. A PR failing _because its base is red_ (the same required checks fail on
the base head) is `blocked-base-red` instead, which is held with no label: the fix
isn't in the PR, and merge-safety already holds merges while the base is red.
Pending CI comes **after** verdicts, and that ordering is the safety mechanism:

- an **approved** PR (or eligible bot PR) with CI running stays `approved` and
  armed. That's safe, because GitHub's auto-merge itself waits for required
  checks, and it avoids flapping `approved` whenever CI re-runs;
- a PR with **no** counting verdict and CI running is `awaiting-ci`, so review is
  requested only once CI is green. This includes the dangerous case, an
  unreviewed push onto an armed, approved PR: the approval is stale, so the PR
  lands here, is not `approved`, and is **disarmed**. Otherwise GitHub would merge
  the unreviewed commit as soon as CI passed.

`awaiting-ci` deliberately carries **no label**. Every push to an unapproved PR
removes `review requested` and puts it back once CI on the new head is green, a
flicker of a few seconds on a fast CI. That is intended: a label is only ever
present for a state the current head has reached, so no lifecycle label is left
describing a head that is still being evaluated. Don't "fix" it by keeping a
label through pending CI; that would make labels an input, as only
`escalation needed` is.

### CI gate

`ciStatus` (`src/ci.ts`) covers the base branch's **required checks** (the union
across every active ruleset on the branch; with none required, the gate is
inactive and CI is `passing`). A private repo on GitHub Free can't use rulesets,
and the rules API answers `403 "Upgrade to GitHub Pro…"`. That specific
plan-limitation answer means "no required checks". Any other error, including a
403 for missing token permissions, fails the run loudly rather than silently
switching the gate off. Each check-run and commit status is normalized:

- `success` / `neutral` / `skipped` → passed;
- `failure` / `cancelled` / `timed_out` / `action_required` / `startup_failure` →
  failed;
- anything else → running, including `stale`, an unrecognized conclusion, and a
  completed run with no conclusion (never a pass). A run whose status still reads
  in-progress but whose `completed_at` is set is judged by its conclusion (GitHub
  sometimes leaves the status stale).

**Any** counted failure makes CI `failing` immediately, even with others still
running. Otherwise, any counted check still running, or not reported at all,
makes it `pending`. Two policy lists adjust what "counted" means:

| List                                | Pending means                  | Failure means    | Default        |
| ----------------------------------- | ------------------------------ | ---------------- | -------------- |
| `holdChecks` (`--hold-checks`)      | a hold on a human act: ignored | counts (fixable) | `pr-policy`    |
| `ignoredChecks` (`--ignore-checks`) | ignored                        | ignored          | `merge-safety` |

pr-policy reports **pending** while waiting on a sign-off and **fails** for
fixable problems such as a bad title, so it's a hold check: a sign-off wait must
not look like CI still running, but a fixable failure should route to a fix.
merge-safety currently fails for "update needed" and "base is red", which other
states handle, so it's ignored. Once it reports Pending instead, as planned, it
can become a hold check.

A trusted human verdict outranks bot eligibility, so a person can hold a
Dependabot PR with a `changes requested` verdict.

### Waiting for bot reviewers

Rule 10 lets automated reviewers (Copilot) comment before `review requested` sends
the PR to review. It waits on a **pending request**, not on a review having
arrived, because a request is the only reliable sign that a review is coming:

- Copilot's ruleset auto-review records a request (`Copilot`, type `Bot`) within
  seconds of a PR opening, and submitting the review clears it.
- When Copilot won't review, **no request is made at all**: out of monthly quota
  (it shows a UI-only notice and nothing reaches the API), in a repo without
  Copilot code review, or on a Dependabot PR (Copilot never reviews those).
- Copilot doesn't re-review after a push (`review_on_push` is off), so a review of
  an earlier commit must not be required either.

Waiting for a review instead stranded all three cases in the wait forever (#36).
Only **bots** are waited on: a request to a person or team never holds the PR,
because it would block the review agent behind someone who may never respond.
Anyone with triage permission can request a reviewer, so a request can only hold a
PR back from `review-requested`; it never changes any other state (a tested
property).

`policy.skipCopilotReview` skips the wait. It is deprecated, since the wait now
ends on its own, and kept so existing callers keep working.

**The settle wait.** The request lands a few seconds after the PR opens (0–5s
across 267 fleet PRs), so a run reading the PR sooner would see no request and
move on. On the transition into `review-requested` (the label isn't on yet), the
edge layer waits until the PR has been reviewable, since it was opened or last
marked ready, for 30s (`ReconcileOptions.settle`), then gathers again and plans
from the fresh facts (`src/github/settle.ts`). It waits **inside the run** rather
than staying put for a later event: when no bot is coming, no later event is
guaranteed to fire (a PR marked ready after its CI finished gets none), so
"wait for the next event" would strand exactly the PRs this rule exists to free.
A request that still arrives later fires `review_requested`, and the next run
moves the PR back to `awaiting-bot-review`.

## Approval carry-over

Head binding makes any push drop an approval. Carry-over keeps a review counting
when the head's content is verifiably what was reviewed: a chain of clean base
merges, or a clean rebase after a force-push. The rules and their safety
properties are on their own page: [Approval carry-over](approval-carry-over.md).

## Plan

- **Labels are output only**, with one exception: `escalation needed` is also an
  input. The core never removes a present one, and a trusted person
  removing it resolves an escalation verdict (see [State](#state-in-priority-order)). The core owns the seven lifecycle labels
  (`approved`, `blocked`, `changes requested`, `escalation needed`,
  `fix required`, `ci failing`, `review requested`), [`dependabot rebasing`](#dependabot-rebasing-label),
  and, in arming mode, `auto-merge enabled`. It adds the desired ones and removes every
  other owned label present, so a hand-applied `approved` with no verdict behind
  it is removed. Labels the core doesn't own are never touched. When the labels
  already match, the plan is empty.
- **Auto-merge (opt-in via `policy.armAutoMerge`, default off).** When the state
  is `approved` and auto-merge is off, the core plans `merge` if the PR is
  `immediatelyMergeable` (GitHub refuses to arm a PR that is already mergeable;
  this mirrors `gh pr merge --auto`) and `arm` otherwise. It disarms when the
  state is anything else and auto-merge is on. A direct merge doesn't claim
  `auto-merge enabled`. With arming off, auto-merge is never touched and
  `auto-merge enabled` isn't owned.
- **Auto-update (opt-in via `policy.autoUpdate`, default off).** When the state
  is `approved` and merge-safety's `update required` label is present (read,
  never written), the plan's `update` is `update-branch`. A Dependabot PR is
  **never** updated: a foreign commit permanently breaks its rebasing, and
  Dependabot refuses `@dependabot rebase` from a GitHub App, so a person or
  Dependabot itself rebases it (see [Auto-update](github-edge-layer.md#auto-update)).
  A clean rebase keeps the approval through [rebase carry-over](approval-carry-over.md#rebased-heads).
  No update is planned for a PR being merged in the same pass, or without the
  label: absent merge-safety there is no auto-update. The update keeps the
  approval through [carry-over](approval-carry-over.md); see
  [Auto-update](github-edge-layer.md#auto-update) for how it's executed.
- **`withoutReleaseActions(plan)`** strips an `arm` or `merge` (and the
  `auto-merge enabled` it would add) and any `update`, and keeps everything else,
  a disarm included. The edge layer applies it when no real-actor token is
  available (see [GitHub edge layer](github-edge-layer.md#arming-and-merging)).
- A `closed` PR yields an empty plan: its final labels stay as the audit record.

### Dependabot rebasing label

`dependabot rebasing` is present exactly while `dependabotRebasing` is true on a
Dependabot PR, whatever the lifecycle state, so workflows can hold off while the
branch is about to be force-pushed. Dependabot adds its notice to the PR body when
a rebase or recreate starts and removes it when done; both edits fire
`pull_request: edited`, so a consumer that reconciles on `edited` converges the
label both ways.

- **Only Dependabot's notice counts**, not a `@dependabot rebase` request: if
  Dependabot replies with an error instead of rebasing, a label raised on the
  request would never clear.
- **A stalled rebase keeps the label.** Dependabot sometimes leaves the notice in
  place indefinitely; the label then stays, accurately. A person clears it with
  `@dependabot rebase` or `recreate`.
- **Read it, don't trigger on it.** A label written with `GITHUB_TOKEN` fires no
  `labeled` workflows (see [overview](overview.md)), so gate on the label's
  presence when a workflow runs rather than on its being added.
- The recreating notice's wording (`Dependabot is recreating this PR`) mirrors the
  rebasing one and hasn't been seen on a live PR yet; if it differs, recreates
  simply don't raise the label.

## Guaranteed properties (tested)

- **Idempotent.** Applying a plan and re-planning yields an empty plan.
- **Order-independent.** Permuting the review list never changes the result.
- **Untrusted input is inert.** Adding any number of untrusted or stale reviews,
  including ones with forged `approved` markers, never changes the state.
- **Scoped writes.** A plan never adds or removes a label outside the owned set.
- **The rebasing label mirrors Dependabot.** On an open PR, `dependabot rebasing`
  is present after a plan exactly when Dependabot says it is rebasing its own PR.
- **No unapproved armed PR.** In arming mode, an armed open PR that isn't
  `approved`, whatever its CI, conflict or review state, is always disarmed, and
  a PR is only ever armed or merged when `approved`.
- **Updates are approved-only and never touch Dependabot.** An `update` is only
  ever planned for an `approved` PR, and never for a Dependabot PR.
- **`withoutReleaseActions` removes release actions and nothing else.** No arm,
  merge, update, or `auto-merge enabled` survives it; every other change, a
  disarm included, does.
- **Carry-over grants nothing new.** A review on a clean ancestor or clean rebase
  source counts exactly as if the same reviewer had posted it on the head.
- **A moved review counts only through a verified marker.** A review on the head
  that predates a force-push to the head plans exactly as if it weren't there,
  unless its marker names a verified clean rebase source.
- **A review request only holds.** A pending bot request can move a PR from
  `review-requested` to `awaiting-bot-review` and changes no other state.
