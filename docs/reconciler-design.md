---
type: Design
title: Reconciler core design
description: How the pure reconciler core turns a PR's facts into a lifecycle state, a minimal label plan, an auto-merge action, and a branch update — the fact model, trust rules, state priority, and the properties the tests guarantee.
tags: [reconciler, design, labels, auto-merge, security]
---

# Reconciler core design

The core is a **pure function**: `planReconcile(facts, policy)` returns the PR's
lifecycle state plus the label, auto-merge, and branch-update changes that
converge the PR to it.
It performs no I/O. A separate edge layer gathers the facts from GitHub and applies
the plan. Because the output depends only on current facts, never on the event
that triggered the run, replaying, reordering or dropping events cannot drive a PR
into a wrong state (ai-tools#306, constraint 1).

Source: `src/` (`facts.ts`, `verdict.ts`, `state.ts`, `plan.ts`).

## Facts

| Fact                   | Source (edge layer)                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `status`               | PR `state` / `merged`: `open`, `closed`, or `merged`                                                                 |
| `isDraft`, `title`     | PR fields; a `[WIP]` title (any case) is treated like a draft                                                        |
| `headSha`              | PR `head.sha`                                                                                                        |
| `labels`               | current label names                                                                                                  |
| `autoMergeEnabled`     | PR `auto_merge` is non-null                                                                                          |
| `botEligible`          | [bot-PR eligibility](bot-eligibility.md): same-repo Dependabot patch/minor, release-please                           |
| `mergeable`            | PR `mergeable`: `true`, `false` (merge conflict), or unknown (`null` → `undefined`: still computing)                 |
| `immediatelyMergeable` | PR `mergeable_state` is `clean`, `has_hooks`, or `unstable`: GitHub would merge now, so auto-merge can't be armed    |
| `ciStatus`             | [CI gate](#ci-gate) over the head's required checks: `passing`, `failing`, or `pending`                              |
| `baseCiFailing`        | the same required checks are failing on the base branch head (fetched only when `ciStatus` is `failing`)             |
| `cleanAncestors`       | commits whose reviews carry over to the head (see [Approval carry-over](#approval-carry-over)); verified at the edge |
| `updater`              | `dependabot` for a PR opened by `dependabot[bot]` (it rebases its own branch), else `github` (`update-branch`)       |
| `rebasePending`        | Dependabot PRs only: a rebase is running (PR body) or was already requested for this head (a marker comment)         |
| `reviews`              | PR reviews: author login, type (`User`/`Bot`), repo permission, `commit_id`, state, body, submitted time             |
| `uatOverrides`         | [UAT gate](uat-gate.md) override labels on the PR, each with who last applied it (only with `policy.uatGate`)        |

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
2. **Bound to the current head.** The review's `commit_id` is the head, or one of
   the head's [clean ancestors](#approval-carry-over), and if the marker names a
   `pr_head`, it names that same commit. A verdict on any other older commit never
   counts, so a real push after approval un-approves the PR without extra logic.

The **latest** counting verdict (by submitted time, then review id) decides.

## State, in priority order

| #   | Condition                                                                      | State               | Lifecycle label              |
| --- | ------------------------------------------------------------------------------ | ------------------- | ---------------------------- |
| 1   | status is `closed` or `merged`                                                 | `closed`            | untouched (no plan)          |
| 2   | draft, or `[WIP]` title                                                        | `draft`             | none                         |
| 3   | `mergeable` is `false` (merge conflict)                                        | `fix-required`      | `fix required`               |
| 4   | `ciStatus` is `failing` and `baseCiFailing`                                    | `blocked-base-red`  | none                         |
| 5   | `ciStatus` is `failing`                                                        | `ci-failing`        | `fix required`, `ci failing` |
| 6   | counting verdict `approved`                                                    | `approved`          | `approved`                   |
| 6   | counting verdict `changes-requested`                                           | `changes-requested` | `changes requested`          |
| 6   | counting verdict `escalation-needed`                                           | `escalation-needed` | `escalation needed`          |
| 7   | `botEligible`                                                                  | `approved`          | `approved`                   |
| 8   | `ciStatus` is `pending`                                                        | `awaiting-ci`       | none                         |
| 9   | Copilot reviewed the head (or a clean ancestor), or `policy.skipCopilotReview` | `review-requested`  | `review requested`           |
| 10  | otherwise                                                                      | `awaiting-copilot`  | none                         |

**A merge conflict outranks every verdict.** It needs a code change, and the
resolution is a new commit that no approval could survive anyway, so an approved
PR that develops a conflict loses `approved` and is disarmed. `fix required`
(a statically detected problem) is deliberately distinct from `changes requested`
(a reviewer's verdict): it tells fix-review there are no review threads to work
from. merge-safety's own `merge conflict` label, if present, says why; it isn't
owned here. An unknown `mergeable` (GitHub computes it lazily, and `null` means
"not yet") is **not** a conflict: the rule doesn't fire, and the next event
re-evaluates.

**Failing CI outranks every verdict; pending CI only gates the no-verdict path.**
Failing CI needs a fix (a new commit), so like a conflict it drops `approved` and
disarms. A PR failing _because its base is red_ (the same required checks fail on
the base head) is `blocked-base-red` instead, which is held with no label: the fix
isn't in the PR, and merge-safety already holds merges while the base is red.
Pending CI comes **after** verdicts, and that ordering is the safety mechanism:

- an **approved** PR (or eligible bot PR) with CI running stays `approved` and
  armed. That's safe, because GitHub's auto-merge itself waits for required
  checks, and it avoids flapping `approved` whenever CI re-runs;
- a PR with **no** counting verdict and CI running is `awaiting-ci`, so review is
  requested only once CI is green. This includes the dangerous case, an
  unreviewed push onto an armed, approved PR: the approval is stale, so the PR
  lands here, is not `approved`, and is **disarmed**. Otherwise GitHub would merge
  the unreviewed commit as soon as CI passed.

### CI gate

`ciStatus` (`src/ci.ts`) covers the base branch's **required checks** (the union
across every active ruleset on the branch; with none required, the gate is
inactive and CI is `passing`). A private repo on GitHub Free can't use rulesets,
and the rules API answers `403 "Upgrade to GitHub Pro…"`. That specific
plan-limitation answer means "no required checks". Any other error, including a
403 for missing token permissions, fails the run loudly rather than silently
switching the gate off. Each check-run and commit status is normalized:

- `success` / `neutral` / `skipped` → passed;
- `failure` / `cancelled` / `timed_out` / `action_required` / `startup_failure` →
  failed;
- anything else → running, including `stale`, an unrecognized conclusion, and a
  completed run with no conclusion (never a pass). A run whose status still reads
  in-progress but whose `completed_at` is set is judged by its conclusion (GitHub
  sometimes leaves the status stale).

**Any** counted failure makes CI `failing` immediately, even with others still
running. Otherwise, any counted check still running, or not reported at all,
makes it `pending`. Two policy lists adjust what "counted" means:

| List                                | Pending means                  | Failure means    | Default        |
| ----------------------------------- | ------------------------------ | ---------------- | -------------- |
| `holdChecks` (`--hold-checks`)      | a hold on a human act: ignored | counts (fixable) | `pr-policy`    |
| `ignoredChecks` (`--ignore-checks`) | ignored                        | ignored          | `merge-safety` |

pr-policy reports **pending** while waiting on a sign-off and **fails** for
fixable problems such as a bad title, so it's a hold check: a sign-off wait must
not look like CI still running, but a fixable failure should route to a fix.
merge-safety currently fails for "update needed" and "base is red", which other
states handle, so it's ignored. This package's own `uat` check is **always** a
hold, whatever `holdChecks` says: it waits on a person, and on a PR with no
verdict yet it waits on the very review CI must go green for. Once it reports Pending instead, as planned, it
can become a hold check.

A trusted human verdict outranks bot eligibility, so a person can hold a
Dependabot PR with a `changes requested` verdict. Copilot is recognized by the
login `copilot-pull-request-reviewer[bot]`. Any Copilot review on the head counts,
including the "quota reached" notice, because Copilot has then finished with that
commit.

In a repo without Copilot code review, no Copilot review ever arrives, so a PR
would sit in `awaiting-copilot` forever. `policy.skipCopilotReview` (off by
default) skips that wait: a ready PR with no counting verdict goes straight to
`review-requested`. It changes only rule 9; drafts, verdicts and bot eligibility
are unaffected. A timeout alternative ("treat Copilot as done after N minutes")
was rejected: no event fires when nothing happens, so it would need a scheduled
trigger.

## Approval carry-over

Head binding makes any push drop the approval, so without carry-over every base
update would cost a full review cycle. A review bound to commit `A` also counts
for the head `H` when every commit on the first-parent chain from `H` back to `A`
is a **verified clean base merge** (`src/github/lineage-facts.ts`,
`src/lineage/verify.ts`). This applies to verdicts **and** to Copilot's review:
Copilot won't re-review after a push (`review_on_push` is off), so without it
every update would strand the PR in `awaiting-copilot`. Each step must satisfy:

1. It is a merge commit with **exactly two parents**, and the second parent is
   **on the base branch** (reachable from the base head, via the compare API).
2. **Its tree is byte-identical to the automatic merge**, recomputed with
   `git merge-tree --write-tree --merge-base=<M> <first> <second>`, which must also
   report no conflicts.

**Content, not provenance.** GitHub's `web-flow` committer also signs web-editor
conflict resolutions and in-browser edits, so "GitHub made this commit" doesn't
mean clean; rule 2 ignores who made the commit. Any extra edit, hand-resolved
conflict, reverted base change (`-s ours`) or octopus merge fails. It was
validated against **real GitHub update-branch merges**: 8 of 8 from the fleet's
history reproduced byte for byte, and each tampered variant was rejected.

**Safety of the check itself.**

- The commits are fetched as **git data only** (`fetch --depth=1` by SHA into a
  throwaway bare repo); nothing is checked out and no PR code runs.
- The token travels only as a `GIT_CONFIG_*` header (as `actions/checkout`
  does), never in argv or the URL.
- Every SHA from the API is validated as a hex object id before it reaches git's
  argv, the URL must be `https://` or `file://`, and `--end-of-options` precedes
  it, so no API value can be read as a git option.

**Fails closed.** Any API or git error, git older than 2.40, a missing binary, or
a chain longer than 20 steps means no carry-over, which costs an extra review and
never produces a false approval. The walk runs only when some review sits on an
earlier commit, and stops as soon as every such commit is reached.

**Semantic breakage is covered by the state order, not by this rule.** A
textually clean merge can still break the build; failing CI outranks every
verdict, so a carried approval on a broken head becomes `ci-failing`. While CI
runs, the carried approval keeps the PR `approved` and armed, which is safe
because GitHub's auto-merge waits for required checks.

Carry-over runs when the caller supplies a git runner (`GatherOptions.lineage`).
The CLI always does; library callers that omit it simply get no carry-over.

## Plan

- **Labels are output only.** The core owns the six lifecycle labels
  (`approved`, `changes requested`, `escalation needed`, `fix required`,
  `ci failing`, `review requested`) and, in arming mode, `auto-merge enabled`.
  It adds the desired ones and removes every
  other owned label present, so a hand-applied `approved` with no verdict behind
  it is removed. Labels the core doesn't own are never touched. When the labels
  already match, the plan is empty.
- **Auto-merge (opt-in via `policy.armAutoMerge`, default off).** When the state
  is `approved` and auto-merge is off, the core plans `merge` if the PR is
  `immediatelyMergeable` (GitHub refuses to arm a PR that is already mergeable;
  this mirrors `gh pr merge --auto`) and `arm` otherwise. It disarms when the
  state is anything else and auto-merge is on. A direct merge doesn't claim
  `auto-merge enabled`. With arming off, auto-merge is never touched and
  `auto-merge enabled` isn't owned. With the [UAT gate](uat-gate.md) on, an
  `approved` PR is armed (or merged) only once the gate passes; until then it
  stays `approved` but unarmed, and an armed one is disarmed.
- **UAT gate (opt-in via `policy.uatGate`, default off).** The plan carries the
  [gate result](uat-gate.md) for every open PR; the edge posts it as the `uat`
  check-run.
- **Auto-update (opt-in via `policy.autoUpdate`, default off).** When the state
  is `approved` and merge-safety's `update required` label is present (read,
  never written), the plan's `update` is `update-branch`, or `dependabot-rebase`
  for a Dependabot PR (none while `rebasePending`). A Dependabot PR is **never**
  planned `update-branch`: a foreign commit permanently breaks its rebasing. No
  update is planned for a PR being merged in the same pass, or without the
  label: absent merge-safety there is no auto-update. The update keeps the
  approval through [carry-over](#approval-carry-over); see
  [Auto-update](github-edge-layer.md#auto-update) for how it's executed.
- **`withoutReleaseActions(plan)`** strips an `arm` or `merge` (and the
  `auto-merge enabled` it would add) and any `update`, and keeps everything else,
  a disarm included. The edge layer applies it when no real-actor token is
  available (see [GitHub edge layer](github-edge-layer.md#arming-and-merging)).
- A `closed` PR yields an empty plan: its final labels stay as the audit record.

## Guaranteed properties (tested)

- **Idempotent.** Applying a plan and re-planning yields an empty plan.
- **Order-independent.** Permuting the review list never changes the result.
- **Untrusted input is inert.** Adding any number of untrusted or stale reviews,
  including ones with forged `approved` markers, never changes the state.
- **Scoped writes.** A plan never adds or removes a label outside the owned set.
- **No unapproved armed PR.** In arming mode, an armed open PR that isn't
  `approved`, whatever its CI, conflict or review state, is always disarmed, and
  a PR is only ever armed or merged when `approved` (and, with the UAT gate on,
  only when the gate passes).
- **UAT overrides are trusted like verdicts.** An override applied by anyone who
  couldn't merge the PR never changes the gate, and untrusted or stale reviews
  (including forged `uat: exempt` markers) never change the plan.
- **Updates are approved-only and Dependabot-safe.** An `update` is only ever
  planned for an `approved` PR, never `update-branch` for a Dependabot PR, and a
  rebase is requested at most once per head.
- **`withoutReleaseActions` removes release actions and nothing else.** No arm,
  merge, update, or `auto-merge enabled` survives it; every other change, a
  disarm included, does.
- **Carry-over grants nothing new.** A review on a clean ancestor counts exactly
  as if the same reviewer had posted it on the head.
