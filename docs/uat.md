---
type: Design
title: UAT labels
description: How pr-lifecycle reconciles the four UAT labels on every event — the six rules, the title-first exemption with a path fallback, binding sign-offs to the head with unforgeable push times, and why UAT label writes need the real-actor token.
resource: src/uat.ts
tags: [reconciler, uat, labels, sign-off, security]
---

# UAT labels

pr-lifecycle owns a PR's UAT classification. On every reconcile it leaves
**exactly one** of `no UAT needed`, `UAT pending`, `UAT ready`, or `UAT passed`
on an open PR, so the label never goes stale between reviews. pr-policy's UAT
gate then only has to require `no UAT needed` or `UAT passed`.

Source: `src/uat.ts` (the classifier), `src/uat-title.ts`, `src/uat-paths.ts`,
`src/uat-binding.ts`; the facts are gathered in `src/github/uat-facts.ts`.

The CLI reconciles the UAT labels always, with `--uat on` by default (see
[the CLI](cli.md)). A library caller opts in with `policy.uat`; without it the
UAT labels are neither read nor written.

## Rules

Evaluated in order; the first that applies picks the label. The JSON `uat.outcome`
names the rule.

| #   | Condition                                                                                                                    | Outcome                         | Label           |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------- |
| 1   | the repo's UAT setting is `off` (`--uat off`)                                                                                | `off`                           | `no UAT needed` |
| 2   | the PR [can't be user-facing](#which-prs-cant-be-user-facing)                                                                | `exempt-title` / `exempt-paths` | `no UAT needed` |
| 3   | the PR [holds an approval](#approval) and a trusted `UAT passed` is [current for the head](#sign-offs-are-bound-to-the-head) | `passed`                        | `UAT passed`    |
| 4   | a trusted `no UAT needed` is current for the head (or a carried commit)                                                      | `waived`                        | `no UAT needed` |
| 5   | the PR holds an approval                                                                                                     | `ready`                         | `UAT ready`     |
| 6   | otherwise                                                                                                                    | `pending`                       | `UAT pending`   |

**Trusted** is the rule pr-policy applies to sign-off labels and this package
applies to verdict authors: the actor on the label's **latest** `labeled` event
is a `User` (never a `Bot`) with write, maintain, or admin permission, narrowed
by `trusted-authors` when set. A sign-off label with no `labeled` event on
record counts as untrusted. Any UAT label the rules don't pick is removed,
including an untrusted or stale sign-off; that is how a stale label gets
replaced.

**Draft PRs are classified too.** The UAT label describes the change, not the
review stage, so a draft feature PR shows `UAT pending`. A closed PR's labels
are left as its record.

### Approval

Rules 3 and 5 ask whether the PR **holds an approval**: a counting `approved`
verdict on its head (or a carried commit), or [bot eligibility](bot-eligibility.md)
with no verdict over it. This is the approval itself, not the `approved`
lifecycle state. A failing check or a red base takes the PR out of `approved`
but can't change what a person tested, and both hold the merge anyway, so they
don't erase a `UAT passed`. A dismissed approval, or a later
`changes requested`, does.

## Which PRs can't be user-facing

The title type is checked first; the changed paths are only a fallback.

- **Exempt by title: `docs`, `test`, `refactor`, `ci`.** The title is parsed
  with pr-policy's Conventional-Commit grammar, so the two agree on its type.
  A type is listed only when pr-policy's title check holds it to its paths:
  `docs` to Markdown, `test` to tests, `refactor` to leaving tests alone, and
  `ci` to CI files. A false promise can't merge.
- **Every other type needs UAT by default**: `feat`, `fix`, `perf`, `revert`,
  `chore`, `build`, `style`, and a title that doesn't parse. This is an
  allowlist on purpose: an opt-in list of "UAT types" would let any unlisted type
  carry a user-facing change past UAT on the strength of a title its author
  chose. `revert` and `perf` change behavior in their own right. `chore` is out
  because "no behavior change" can't be checked by a path rule, so pr-policy
  doesn't enforce its paths and the title is an unchecked claim. A `chore:` PR
  the paths don't exempt is left to `/review`, which applies `no UAT needed`
  when it fits.
- **Path fallback, for those types only.** pr-policy's trivial-path rules,
  ported: Markdown and `docs/`, tests (including Storybook stories), lockfiles
  and `requirements*.txt`, a `package.json` that changes only dependency
  versions (its text is read at the merge base and the head), and repo metadata
  (`.github/` outside workflows, `.vscode/`, root `LICENSE`, `CODEOWNERS`, and
  ignore files). The fallback can only exempt, never require UAT. It matters
  because a bot PR can reach `approved` through bot eligibility with no review
  agent to waive it.
  - **One deliberate narrowing:** workflow and composite-action files
    (`.github/workflows/`, `.github/actions/`) never exempt. pr-policy tells a
    repo's own CI from a shipped reusable workflow by parsing the YAML; this
    package doesn't, and a `ci:` title already exempts the routine CI change.
  - **Fails closed.** An incomplete file listing (GitHub lists at most 3,000), or
    more than 10 changed manifests, exempts nothing.

The path rules are the UAT question only. They are kept apart from any
"safe to approve without review" predicate (#39): a change can need review but
not UAT (a refactor), and a change that needs UAT can still be waived by the
review agent. Only the changed-file listing is shared
(`src/github/changed-files.ts`).

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
pr-policy is to bind sign-offs from the same source (rmartz/pr-policy#85), so the
two never disagree about which head a label belongs to.

**A waiver** (`no UAT needed` from a person or the review agent) counts for the
head it was applied to, and carries over the commits
[approval carry-over](approval-carry-over.md) verified, just as an approval
does. A push that changes the PR makes it stale, pr-lifecycle replaces it with
`UAT pending`, and the next review re-applies it if it still holds. For a
carried commit `C`, the waiver must have been applied while `C` was the head:

- after `C` arrived, and before the first force-push after that;
- and if there was such a push, that push must have replaced `C` itself. A push
  that replaced some other commit (read from the timeline's
  `HeadRefForcePushedEvent`, which names both sides) means an ordinary push came
  first, and the waiver may have been for that. With no force-push since `C`,
  every later head is a clean base merge on the chain back to `C`, so the waiver
  described the same change.

Carry-over is only verified for commits that had a verdict review, so a waiver
carries over a rebase only from a reviewed commit.

**A retitle drops a waiver.** A waiver applied before the title last changed
doesn't count: the title may be what made the PR exempt. Without this, a
`docs:` PR carrying code would get pr-lifecycle's own `no UAT needed`, fail
pr-policy's title check, and keep the waiver after a retitle to `feat:`.
pr-lifecycle's own waiver (rules 1 and 2) is recomputed on every reconcile, so
it never goes stale itself.

**`UAT passed`** is stricter. It counts only for the exact head it was applied
to, and only while the PR holds an approval. Any new head, a lost approval, or
an application to an unapproved PR makes it stale, and pr-lifecycle replaces it
with `UAT pending` (or `UAT ready` once approved). It does **not** carry over a
verified clean rebase. A PR that was approved and passed UAT only gets a new
push for a rebase that resolves a conflict; that is usually safe, but a person
should look again. The cost, a re-test after a conflict rebase, is rare at that
stage. pr-policy enforces the binding too (rmartz/pr-policy#85), so the window
before this reconciler replaces a stale label can't let a merge through.

## Real-actor token

UAT label writes, adds and removals, go through `PR_LIFECYCLE_TOKEN`, the
[release token](cli.md#release-token), not `GITHUB_TOKEN`:

- pr-policy rejects a sign-off label applied by `github-actions[bot]`, so a
  waiver written with the workflow token would never pass the gate;
- a label written with `GITHUB_TOKEN` fires no `labeled` workflow run, so
  pr-policy wouldn't re-evaluate.

The release token is used for UAT labels and the release actions, and nothing
else (`UatLabelWrites` in `src/github/client.ts`).

**The waiver needs a person's token.** pr-policy trusts a sign-off only from a
`User`, so a `no UAT needed` applied with a GitHub App installation token (the
release token this repo recommends for merging) reads as a `Bot` and doesn't
pass its gate. pr-lifecycle's own classification doesn't depend on it, since it
recomputes rules 1 and 2 every run, but the gate does. Until pr-policy accepts
the lifecycle's own identity, a repo that relies on pr-lifecycle's waiver needs
a fine-grained PAT as the release token.

**Fails closed.** Without the token, pr-lifecycle never applies
`no UAT needed` (`withoutUatWaiver`). It still applies `UAT pending` or
`UAT ready`, and removes a stale sign-off, with `GITHUB_TOKEN`: none of those
passes the gate. An exempt PR then carries no UAT label. The skip is reported
like the arming skip: a stderr warning, `uatWaiverSkipped` in the JSON, and the
one-time [token advisory](cli.md#release-token) comment.

## Guaranteed properties (tested)

- **Exactly one.** After a plan is applied, an open PR carries exactly one UAT
  label.
- **Idempotent.** Applying a plan and re-planning yields no label changes.
- **Order-independent.** Permuting the sign-offs, force-pushes, or title
  changes never changes the plan.
- **Untrusted sign-offs are inert.** A sign-off label from a bot or a
  non-writer is never kept, except where this package's own exemption picks the
  same label.
- **`withoutUatWaiver` removes the waiver and nothing else.**
