---
type: Design
title: Approval carry-over
description: How a review on an earlier commit keeps counting for the PR head — a chain of verified clean base merges, or a verified clean rebase after a force-push — and the safety rules that keep the verification fail-closed.
resource: src/github/lineage-facts.ts
tags: [reconciler, carry-over, lineage, rebase, security]
---

# Approval carry-over

Part of the [reconciler core design](reconciler-design.md): this page defines the
`cleanAncestors` and `cleanRebaseSources` facts that
[head binding](reconciler-design.md#verdicts) counts reviews against.

Head binding makes any push drop the approval, so without carry-over every base
update would cost a full review cycle. A review bound to commit `A` also counts
for the head `H` when every commit on the first-parent chain from `H` back to `A`
is a **verified clean base merge** (`src/github/lineage-facts.ts`,
`src/lineage/verify.ts`). Each step must satisfy:

1. It is a merge commit with **exactly two parents**, and the second parent is
   **on the base branch** (reachable from the base head, via the compare API).
2. **Its tree is byte-identical to the automatic merge**, recomputed with
   `git merge-tree --write-tree --merge-base=<M> <first> <second>`, which must also
   report no conflicts.
3. **The two sides didn't both edit the same prose file.** The files the PR side
   changed (`<M>` → first parent) and the base side changed (`<M>` → second
   parent) are listed with `git diff-tree`; a path in both that matches the prose
   patterns stops the chain. By default that is every `*.md` except `index.md`;
   the CLI's `--prose-paths` changes it, and an empty list turns the rule off.

**Why prose is special.** merge-safety already forces an update whenever `main`
changed a file the PR also changed, so the overlapping merge is always made and
verified here. For code, a clean merge that breaks something is caught by CI
(see below). For prose, nothing automatic checks that two concurrent edits to a
page still read correctly together, so that merge costs a new review instead.
The walk's `stoppedBecause` names the files, so the reviewer knows what to
re-read. Index pages are exempt because they take routine concurrent appends,
which a clean merge gets right.

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

**Fails closed.** Any API or git error (including a failure to list either
side's changed files), git older than 2.40, a missing binary, or
a chain longer than 20 steps means no carry-over, which costs an extra review and
never produces a false approval. The walk runs only when some review sits on an
earlier commit, and stops as soon as every such commit is reached.

**Semantic breakage is covered by the state order, not by this rule.** A
textually clean merge can still break the build; failing CI outranks every
verdict, so a carried approval on a broken head becomes `ci-failing`. While CI
runs, the carried approval keeps the PR `approved` and armed, which is safe
because GitHub's auto-merge waits for required checks.

## Rebased heads

A force-push takes the reviewed commit `S` out of the branch's history, which is
what `@dependabot rebase` does, so the merge walk can't reach it. Without this
rule, a Dependabot major that already got its human sign-off would lose it to
every rebase. A reviewed commit the walk didn't reach also counts for the head
`H` when `H` is a **verified clean rebase** of it (`src/github/lineage-rebase.ts`):

1. `S` is **not** in `H`'s history. A commit that is in it is the merge walk's to
   judge, step by step.
2. **The base only moved forward.** `S`'s merge base with the base branch is an
   ancestor of (or equal to) `H`'s merge base with it. A head moved onto an
   older base is rejected.
3. **`H`'s tree is byte-identical to the automatic replay** of `S`'s change onto
   `H`'s base: `git merge-tree --write-tree --merge-base=<base of S> S <base of H>`,
   which must also report no conflicts. This is the tree a clean update-branch
   merge would have produced, so the rule grants nothing the merge rule doesn't.
   An extra edit, a hand-resolved conflict, a dependency re-resolved to different
   versions, or a rebase onto anything but the base branch fails.
4. **The prose rule applies as it does to a merge.** If `S`'s change and the
   base's progress since `S` both edited the same prose file, the approval doesn't
   carry.

The reviewed commit is the marker's `pr_head` when there is one, for the same
reason as in [Verdicts](reconciler-design.md#verdicts): `commit_id` is re-pointed after a force-push.
Validated on rmartz/personal-budget#562 (a happy-dom major rebased after
sign-off): the replayed tree matched the new head byte for byte.

**Bounded and contained.** Anyone can post a review naming any commit, so:

- only reviews by a `User` that parse as a verdict are considered;
- a non-hex `pr_head` is skipped before it reaches an API path or git's argv;
- at most `MAX_REBASE_CHECKS` (3) commits are checked, newest review first;
- an error in one check (say, a 404 for a commit GitHub doesn't have) rejects only
  that check, never the merge walk or another review's check.

The trust rules don't change: the review must still come from a trusted author.
Like the merge rule, a rebase whose content checks out but breaks the build is
caught by CI, which outranks every verdict. A wrong rejection only costs a review.

Carry-over runs when the caller supplies a git runner (`GatherOptions.lineage`).
The CLI always does; library callers that omit it simply get no carry-over.
