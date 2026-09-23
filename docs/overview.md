---
type: Reference
title: What pr-lifecycle is
description: The event-driven PR lifecycle reconciler — recompute state from facts on every event, verify verdict authors, arm native auto-merge on approval — its constraints, sibling packages, and open design questions.
tags: [pr-lifecycle, reconciler, labels, auto-merge, overview]
---

# What pr-lifecycle is

`@rmartz/pr-lifecycle` moves the PR review lifecycle out of agent turns and
coordinator scripts and into a GitHub Actions package that runs on its own when
GitHub events fire. It keeps a PR's lifecycle labels in step with the PR's current
facts and **arms native auto-merge when a PR reaches `approved`** — so the
consumer's ruleset required checks, not a separate merge step, gate the merge.

The source of truth for the design is
[rmartz/ai-tools#306](https://github.com/rmartz/ai-tools/issues/306). This page
summarizes it; record decisions here as they are made and trim the open questions
they resolve.

> **Status:** the pure reconciler core (facts → state → label/auto-merge plan) is
> implemented and specified in [Reconciler core design](reconciler-design.md). The
> GitHub edge layer (gathering facts, applying the plan) and the distributed action
> are not built yet; the CLI (`ai-pr-lifecycle`) only prints usage.

## Lifecycle

The state set and its labels, which reuse the existing `VERDICT_LABELS` roster,
are specified in [Reconciler core design](reconciler-design.md#state-in-priority-order).
In short: a draft or `[WIP]` PR has no lifecycle label; a PR waiting for Copilot
has none either; after Copilot reviews the head it gets `review requested`; a
trusted verdict on the head sets `approved`, `changes requested`, or
`escalation needed`; an eligible bot PR is `approved`. A push invalidates every
verdict on the old head.

## Design constraints

1. **Recompute state from facts; never step through transitions.** On every
   relevant event, derive the full state from the PR's current facts (draft flag,
   Copilot review for the head, latest trusted verdict and the head SHA it
   reviewed, gate labels) and reconcile labels to match. This makes the reconciler
   idempotent, replay-safe, and immune to out-of-order or dropped events — and
   gives approval freshness for free (a verdict bound to an older SHA doesn't count).
2. **Verdict authors are verified.** An approval authorizes a merge, so a verdict
   counts only from a trusted author — **never** from the hidden `skill-meta`
   marker alone. The forged-marker case is a required test.
3. **Token and event-chaining limits.** Labels written with `GITHUB_TOKEN` trigger
   no other workflows, so each run does its whole reconcile in one job and never
   relies on its own label writes firing anything. A merge armed with
   `GITHUB_TOKEN` doesn't trigger downstream `on: push` releases; the
   `RELEASE_PLEASE_PAT` fallback is carried over from bot-automerge unchanged.
4. **Merge gating belongs to the consumer's ruleset.** This package arms
   auto-merge and never inspects, names, or waits on a specific check, and never
   renames a PR. The one gate it owns is **UAT**: if UAT gates merges, this package
   exposes it as a check the ruleset can require.

## Relationship to other packages

- **`pr-policy` (ai-tools#302)** — fully independent read-only classifier suite;
  the two write disjoint label sets and meet only in the consumer's ruleset.
- **[`@rmartz/merge-safety`](https://github.com/rmartz/merge-safety)** —
  unchanged; its check-run is one of the consumer's required gates.
- **[`@rmartz/bot-automerge`](https://github.com/rmartz/bot-automerge)** — once
  this package owns the approved → armed transition for all PRs, bot-automerge
  shrinks to an eligibility predicate that produces an automatic approval.

## Decisions

- **Trust = write permission.** A verdict counts only from a human (`User`, not a
  `Bot`) with write, maintain, or admin permission on the repo, optionally narrowed
  by a `trusted-authors` list. This grants no new privilege: a write user can
  already merge a PR once its required checks pass.
- **Labels are output only.** Hand-applied lifecycle labels are reconciled away.
  A human approves the same way an agent does, by posting a verdict review.
- **Arming is opt-in.** One package; auto-merge arming sits behind an
  `arm-auto-merge` input that defaults to off, so consumers can adopt labelling
  before their ruleset gates are ready.
- **Waiting for Copilot is derived.** It has no visible label, so the label
  roster stays at the four existing verdict labels.
- **Distributed as a composite action in a sibling repo,
  [`rmartz/pr-lifecycle-action`](https://github.com/rmartz/pr-lifecycle-action).**
  This repo publishes the `@rmartz/pr-lifecycle` CLI. The action pins an exact
  CLI version in its own lockfile, so Dependabot bumps the CLI → a new action
  release → consumers' SHA pins get bumped by Dependabot, with every link
  automated. A reusable workflow or JavaScript action in this repo would need a
  version pin or a committed `dist/` that semantic-release (which never commits
  back) can't keep current. This matches `repo-hygiene-action` and
  `bot-automerge-action` (ai-tools#282). The CLI ↔ action interface contract is
  tracked on #6.

## Open questions

- What happens to `/merge`, `merge-pr.py`, and `pr-route.py` once this is live
  (#11).
