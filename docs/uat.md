---
type: Design
title: UAT labels
description: How pr-lifecycle reconciles the four UAT labels on every event — what UAT is for (only the product's user-facing functional behavior; CI and tooling never), the six rules, the title-first exemption with a path fallback, binding sign-offs to the head with unforgeable push times, and why the labels are for people and written with the workflow token.
resource: src/uat.ts
tags: [reconciler, uat, labels, sign-off, security]
---

# UAT labels

pr-lifecycle owns a PR's sign-off classification. On every reconcile it leaves
**exactly one** of `no UAT needed`, `UAT pending`, `UAT ready`, or `UAT passed`
on an open PR, so the label never goes stale between reviews. A PR that needs
the CI sign-off instead gets `no UAT needed` (see
[Always exactly one](#always-exactly-one)). The labels are for people:
pr-policy, the gate, never reads them. The decision reaches it through the
[sign-off status](sign-off-status.md) on the head, and pr-policy reads only that
and the people's own sign-off labels.

## What UAT is for

**UAT is exclusively for the repository's product's user-facing functional
behavior**: what the product does that its users can observe. Nothing else
needs UAT. **Tooling is never user-facing, and CI is the clearest example.** A
workflow, a composite action, a repo script, or lint, formatter, test-runner,
or repo-hygiene config changes how the repo is built and checked, not what its
users see. So does a test, a doc, a dependency pin, or repo metadata.

"It can change what a check lets through" is not a reason to require UAT. That
is a CI-governance question, answered by the review and the CI sign-off
([CI loosening](ci-loosening.md), `CI approval needed`), never by UAT. The one
place a workflow is the product is a repo that ships it: a reusable workflow
(`workflow_call`-only) that consumers call is the product's behavior.

Source: `src/uat.ts` (the UAT rules), `src/sign-off.ts` (the classification),
`src/uat-title.ts`, `src/uat-paths.ts`, `src/uat-tooling.ts`,
`src/uat-binding.ts`; the facts are
gathered in `src/github/uat-facts.ts`.

The CLI reconciles the UAT labels always, with `--uat on` by default (see
[the CLI](cli.md)). A library caller opts in with `policy.uat`; without it the
UAT labels are neither read nor written.

## Rules

Evaluated in order; the first that applies picks the label. Rules 1 and 2 are
the [sign-off classification](sign-off-status.md#the-classification): `ci`,
or `none` (statically safe, or UAT off). Rules 3–6 apply to `requirement=uat`.
The JSON `uat.outcome` names the rule.

| #   | Condition                                                                                                                    | Outcome                         | Label           |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------- |
| 1   | the PR needs the CI sign-off instead (`requirement=ci`)                                                                      | `ci`                            | `no UAT needed` |
| 2   | the PR [can't be user-facing](#which-prs-cant-be-user-facing)                                                                | `exempt-title` / `exempt-paths` | `no UAT needed` |
| 2   | the repo's UAT setting is `off` (`--uat off`)                                                                                | `off`                           | `no UAT needed` |
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

### Always exactly one

**Invariant: every open PR carries exactly one UAT label after every reconcile,**
whatever its type, author, or state: a draft, a `[WIP]` PR, a Dependabot or
other bot PR, a fork PR, and a `ci` PR all get one. With UAT off (`--uat off`)
every PR still records `no UAT needed`, so the determination is explicit and
auditable rather than implied by a missing label. The type system backs it
(`uatLabelFor` returns a label for every outcome), and so do the run conditions:

- the labels use `github-token`, so a missing `PR_LIFECYCLE_TOKEN` (or App
  token) skips the status and the release actions, never a label;
- a changed-file list that can't be read in full, for any reason but a
  transient outage, counts as unknown, which fails closed to `UAT pending`
  rather than to no label; a status read that fails is treated as no status;
- a transient failure (a rate limit, an outage) fails the whole run so it is
  retried, and the next event writes the label. A closed PR's labels are left
  as its record.

The property tests check it across each requirement, each UAT setting, drafts,
bot and Dependabot PRs, merge conflicts, failing CI, and unknown paths.

Every reader of the labels assumes one is there: the coordinator's UAT state,
`/merge`'s UAT rule, and `/review`. A `ci` PR with none read as "UAT incomplete" and parked
approved, green, signed-off PRs, and the reconciler stripped a hand-applied
`no UAT needed` within seconds (rmartz/firebase-nextjs-template#316).

`no UAT needed` is true for a `ci` PR: it needs the CI sign-off instead, which
`CI approval needed` shows. That matches `off` and the exemptions. The gate is
unaffected: pr-policy reads only the [sign-off status](sign-off-status.md), and
a bot-applied `no UAT needed` never counts as a person's waiver. The `ci`
outcome stays distinct in the status, in `CI approval needed`, and in `--json`.

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

- **Exempt by title: `docs`, `test`, `refactor`.** The title is parsed with
  pr-policy's Conventional-Commit grammar, so the two agree on its type. A type
  is listed only when pr-policy's title check holds it to its paths: `docs` to
  Markdown, `test` to tests, and `refactor` to leaving tests alone. A false
  promise can't merge.
- **`ci` is exempt from UAT only by going to the CI sign-off.** A `ci:` PR is
  statically safe when its workflow changes don't [loosen CI](ci-loosening.md)
  and every other path is trivial; otherwise it needs `CI change approved`,
  never UAT (see [the classification](sign-off-status.md#the-classification)).
- **Every other type needs UAT by default**: `feat`, `fix`, `perf`, `revert`,
  `chore`, `build`, `style`, and a title that doesn't parse. This is an
  allowlist on purpose: an opt-in list of "UAT types" would let any unlisted type
  carry a user-facing change past UAT on the strength of a title its author
  chose. `revert` and `perf` change behavior in their own right. `chore` is out
  because "no behavior change" can't be checked by a path rule, so pr-policy
  doesn't enforce its paths and the title is an unchecked claim. The paths
  decide instead: a `chore:` that touches only tooling is exempt by them (see
  [below](#ci-and-tooling)). One the paths don't exempt is left to `/review`,
  which applies `no UAT needed` when it fits.
- **Path fallback, for those types only.** pr-policy's trivial-path rules,
  ported: Markdown and `docs/`, tests (including Storybook stories), lockfiles
  and `requirements*.txt`, a `package.json` that changes only dependency
  versions (its text is read at the merge base and the head), and repo metadata
  (`.github/` outside workflows, `.vscode/`, root `LICENSE`, `CODEOWNERS`, and
  ignore files). The fallback can only exempt, never require UAT. It matters
  because a bot PR can reach `approved` through bot eligibility with no review
  agent to waive it.
  - **Fails closed.** An incomplete file listing (GitHub lists at most 3,000), or
    more than 10 changed manifests, exempts nothing.

### CI and tooling

Under any title but `ci`, a PR whose every path is either trivial (above) or
the repo's own CI and tooling needs no UAT (`requirement=none`, reason
`tooling-paths`, label `no UAT needed`). Tooling is never user-facing
([What UAT is for](#what-uat-is-for)). The tooling paths (`src/uat-tooling.ts`)
match pr-policy's `ci`, `tooling-config`, and `repo-script` path kinds:

- `.github/workflows/**`, except a **shipped reusable workflow**: one whose only
  trigger is `workflow_call`, which is the product a reusable-workflow repo's
  consumers call. A workflow whose text wasn't read, or won't parse, counts as
  product (fails closed);
- `.github/actions/**`, the repo's composite actions;
- linter, formatter, test-runner, and repo-tooling config by file name at any
  depth (`eslint.config.*`, `.prettierrc*`, `vitest.config.*`,
  `.repo-hygiene.yml`, `.pre-commit-config.yaml`, `.releaserc*`, …);
- the repo's own scripts under a top-level `scripts/` (audits, CI checks,
  release helpers).

Build, app, and deploy config (`tsconfig.json`, `next.config.*`, bundler
config, `vercel.json`) and `package.json` fields outside the dependency blocks
are product: they decide what ships.

A CI loosening in such a PR is still reported (`loosening=yes`) and still
needs `CI change approved`: governance stays with the CI sign-off. Under a
`ci:` title, tooling beyond the trivial paths still needs the CI sign-off
([the classification](sign-off-status.md#the-classification)); that is CI
governance too, and never UAT.

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

## Labels are for people

Every UAT label write, adds and removals alike, uses `github-token`, like the
other lifecycle labels. Nothing about the labels needs a real actor:

- pr-policy never trusts a label this package wrote. Its gate reads the
  [`pr-lifecycle/sign-off` status](sign-off-status.md), which is posted with
  `PR_LIFECYCLE_TOKEN`, and the sign-off labels people apply themselves.
- pr-policy re-runs when that status arrives, so a label edit doesn't need to
  fire a `labeled` run to wake it.

So a missing `PR_LIFECYCLE_TOKEN` changes nothing here: every UAT label,
including this package's own `no UAT needed`, is still written. The missing
token holds the gate instead, because no [status](sign-off-status.md) is posted.

## Guaranteed properties (tested)

- **Exactly one.** After a plan is applied, an open PR carries exactly one UAT
  label, under either UAT setting ([Always exactly one](#always-exactly-one)).
- **Idempotent.** Applying a plan and re-planning yields no label changes.
- **Order-independent.** Permuting the sign-offs, force-pushes, or title
  changes never changes the plan.
- **Untrusted sign-offs are inert.** A sign-off label from a bot or a
  non-writer is never kept, except where this package's own exemption picks the
  same label.
