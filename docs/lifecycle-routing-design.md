---
type: Design
title: Lifecycle routing design (v2)
description: The planned extension of the reconciler that resolves simple merge blockers itself, routes statically detectable problems to fix, and sends everything else to review — what is built (CI gate, merge-conflict and base-health states) and what remains (approval carry-over across clean base updates, and the auto-update action).
tags: [reconciler, design, ci, routing, auto-update, security]
---

# Lifecycle routing design (v2)

**Status: partly built.** The CI gate and the merge-conflict and base-health
states are implemented, and their rules live in the
[core design](reconciler-design.md#state-in-priority-order). This page now covers
only what remains: approval carry-over and auto-update. When a piece lands, move
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
- **Approvals carry over a clean base update** under a content-verified rule
  (below). It is conservative by design: anything it can't prove identical goes
  back to review.
- **New lifecycle labels** `fix required` and `ci failing` are **built**; they
  join the fleet roster via rmartz/dotfiles#1573. `merge conflict` stays
  merge-safety's label and is not owned here.

## How the remaining pieces plug into the state order

Both extend existing rules in the core's
[state order](reconciler-design.md#state-in-priority-order) rather than adding
new states:

- **Carry-over** widens rule 6 ("counting verdict"). A verdict bound to an
  earlier commit counts for the head when the path between them is verified clean.
- **Auto-update** adds an action to `approved` (rules 6 and 7): update the branch
  when merge-safety has flagged `update required`.

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

Rule 2 is what makes this safe. Any extra edit, hand-resolved conflict or reverted
base change produces a different tree and fails. That was verified empirically
during design: a clean merge where both sides edited the same file matched
exactly, while a merge with identical parents and message plus one sneaked-in line
did not. It fails safe: if git's merge algorithm ever disagrees with GitHub's, the
result is an extra review, never a false approval. A clean merge made locally
qualifies too, since provenance doesn't matter.

**Semantic breakage is covered by the state order, not by the rule.** A textually
clean merge can still break the build, which is the risk merge-safety's
`update required` exists to re-test. Failing CI outranks every verdict (rule 5),
so a carried-over approval on a broken head becomes `ci-failing`. While CI is
still running, the carried approval keeps the PR `approved` and armed, which is
safe because GitHub's auto-merge waits for required checks. A semantic break that
CI doesn't catch is the accepted residual risk, the same one a merge queue takes.

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
| Approval carry-over across clean base updates                         | #22                                                 | #20          |
| Auto-update approved PRs flagged `update required`                    | #23                                                 | #7, #22, #20 |
| `fix required` / `ci failing` in the fleet roster                     | rmartz/dotfiles#1573 (roster + coordinator routing) | —            |
