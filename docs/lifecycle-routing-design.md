---
type: Design
title: Lifecycle routing design (v2)
description: The extension of the reconciler that resolves simple merge blockers itself, routes statically detectable problems to fix, and sends everything else to review — its goals and decisions, with pointers to where each rule now lives.
tags: [reconciler, design, ci, routing, auto-update, security]
---

# Lifecycle routing design (v2)

**Status: built.** Every piece is implemented, and its rules live in the
[core design](reconciler-design.md) and the
[GitHub edge layer](github-edge-layer.md). This page keeps the goals and the
decisions behind them.

## Goal

1. **Resolve simple merge blockers automatically.** An approved PR that only
   needs a base update gets updated.
2. **Route statically detectable problems to a fix.** Merge conflicts and failing
   CI go straight to fix-review, with no review cycle spent on them.
3. **Send everything else to review**, so an agent decides between approve, fix
   and escalate.

## Decisions

- **CI is a gate.** This deliberately reverses ai-tools#306 constraint 4
  ("never inspects any check"). See the core design's
  [CI gate](reconciler-design.md#ci-gate).
- **Approvals carry over a clean base update** under a content-verified rule, so
  an update doesn't cost a review cycle. See
  [Approval carry-over](reconciler-design.md#approval-carry-over).
- **Approved PRs are auto-updated when merge-safety says it matters.** The
  trigger is merge-safety's selective `update required` label, not GitHub's
  generic "behind", and it is opt-in (`--auto-update`). Dependabot PRs are only
  ever asked to rebase themselves, once per head, never updated directly. See
  [Plan](reconciler-design.md#plan) and
  [Auto-update](github-edge-layer.md#auto-update).
- **New lifecycle labels** `fix required` and `ci failing` join the fleet roster
  via rmartz/dotfiles#1573. `merge conflict` and `update required` stay
  merge-safety's labels and are never written here.
