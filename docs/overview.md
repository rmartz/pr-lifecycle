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

This page is the source of truth for the design: record decisions here as they
are made, and trim the open questions they resolve.

> **Status:** the pure reconciler core ([design](reconciler-design.md)), the
> [GitHub edge layer](github-edge-layer.md), [bot eligibility](bot-eligibility.md),
> and the [`pr-lifecycle reconcile` CLI](cli.md) are implemented. The composite
> action that runs it in consumer repos is built in
> [`rmartz/pr-lifecycle-action`](https://github.com/rmartz/pr-lifecycle-action),
> and this repo dogfoods it with arming on. The fleet rollout is tracked on #75.

**Adopting it in a repo:** follow the action's
[consumer guide](https://github.com/rmartz/pr-lifecycle-action/blob/main/docs/consuming.md):
the caller workflow, its permissions, the real-actor token and where to store
it, and the checks to make before turning on arming. A repo moving off
bot-automerge also follows
[Cutting over from bot-automerge](bot-eligibility.md#cutting-over-from-bot-automerge).

## Lifecycle

The state set and its labels, which reuse the existing `VERDICT_LABELS` roster,
are specified in [Reconciler core design](reconciler-design.md#state-in-priority-order).
In short: a draft or `[WIP]` PR has no lifecycle label; a PR waiting on a
requested bot review (Copilot) has none either; once no bot review is pending it
gets `review requested`; a
trusted verdict on the head sets `approved`, `changes requested`, or
`escalation needed`; an eligible bot PR is `approved`. A push invalidates every
verdict on the old head. `escalation needed` is sticky: once present, whether a
verdict or a person applied it, the reconciler keeps it and treats the PR as
escalated until someone removes the label.

## Design constraints

1. **Recompute state from facts; never step through transitions.** On every
   relevant event, derive the full state from the PR's current facts (draft flag,
   pending bot review requests, latest trusted verdict and the head SHA it
   reviewed, gate labels) and reconcile labels to match. This makes the reconciler
   idempotent, replay-safe, and immune to out-of-order or dropped events — and
   gives approval freshness for free (a verdict bound to an older SHA doesn't count).
2. **Verdict authors are verified.** An approval authorizes a merge, so a verdict
   counts only from a trusted author — **never** from the hidden `skill-meta`
   marker alone. The forged-marker case is a required test.
3. **Token and event-chaining limits.** Labels written with `GITHUB_TOKEN` trigger
   no other workflows, so each run does its whole reconcile in one job and never
   relies on its own label writes firing anything. A merge armed with
   `GITHUB_TOKEN` doesn't trigger downstream `on: push` releases, so arming and
   merging use a separate real-actor [release token](cli.md#release-token), and
   are skipped (never done with `GITHUB_TOKEN`) when it isn't configured.
   Disarming uses the same token, because GitHub refuses it from a `GITHUB_TOKEN`
   with only `contents: read`.
4. **Merge gating belongs to the consumer's ruleset.** This package moves a PR
   through review, fix, and approval and arms auto-merge on `approved`; it owns
   no merge gate of its own and never renames a PR. The hard gates a PR must pass
   before merging, **UAT and CI sign-off** included, are
   [pr-policy](https://github.com/rmartz/pr-policy)'s required check, so an
   approved, armed PR simply waits on it. (The [CI gate](reconciler-design.md#ci-gate)
   reads required checks only to route a PR, never to hold its merge.)

## Relationship to other packages

- **[`pr-policy`](https://github.com/rmartz/pr-policy)** — enforces
  the hard merge gates (CI sign-off, title rules, and UAT sign-off via
  rmartz/pr-policy#13) as one required `pr-policy` check. Fully independent: the
  two write disjoint label sets and meet only in the consumer's ruleset, where
  the CI gate treats a pending `pr-policy` as a hold, not running CI.
- **[`@rmartz/merge-safety`](https://github.com/rmartz/merge-safety)** —
  unchanged; its check-run is one of the consumer's required gates.
- **[`@rmartz/bot-automerge`](https://github.com/rmartz/bot-automerge)** —
  replaced, not complemented. Its eligibility rules are ported here as
  [bot-PR eligibility](bot-eligibility.md), so an eligible bot PR reaches
  `approved` and is armed like any other. A consumer runs one arming path
  at a time, removing bot-automerge before enabling arming (see
  [cutting over](bot-eligibility.md#cutting-over-from-bot-automerge)).

## Decisions

- **UAT is pr-policy's gate, not this package's.** It holds by default and
  passes on a statically trivial PR, on `no UAT needed` (from the review agent or
  a person), or on `UAT passed` (from a person). Because a missing label is a
  hold, an approved PR can be armed at any time without a race; the UAT labels
  are neither read nor written here (#25, closed in favor of rmartz/pr-policy#13).

- **Trust = write permission.** A verdict counts only from a human (`User`, not a
  `Bot`) with write, maintain, or admin permission on the repo, optionally narrowed
  by a `trusted-authors` list. This grants no new privilege: a write user can
  already merge a PR once its required checks pass.
- **Labels are output only.** Hand-applied lifecycle labels are reconciled away.
  A human approves the same way an agent does, by posting a verdict review.
- **Arming is opt-in.** One package; auto-merge arming sits behind an
  `arm-auto-merge` input that defaults to off, so consumers can adopt labelling
  before their ruleset gates are ready.
- **Waiting for bot reviewers is derived.** It has no visible label, so the label
  roster stays at the four existing verdict labels. It waits on a pending review
  request, never on a review arriving (see
  [Waiting for bot reviewers](reconciler-design.md#waiting-for-bot-reviewers)).
- **Distributed as a composite action in a sibling repo,
  [`rmartz/pr-lifecycle-action`](https://github.com/rmartz/pr-lifecycle-action).**
  This repo publishes the `@rmartz/pr-lifecycle` CLI. The action pins an exact
  CLI version in its own lockfile, so Dependabot bumps the CLI → a new action
  release → consumers' SHA pins get bumped by Dependabot, with every link
  automated. A reusable workflow or JavaScript action in this repo would need a
  version pin or a committed `dist/` that semantic-release (which never commits
  back) can't keep current. This matches `repo-hygiene-action` and
  `bot-automerge-action`. The CLI ↔ action interface contract is
  tracked on #6.

## Open questions

- What happens to `/merge`, `merge-pr.py`, and `pr-route.py` once this is live
  (#11).
