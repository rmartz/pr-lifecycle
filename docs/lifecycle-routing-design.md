---
type: Design
title: Lifecycle routing design (v2)
description: The planned extension of the reconciler that resolves simple merge blockers itself, routes statically detectable problems to fix, and sends everything else to review — the CI gate, merge-conflict and base-health states, approval carry-over across clean base updates, and the auto-update action.
tags: [reconciler, design, ci, routing, auto-update, security]
---

# Lifecycle routing design (v2)

**Status: agreed design, not yet implemented.** It extends the
[core design](reconciler-design.md); the implementing issues are linked at the end.
When a piece lands, move its rules into the core design and trim them from here.

## Goal

1. **Resolve simple merge blockers automatically.** An approved PR that only
   needs a base update gets updated.
2. **Route statically detectable problems to a fix.** Merge conflicts and failing
   CI go straight to fix-review, with no review cycle spent on them.
3. **Send everything else to review**, so an agent decides between approve, fix
   and escalate.

## Decisions

- **CI becomes a gate.** This deliberately reverses ai-tools#306 constraint 4
  ("never inspects any check"). Review is requested only once CI is green on the
  head.
- **Approvals carry over a clean base update** under a content-verified rule
  (below). It is conservative by design: anything it can't prove identical goes
  back to review.
- **New lifecycle labels:** `fix required` (a statically detected problem, as
  distinct from a reviewer's `changes requested`) and `ci failing` (the reason).
  `merge conflict` stays merge-safety's label and is not owned here. Both new
  labels join the fleet roster.

## New facts

| Fact             | Source                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------- |
| `mergeable`      | PR `mergeable`: `true`, `false` (conflict), or unknown (`null`: GitHub still computing) |
| `ciStatus`       | Required checks on the head, minus gate checks (below): `passing`, `failing`, `pending` |
| `baseCiFailing`  | The same required, non-gate checks are failing on the base branch head                  |
| `updateRequired` | merge-safety's `update required` label (selective, unlike GitHub's "behind")            |
| verdict lineage  | For a stale verdict on `A`: whether `A → head` is a chain of verified clean base merges |

### What counts as CI

