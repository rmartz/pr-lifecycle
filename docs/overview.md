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

> **Status: scaffold.** The repository toolchain, CI, and release pipeline are in
> place; the reconciler itself is not implemented yet. The CLI (`ai-pr-lifecycle`)
> currently only prints usage.

## Proposed lifecycle

| Trigger (fact)                                           | State / label                                 |
| -------------------------------------------------------- | --------------------------------------------- |
| PR ready for review (non-draft, not `[WIP]`)             | `waiting for Copilot`                         |
| Copilot has reviewed the current head                    | `review requested`                            |
| Trusted verdict `fix`                                    | `fix requested`                               |
| Trusted verdict `approve` **for the current head SHA**   | `approved`, then arm auto-merge               |
| New push after an approval                               | back to `review requested`; disarm auto-merge |
| Eligible bot PR (Dependabot patch/minor, release-please) | automatically `approved`                      |

Label names and the exact state set are open; they should match the existing
`VERDICT_LABELS` roster where possible.

## Design constraints

1. **Recompute state from facts; never step through transitions.** On every
   relevant event, derive the full state from the PR's current facts (draft flag,
   Copilot review for the head, latest trusted verdict and the head SHA it
   reviewed, gate labels) and reconcile labels to match. This makes the reconciler
   idempotent, replay-safe, and immune to out-of-order or dropped events — and
   gives approval freshness for free (a verdict bound to an older SHA doesn't count).
2. **Verdict authors are verified.** An approval authorizes a merge, so a verdict
   counts only from an allowlisted author identity — **never** from the hidden
   `skill-meta` marker alone. The forged-marker case is a required test.
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

## Open questions

- Names and granularity of states — is `waiting for Copilot` a visible label?
- Where the trusted-author allowlist lives: workflow input, repo config file, or
  a GitHub App identity.
- Human overrides — does a hand-applied `approved` get respected, removed, or
  treated as a trusted verdict?
- One package or a split — does auto-merge arming ship as a separately opted-in
  mode, given it is a much larger trust grant than labelling?
- Distribution form — a reusable workflow in this repo, or a composite action in
  a sibling `pr-lifecycle-action` repo (the form the fleet is converging on, per
  ai-tools#282)?
- What happens to `/merge`, `merge-pr.py`, and `pr-route.py` once this is live.
