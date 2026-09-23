---
type: Design
title: Reconciler core design
description: How the pure reconciler core turns a PR's facts into a lifecycle state, a minimal label plan, and an auto-merge action — the fact model, trust rules, state priority, and the properties the tests guarantee.
tags: [reconciler, design, labels, auto-merge, security]
---

# Reconciler core design

The core is a **pure function**: `planReconcile(facts, policy)` returns the PR's
lifecycle state plus the label and auto-merge changes that converge the PR to it.
It performs no I/O. A separate edge layer gathers the facts from GitHub and applies
the plan. Because the output depends only on current facts, never on the event
that triggered the run, replaying, reordering or dropping events cannot drive a PR
into a wrong state (ai-tools#306, constraint 1).

Source: `src/` (`facts.ts`, `verdict.ts`, `state.ts`, `plan.ts`).

## Facts

| Fact               | Source (edge layer)                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `status`           | PR `state` / `merged`: `open`, `closed`, or `merged`                                                     |
| `isDraft`, `title` | PR fields; a `[WIP]` title (any case) is treated like a draft                                            |
| `headSha`          | PR `head.sha`                                                                                            |
| `labels`           | current label names                                                                                      |
| `autoMergeEnabled` | PR `auto_merge` is non-null                                                                              |
| `botEligible`      | [bot-PR eligibility](bot-eligibility.md): same-repo Dependabot patch/minor, release-please               |
| `reviews`          | PR reviews: author login, type (`User`/`Bot`), repo permission, `commit_id`, state, body, submitted time |

The author's **repo permission** is a fact gathered at the edge (the collaborator
permission API), so trust evaluation stays pure.

## Verdicts

A `DISMISSED` review (revoked by a maintainer) or `PENDING` review (never
submitted) is **never** a verdict, whatever its body says. Dismissing is how a
maintainer revokes an approval, so a marker must not outlive it. Otherwise, a
review is a **verdict** when either:

- its body carries a `skill-meta` marker with `"skill": "review"` and an `outcome`
  of `approved`, `changes-requested`, or `escalation-needed` (a `skipped` outcome
  is not a verdict); or
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
2. **Bound to the current head.** The review's `commit_id` equals `headSha`, and
   if the marker names a `pr_head`, that equals `headSha` too. A verdict on an
   older commit never counts, so a push after approval un-approves the PR without
   any extra logic.

The **latest** counting verdict (by submitted time, then review id) decides.

## State, in priority order

| #   | Condition                            | State               | Lifecycle label     |
| --- | ------------------------------------ | ------------------- | ------------------- |
| 1   | status is `closed` or `merged`       | `closed`            | untouched (no plan) |
| 2   | draft, or `[WIP]` title              | `draft`             | none                |
| 3   | counting verdict `approved`          | `approved`          | `approved`          |
| 3   | counting verdict `changes-requested` | `changes-requested` | `changes requested` |
| 3   | counting verdict `escalation-needed` | `escalation-needed` | `escalation needed` |
| 4   | `botEligible`                        | `approved`          | `approved`          |
| 5   | a Copilot review exists on `headSha` | `review-requested`  | `review requested`  |
| 6   | otherwise                            | `awaiting-copilot`  | none                |

A trusted human verdict outranks bot eligibility, so a person can hold a
Dependabot PR with a `changes requested` verdict. Copilot is recognized by the
login `copilot-pull-request-reviewer[bot]`. Any Copilot review on the head counts,
including the "quota reached" notice, because Copilot has then finished with that
commit.

## Plan

- **Labels are output only.** The core owns the four lifecycle labels
  (`approved`, `changes requested`, `escalation needed`, `review requested`) and,
  in arming mode, `auto-merge enabled`. It adds the desired one and removes every
  other owned label present, so a hand-applied `approved` with no verdict behind
  it is removed. Labels the core doesn't own are never touched. When the labels
  already match, the plan is empty.
- **Auto-merge (opt-in via `policy.armAutoMerge`, default off).** The core arms
  auto-merge when the state is `approved` and it is off, and disarms it when the
  state is anything else and it is on. With arming off, auto-merge is never
  touched and `auto-merge enabled` isn't owned.
- A `closed` PR yields an empty plan: its final labels stay as the audit record.

## Guaranteed properties (tested)

- **Idempotent.** Applying a plan and re-planning yields an empty plan.
- **Order-independent.** Permuting the review list never changes the result.
- **Untrusted input is inert.** Adding any number of untrusted or stale reviews,
  including ones with forged `approved` markers, never changes the state.
- **Scoped writes.** A plan never adds or removes a label outside the owned set.
