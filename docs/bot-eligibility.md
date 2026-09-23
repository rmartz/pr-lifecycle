---
type: Library
title: Bot-PR eligibility
description: Which bot PRs count as approved without a review — Dependabot patch/minor bumps and release-please release PRs from this repository — how the Dependabot update type is read, and why fork PRs are never eligible.
resource: src/bot-eligibility.ts
tags: [bot, dependabot, release-please, security, eligibility]
---

# Bot-PR eligibility

An eligible bot PR is treated as `approved` without a review (state priority 4
in the [core design](reconciler-design.md#state-in-priority-order)), so eligibility
is a merge authorization and every uncertain case resolves to **not eligible**.
`classifyBotPr` (`src/bot-eligibility.ts`) is a pure function; `gatherFacts`
supplies its facts and records the verdict, with a one-line `reason` for
reporting (see the [GitHub edge layer](github-edge-layer.md)).

A trusted human verdict still outranks eligibility, so a person can hold any bot
PR with a `changes requested` review.

## Rules, in order

1. **Fork PRs are never eligible.** A fork controls its own branch names, labels
   and commits, so nothing about a fork PR can be trusted to identify a bot.
   Genuine bot branches (Dependabot's and release-please's) always live in the
   base repository, where pushing already requires write access, so this keeps
   eligibility inside the existing trust boundary. Forks are detected by repository
   **id**, not name, and a deleted head repository counts as a fork.
2. **Dependabot** (PR author `dependabot[bot]`) is eligible only when:
   - every commit on the PR is authored by `dependabot[bot]`. If anyone else
     pushed (say, a fix for a breaking bump), it is no longer a pure dependency
     bump and needs a review. An unlinked commit author counts as someone else;
   - and the highest update type across its commits is `semver-patch` or
     `semver-minor`. Majors are held for review.
3. **release-please**: a head branch starting `release-please--`, or the
   `autorelease: pending` label, is eligible.
4. **Anything else** (a human, or an unrecognized bot such as Renovate) is not
   eligible.

## Reading the Dependabot update type

Dependabot writes an `updated-dependencies:` YAML block into every commit
message, with one `update-type: version-update:semver-*` line per dependency.
`parseDependabotUpdateType` reads that block and returns the **highest** type, so
a grouped update with one major is treated as a major. It fails safe: a missing
block, a block with no update type, or **any** unrecognized value (e.g.
`security-update`) yields no type, and the PR is not eligible. Commit messages are
untrusted input, so the parser scans line by line with no backtracking regex.

Reading the commit metadata directly, rather than taking a
`dependabot/fetch-metadata` output as bot-automerge does, lets the reconciler
classify on **every** triggering event (reviews, labels, check suites), not only
on the `pull_request` events where that action runs.

## Relationship to bot-automerge

These rules are **ported** from `@rmartz/bot-automerge`'s `classifyBotPr`, not
imported. Importing would pull a GitHub Packages runtime dependency, and its
release cadence, into this package for about 100 lines of logic. The rules also
deliberately differ: bot-automerge detects release-please by branch name or label
alone, with no repository check, so a fork PR named `release-please--…` would be
classified as a release PR. Rule 1 closes that here. Once this package owns
arming for every PR (#10), bot-automerge's own classifier is retired, per
ai-tools#306.
