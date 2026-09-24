---
type: Design
title: Lifecycle routing design (v2)
description: The planned extension of the reconciler that resolves simple merge blockers itself, routes statically detectable problems to fix, and sends everything else to review — what is built (CI gate, merge-conflict and base-health states, approval carry-over) and what remains (the auto-update action).
tags: [reconciler, design, ci, routing, auto-update, security]
---

# Lifecycle routing design (v2)

**Status: partly built.** The CI gate, the merge-conflict and base-health states,
and approval carry-over are implemented, and their rules live in the
[core design](reconciler-design.md). This page now covers only what remains:
the auto-update action. When a piece lands, move
its rules into the core design and trim it from here.

## Goal

1. **Resolve simple merge blockers automatically.** An approved PR that only
   needs a base update gets updated.
2. **Route statically detectable problems to a fix.** Merge conflicts and failing
   CI go straight to fix-review, with no review cycle spent on them. **Built.**
3. **Send everything else to review**, so an agent decides between approve, fix
   and escalate.

## Decisions

- **CI is a gate.** This deliberately reverses ai-tools#306 constraint 4
  ("never inspects any check"). **Built** (#20): see the core design's
  [CI gate](reconciler-design.md#ci-gate).
- **Approvals carry over a clean base update** under a content-verified rule.
  **Built** (#22): see the core design's
  [Approval carry-over](reconciler-design.md#approval-carry-over).
- **New lifecycle labels** `fix required` and `ci failing` are **built**; they
  join the fleet roster via rmartz/dotfiles#1573. `merge conflict` stays
  merge-safety's label and is not owned here.

## How the remaining pieces plug into the state order

Both extend existing rules in the core's
[state order](reconciler-design.md#state-in-priority-order) rather than adding
new states:

- **Carry-over** (built) widens rule 6 ("counting verdict") and the Copilot gate.
- **Auto-update** adds an action to `approved` (rules 6 and 7): update the branch
  when merge-safety has flagged `update required`.

## Approval carry-over (built)

Built in #22; the rules now live in the core design's
[Approval carry-over](reconciler-design.md#approval-carry-over) section. Auto-update
relies on it: without carry-over, every update would drop the approval and cost a
full review cycle.

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
  run on the new head, and GitHub's auto-merge would wait forever on required
  checks that never report.
- **After the update:** the carry-over rule keeps `approved` (the update is a
  verified clean merge), CI runs on the new head, merge-safety clears
  `update required`, and armed auto-merge lands the PR once required checks pass.

## Implementation issues

Each issue lists its dependencies; see the **Reconciler v1** milestone.

| Piece                                                                 | Issue                                               | Depends on   |
| --------------------------------------------------------------------- | --------------------------------------------------- | ------------ |
| CI gate: `awaiting-ci` / `ci failing` / `blocked-base-red` (**done**) | #20                                                 | —            |
| Merge-conflict state (**done**)                                       | #21                                                 | —            |
| Approval carry-over across clean base updates (**done**)              | #22                                                 | #20          |
| Auto-update approved PRs flagged `update required`                    | #23                                                 | #7, #22, #20 |
| `fix required` / `ci failing` in the fleet roster                     | rmartz/dotfiles#1573 (roster + coordinator routing) | —            |
