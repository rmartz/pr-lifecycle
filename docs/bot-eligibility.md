---
type: Library
title: Bot-PR eligibility
description: Which bot PRs count as approved without a review — Dependabot patch/minor bumps, and release-please PRs whose branch and diff are a pure release — how the Dependabot update type is read, why a label never identifies a release, and why fork PRs are never eligible.
resource: src/bot-eligibility.ts
tags: [bot, dependabot, release-please, security, eligibility]
---

# Bot-PR eligibility

An eligible bot PR is treated as `approved` without a review (state priority 7
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
3. **release-please** is recognized by a head branch starting `release-please--`,
   and is eligible only when its diff is a **pure release** (below). The
   `autorelease: pending` label is **not** a signal: triage permission can apply
   it but can't push or merge, so honoring it would let a triage user approve any
   same-repo PR.
4. **Anything else** (a human, or an unrecognized bot such as Renovate) is not
   eligible.

## A pure release diff

The branch name alone isn't enough: anyone with write access can push arbitrary
code to a `release-please--` branch. release-please commits as whoever owns its
token (in this fleet, the owner's PAT), so commit authors can't tell a release
apart either. The diff can: `classifyReleaseDiff` (`src/release-diff.ts`)
accepts it only when every changed file is

- `.release-please-manifest.json` at the repository root,
- a `CHANGELOG.md` at any depth, or
- a `package.json` at any depth whose patch changes **exactly one line, its
  `"version"`** (one removed and one added bare `"version": "…"` member);

and every file's status is `added` or `modified` (a release never deletes,
renames, or copies one). It fails closed: a missing `package.json` patch (GitHub
omits patches for large diffs), an empty diff, or a file list short of the PR's
`changed_files` (GitHub lists at most 3,000) is not a release. Files are fetched
only for a same-repo `release-please--` branch not authored by Dependabot.

Not yet supported, so held for review: lockfiles (release-please's node strategy
can bump `package-lock.json`, whose many `"version"` lines can't be told apart
from a dependency change by patch alone) and `extra-files` from
`release-please-config.json`.

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
alone, with no diff check. Here the label is ignored and the diff must be a pure
release (rule 3), and fork PRs are never eligible (rule 1). Once this package owns
arming for every PR (#10), bot-automerge's own classifier is retired, per
ai-tools#306.
