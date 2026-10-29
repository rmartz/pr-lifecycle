---
type: Design
title: Verdicts
description: Which reviews are verdicts, how the /review marker records each decision as its own dimension (code, UAT), and when a verdict counts — trusted author and head binding, including reviews GitHub moved after a force-push.
resource: src/verdict.ts
tags: [reconciler, verdicts, marker, trust, security]
---

# Verdicts

Part of the [reconciler core design](reconciler-design.md): a counting verdict
is what the [state](reconciler-design.md#state-in-priority-order) reads.
Source: `src/verdict-marker.ts` (parsing), `src/verdict.ts` (trust and
resolution), `src/head-binding.ts`.

The `/review` marker's `skill`, `outcome`, `verdicts`, `uat_since`, and `pr_head`
fields are a contract with the agent tooling that writes them, documented on
that side in its `skill-meta.md`. Change both sides together.

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

## Dimensions

A review pass makes more than one decision, so a marker can record each as its
own **dimension** in a `verdicts` map (#141):

```json
{ "skill": "review", "pr_head": "<sha>", "verdicts": { "code": "approved", "uat": "not-needed" } }
```

- **`code`** is the verdict above, read exactly as `outcome` is, including its
  fail-closed rule and `skipped`.
- **`uat`** is the review's UAT decision: `not-needed`, `required`, or
  `unchanged`. `unchanged` says a person's `UAT passed` on the commit named by the
  marker's top-level `uat_since` still holds, and needs that to be a full hex
  commit id. Any other value, including `unchanged` without a valid `uat_since`,
  fails closed to `required`: an unreadable UAT decision must never let an
  earlier waiver stand. An agent never records `passed`.
- **A dimension the map leaves out is not updated.** A review may record only
  its UAT decision. Its code verdict then falls back to `outcome` when the
  marker has one, so a marker may carry both while the tooling migrates. A map
  that names neither dimension records nothing readable, so it is read like a
  legacy marker and fails closed to `escalation-needed`.
- **A marker without a map** (or with one that isn't an object) is a legacy
  marker: `outcome` is the code verdict, and it records no UAT decision. Neither
  does a native review state.

Each dimension is **resolved on its own**, by the [counting rules](#when-a-verdict-counts):
the latest counting review that records it decides it (`currentVerdict` for
`code`, `currentUatVerdict` for `uat`). A review that leaves a dimension out
never supersedes an earlier one that records it, and dismissing a review revokes
all of its dimensions. The code verdict drives the lifecycle state, and the
`uat` dimension drives the [UAT labels](uat.md#rules) (rules 5 and 7). A
`uat` record carries over verified clean base merges and rebases exactly as an
approval does.

## Parsing is linear-time

Review bodies are attacker-controlled, so marker parsing must stay
**linear-time**. It finds the opening with a regex that has no overlapping
quantifiers, then scans to `-->` with `indexOf`. A one-regex
`<!--\s*skill-meta:\s*(.*?)\s*-->` backtracks cubically, and a malicious comment
could stall the reconcile job (CodeQL `js/polynomial-redos`). A timing test
guards against a regression.

## When a verdict counts

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

The **latest** counting verdict (by submitted time, then review id) decides,
per [dimension](#dimensions).