**CI = the base branch's required checks** (read from its rulesets, as
merge-safety does), **minus a configurable list of gate checks**. The default
list is `merge-safety`, the UAT check (#8) and pr-policy's checks. Gates such as
merge-safety and pr-policy are moving to report **Pending** while they wait
(e.g. for UAT sign-off), so without the exclusion "CI finished" would never be
true. Gates and CI jobs can't be told apart from GitHub's data (both are
check-runs from Actions), so the list is explicit.

- **Any failure is immediate.** One failing non-gate check (`failure`,
  `cancelled`, `timed_out`, `action_required`) means `failing`, even if others
  are pending.
- **Pending blocks only success.** `pending` while any non-gate required check is
  queued or running, or hasn't reported yet.
- A check whose `completed_at` is set but whose status lags as `in_progress` is
  treated as concluded (the status-stale case the coordinator already handles).

## States, in priority order

| #   | Condition                                                     | State              | Label(s)                                               | Action                                                                                                 |
| --- | ------------------------------------------------------------- | ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 1   | closed / merged                                               | `closed`           | untouched                                              | —                                                                                                      |
| 2   | draft / `[WIP]`                                               | `draft`            | none                                                   | disarm                                                                                                 |
| 3   | `mergeable` is `false`                                        | `fix-required`     | `fix required` (+ merge-safety's `merge conflict`)     | disarm                                                                                                 |
| 4   | `ciStatus` is `failing` and `baseCiFailing`                   | `blocked-base-red` | none                                                   | disarm                                                                                                 |
| 5   | `ciStatus` is `failing`                                       | `fix-required`     | `fix required`, `ci failing`                           | disarm                                                                                                 |
| 6   | `ciStatus` is `pending`                                       | `awaiting-ci`      | none                                                   | disarm, **unless** an approval counts for the head (directly, or carried over by carry-over rules 1–2) |
| 7   | counting verdict (on head, or carried over by a clean update) | per verdict        | `approved` / `changes requested` / `escalation needed` | arm if approved; **update** if approved and `updateRequired`                                           |
| 8   | eligible bot PR                                               | `approved`         | `approved`                                             | arm; update if `updateRequired`                                                                        |
| 9   | Copilot reviewed head, or `skipCopilotReview`                 | `review-requested` | `review requested`                                     | —                                                                                                      |
| 10  | otherwise                                                     | `awaiting-copilot` | none                                                   | —                                                                                                      |

**`awaiting-ci` must not simply "hold" auto-merge.** If an armed, approved PR
gets an unreviewed push, holding would leave auto-merge armed, and GitHub would
merge the unreviewed commit as soon as CI passed. So `awaiting-ci` disarms unless
an approval still counts for the head: bound to it directly, or carried over by a
verified clean base update (carry-over rules 1–2, which don't depend on CI). A
carried approval may stay armed, because GitHub still waits for required CI
before merging.

Rule 3 (merge conflict) is **implemented** (#21); its full rule, including the
unknown-`mergeable` handling, now lives in the
[core design](reconciler-design.md#state-in-priority-order). A red base (rule 4) is held rather than
routed to a fix: fix-review can't fix something outside the PR, and merge-safety
already holds merges while the base is red.

## Approval carry-over across a clean base update

Head binding makes any push drop the approval, so without a carry-over rule every
auto-update would cost a full review cycle. The rule is content-based;
**provenance is deliberately not used**. GitHub's `web-flow` committer also signs
web-editor conflict resolutions and file edits, so "GitHub made this commit" does
not mean "clean".

A verdict on commit `A` also counts for head `H` when every commit on the
first-parent chain from `A` to `H` is a **verified clean base merge**:

1. It is a merge commit with exactly two parents. The first parent is the
   previous commit in the chain (starting from `A`), and the second parent `B` is
   reachable from the base branch head.
2. **Its tree is byte-identical to the automatic merge**, recomputed
   independently: `git merge-tree --write-tree --merge-base=<merge-base> <prev> <B>`
   must report no conflicts and produce exactly the commit's tree. The objects are
   fetched as git data only; no PR code runs.
3. Required CI is green on `H`, which is already implied by the state order
   (rules 5 and 6 come before 7).

Rule 2 is what makes this safe. Any extra edit, hand-resolved conflict or reverted
base change produces a different tree and fails. That was verified empirically
during design: a clean merge where both sides edited the same file matched
exactly, while a merge with identical parents and message plus one sneaked-in line
did not. It fails safe: if git's merge algorithm ever disagrees with GitHub's, the
result is an extra review, never a false approval. A clean merge made locally
qualifies too, since provenance doesn't matter.

Rule 3 covers what rule 2 can't: a textually clean merge that breaks semantically
(the risk merge-safety's `update required` exists to re-test) is caught by CI.
A semantic break that CI doesn't catch is the accepted residual risk, the same one
a merge queue takes.

## The auto-update action

When the state is `approved` and merge-safety has flagged `update required`, the
reconciler updates the branch:

- **Regular PRs:** `PUT /pulls/{n}/update-branch` with `expected_head_sha` set to
  the head it evaluated, so a concurrent push makes it a no-op rather than a race.
- **Dependabot PRs:** comment `@dependabot rebase` instead, unless a rebase is
  already in progress. `update-branch` on a Dependabot branch adds a foreign
  commit that permanently breaks Dependabot's own rebasing.
- **Token:** the update must be pushed with a **real-actor token** (#7), never
  `GITHUB_TOKEN`. A `GITHUB_TOKEN` push triggers no workflows, so CI would never
  run on the new head and the PR would sit in `awaiting-ci` forever.
- **After the update:** CI runs on the new head. The carry-over rule restores
  `approved` once CI is green, merge-safety clears `update required`, and armed
  auto-merge lands the PR.

## Implementation issues

Each issue lists its dependencies; see the **Reconciler v1** milestone.

| Piece                                                      | Issue                                          | Depends on                  |
| ---------------------------------------------------------- | ---------------------------------------------- | --------------------------- |
| CI gate: `awaiting-ci` / `ci failing` / `blocked-base-red` | #20                                            | —                           |
| Merge-conflict state (**done**)                            | #21                                            | —                           |
| Approval carry-over across clean base updates              | #22                                            | (#20 before production use) |
| Auto-update approved PRs flagged `update required`         | #23                                            | #7, #22, #20                |
| `fix required` / `ci failing` in the fleet roster          | rmartz/dotfiles (roster + coordinator routing) | —                           |
