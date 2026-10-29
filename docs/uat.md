---
type: Design
title: UAT labels
description: How pr-lifecycle resolves a PR's UAT sign-off on every event — the nine rules, why the review agent's verdict decides UAT instead of title or path heuristics, binding and carrying people's sign-offs, the attested pass after a hand-resolved conflict, and why the labels are for people.
resource: src/uat.ts
tags: [reconciler, uat, labels, sign-off, security]
---

# UAT labels

pr-lifecycle owns a PR's sign-off classification. On every reconcile it leaves
**exactly one** of `no UAT needed`, `UAT pending`, `UAT ready`, or `UAT passed`
on an open PR, so the label never goes stale between reviews. The labels are
for people. The decision reaches pr-policy, the gate, through the
[sign-off status](sign-off-status.md) on the head.

Source: `src/uat.ts` (the rules), `src/sign-off.ts` (the CI classification),
`src/uat-binding.ts` (binding a label to a head); the facts are gathered in
`src/github/uat-facts.ts`.

The CLI reconciles the UAT labels always, with `--uat on` by default (see
[the CLI](cli.md)). A library caller opts in with `policy.uat`; without it the
UAT labels are neither read nor written.

## Who decides

No title or changed path exempts a PR from UAT. Every PR that gets a review
gets an explicit UAT decision from it: `/review` records one on every pass, as
the `uat` dimension of its [verdict marker](verdicts.md#dimensions). A PR
approved without a review, through [bot eligibility](bot-eligibility.md), is
exempt instead. A person's sign-off outranks the agent's decision.

A static guess before any review used to stand in for that decision: title
exemptions (`docs`, `test`, `refactor`), a path fallback, and a rule that a
retitle drops a waiver. They are gone (#141). The path fallback existed only
because a bot-eligible PR reached `approved` with no review to waive UAT, and
rule 3 now covers that. The CI classification still reads paths, to tell a CI
change from a product change (see [the sign-off status](sign-off-status.md#the-classification)).

## Rules

Evaluated in order; the first that applies picks the label. The JSON
`uat.outcome` names the rule.

| #   | Condition                                                                                                                  | Outcome                | Label           |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------- |
| 1   | UAT is off for the repo (`--uat off`), and the PR isn't a CI change                                                        | `off`                  | `no UAT needed` |
| 2   | the PR is a [CI change](sign-off-status.md#the-classification): statically safe, or it needs the CI sign-off instead       | `ci`                   | `no UAT needed` |
| 3   | the PR is approved through [bot eligibility](bot-eligibility.md), with no verdict over it                                  | `exempt-auto-approved` | `no UAT needed` |
| 4   | the PR [holds an approval](#approval), and a trusted `UAT passed` is current for the head or a carried commit              | `passed`               | `UAT passed`    |
| 5   | the PR holds an approval, and the latest counting `uat` is `unchanged`, with a trusted `UAT passed` applied on `uat_since` | `passed-attested`      | `UAT passed`    |
| 6   | a trusted `no UAT needed` is current for the head or a carried commit                                                      | `waived`               | `no UAT needed` |
| 7   | the latest counting `uat` is `not-needed`                                                                                  | `waived-by-review`     | `no UAT needed` |
| 8   | the PR holds an approval                                                                                                   | `ready`                | `UAT ready`     |
| 9   | otherwise: no decision yet, `uat: required`, or a native approval with no marker                                           | `pending`              | `UAT pending`   |

- **Trusted** is the rule pr-policy applies to sign-off labels and this package
  applies to verdict authors: the actor is a `User` (never a `Bot`) with write,
  maintain, or admin permission, narrowed by `trusted-authors` when set. For a
  label, the actor is the one on its **latest** `labeled` event; a sign-off
  label with no `labeled` event on record counts as untrusted.
- **A counting `uat`** is the latest review that records the dimension, by the
  same trust and head-binding rules as a code verdict
  ([verdicts](verdicts.md#dimensions)). A review that leaves `uat` out doesn't
  change it, and dismissing a review revokes it.
- **A person outranks the agent** (rules 4–6 before 7). An agent's `required`
  can't revoke a person's waiver or pass, and a person who approves natively,
  with no marker, decides UAT with the labels.
- **Rule 3 ends at a verdict.** A person's `changes requested` on a bot PR, or
  any other verdict, puts it back under rules 4–9.
- **Rule 9 is a hold, not a guess.** `UAT pending` means nobody has decided yet.

Any UAT label the rules don't pick is removed, including an untrusted or stale
sign-off; that is how a stale label gets replaced.

**Draft PRs are classified too.** The UAT label describes the change, not the
review stage, so a draft PR shows `UAT pending`. A closed PR's labels are left
as its record.

### Always exactly one

**Invariant: every open PR carries exactly one UAT label after every reconcile,**
whatever its type, author, or state: a draft, a `[WIP]` PR, a Dependabot or
other bot PR, a fork PR, and a CI change all get one. With UAT off every PR
still records `no UAT needed`, so the determination is explicit rather than
implied by a missing label. The type system backs it (`uatLabelFor` returns a
label for every outcome), and so do the run conditions:

- the labels use `github-token`, so a missing `PR_LIFECYCLE_TOKEN` (or App
  token) skips the status and the release actions, never a label;
- a changed-file list that can't be read in full, for any reason but a
  transient outage, makes the PR not a CI change, which leaves it to rules 3–9
  rather than to no label; a status read that fails is treated as no status;
- a transient failure (a rate limit, an outage) fails the whole run so it is
  retried, and the next event writes the label.

The property tests check it across each UAT setting, review decision, drafts,
bot and Dependabot PRs, merge conflicts, failing CI, and unknown paths.

Every reader of the labels assumes one is there: the coordinator's UAT state,
`/merge`'s UAT rule, and `/review`. A `ci` PR with none read as "UAT
incomplete" and parked approved, green, signed-off PRs
(rmartz/firebase-nextjs-template#316).

### Approval

Rules 4, 5, and 8 ask whether the PR **holds an approval**: a counting
`approved` verdict on its head (or a carried commit). This is the approval
itself, not the `approved` lifecycle state. A failing check or a red base takes
the PR out of `approved` but can't change what a person tested, and both hold
the merge anyway, so they don't erase a `UAT passed`. A dismissed approval, or
a later `changes requested`, does.

## Sign-offs are bound to the head

A label records no commit, unlike a review, so "applied to this head" is a
comparison of times: the label's latest `labeled` time against when the head
**arrived**. A commit's arrival is the latest force-push that made it the head,
or else the creation of its first check suite **on the PR's branch**. Both are
times GitHub records and the author can't forge. Commit dates are never used,
and a suite on another branch doesn't count: the commit may have been pushed
there long before it reached the PR. Every comparison is strict and fails
closed: an unreadable time, an unknown arrival, or a force-push GitHub didn't
attribute (which could have made any commit the head) leaves the label unbound.

**Both sign-offs carry over** the commits
[approval carry-over](approval-carry-over.md) verified, just as an approval
does: `no UAT needed` and `UAT passed` alike. A clean auto-update after a
person's sign-off keeps it, so the PR doesn't wait for a re-test that nothing
could have changed. A push that changes the PR makes it stale, and
pr-lifecycle replaces it. For a carried commit `C`, the label must have been
applied while `C` was the head:

- after `C` arrived, and before the first force-push after that;
- and if there was such a push, that push must have replaced `C` itself. A push
  that replaced some other commit (read from the timeline's
  `HeadRefForcePushedEvent`, which names both sides) means an ordinary push came
  first, and the label may have been for that. With no force-push since `C`,
  every later head is a clean base merge on the chain back to `C`, so the label
  described the same change.

Carry-over is only verified for commits that had a verdict review, so a
sign-off carries over a rebase only from a reviewed commit.

### An attested pass

A change that isn't a verified clean update, such as a hand-resolved merge
conflict, makes `UAT passed` stale, and pr-lifecycle removes it. If the
resolution only re-applies the same change, the next review records
`"uat": "unchanged", "uat_since": "<sha>"`: the person's pass on `<sha>` still
holds. Rule 5 then restores `UAT passed` when:

- the PR holds an approval on its head;
- a trusted person's `UAT passed` was applied **while `<sha>` was the head**:
  after `<sha>` arrived, and before any other commit on the PR arrived or any
  later force-push. Any application in the label's history counts, not only the
  latest, since the label was removed when it went stale. The edge reads the
  label's whole history and the arrival of every commit on the PR, but only
  when some review records `unchanged`. A PR with more than 100 commits reads
  none of it, so the attestation fails closed.

`unchanged` builds on a person's pass and never replaces one: an agent never
records `passed`, because testing is a human act. It adds nothing to the
agent's trust either, since it could already post `not-needed`; it is the
honest record of "already tested, still holds".

## Labels are for people

Every UAT label write, adds and removals alike, uses `github-token`, like the
other lifecycle labels. pr-lifecycle's own `no UAT needed` and its restored
`UAT passed` are therefore applied by a `Bot`, and never read back as a
person's: rules 4 and 6 skip them, and rule 5 looks only for a person's
application. **Agents never write UAT labels**: a trusted `User` on the latest
`labeled` event is taken to be a person, which holds only while no agent writes
these labels with a person's token.

The gate doesn't read the labels under a `v2` [status](sign-off-status.md): it
trusts the sign-off reported there. Under `v1` it still reads a person's
`UAT passed` and `no UAT needed` itself, so rules 3 and 7 reach it only as
`requirement=none` (rule 3) or not at all (rule 7) until the fleet posts `v2`.

## Guaranteed properties (tested)

- **Exactly one.** After a plan is applied, an open PR carries exactly one UAT
  label, under either UAT setting ([Always exactly one](#always-exactly-one)).
- **Idempotent.** Applying a plan and re-planning yields no label changes.
- **Order-independent.** Permuting the sign-offs, force-pushes, or a label's
  history never changes the plan.
- **Untrusted sign-offs are inert.** A sign-off label from a bot or a
  non-writer is never kept, except where this package's own rules pick the
  same label.
