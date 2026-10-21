---
type: Library
title: CI loosening
description: How pr-lifecycle decides whether a PR's workflow changes loosen CI — the loosening, ambiguous, and tightening indicators it detects structurally, the containment backstop, and how the verdict feeds the sign-off status.
resource: src/ci-change/classify.ts
tags: [ci-change, classification, sign-off, loosening]
---

# CI loosening

`src/ci-change/` classifies a PR's `.github/workflows/**` diff as tightening or
loosening. It is ported, with its tests, from pr-policy's `ci-change` check,
which this package now owns: the verdict is the `loosening` field of the
[sign-off status](sign-off-status.md), and a loosening under a `ci:` title makes
the requirement `ci`.

Each changed workflow is read at the **merge base** and the head
(`src/github/sign-off-facts.ts`). A deleted workflow is a loosening; a new one
only adds coverage. A rename within the workflows is a change of that workflow,
and a move out of them is a removal. A changed workflow whose text wasn't read,
or more than 20 changed workflows, counts as a loosening: a modified file
mistaken for a new one would never be classified as loosening.

## How classification works

Classification is **structural**. Both sides of every changed workflow file are
parsed into a document tree, and the rules compare those trees. A line-regex over
a unified diff cannot tell a removed step from a reindented one, or a shrunk
matrix from a reformatted list.

Any indicator at all — loosening **or** ambiguous — produces the `loosening`
verdict, and so `loosening=yes` in the [sign-off status](sign-off-status.md).
The two classes are kept apart only so a reader can tell which was seen.

## Loosening indicators

| Indicator                 | Fires when                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `workflow-removed`        | A workflow file is deleted, taking every check in it away.                                                                          |
| `job-removed`             | A job key present at the merge base is absent at head. A renamed job reads as one.                                                  |
| `step-removed`            | A job lost a step (see [step identity](#step-identity)).                                                                            |
| `continue-on-error-added` | `continue-on-error` became truthy on a job or step that did not have it.                                                            |
| `if-added`                | An `if:` appeared on a job or step that previously always ran.                                                                      |
| `trigger-narrowed`        | An `on:` event disappeared; an inclusive filter lost entries or appeared where there was none; an `*-ignore` filter gained entries. |
| `matrix-reduced`          | A matrix dimension disappeared or lost values, or `exclude` gained a combination.                                                   |
| `needs-reduced`           | A job stopped waiting on a dependency.                                                                                              |

`continue-on-error` counts as enabled for **any** value that is not absent and
not literal `false` — including a `${{ }}` expression, whose value is unknowable
statically and must not be read as "off".

## Ambiguous indicators

The CI directive says to treat these as loosening, because none can be shown to
be benign from the diff alone.

| Indicator             | Fires when                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `runs-on-changed`     | A job's runner target changed.                                                                     |
| `permissions-changed` | A workflow- or job-level `permissions` block changed.                                              |
| `env-changed`         | A workflow-, job-, or step-level `env` block changed.                                              |
| `timeout-changed`     | A `timeout-minutes` changed, in either direction.                                                  |
| `unparseable`         | A file could not be parsed at head or at the merge base, so nothing can be compared.               |
| `unclassified-change` | The change is not purely additive and matched no rule — the [backstop](#the-containment-backstop). |

A raised timeout is itself a loosening under the CI directive, which is why
`timeout-changed` fires on any change rather than only on an increase.

## Tightening and maintenance

These produce no indicator, and so no loosening:

- Steps or jobs only added; a brand-new workflow file.
- Action version bumps (`uses: actions/checkout@v4` → `@v5`).
- New trigger events, branches, paths, or matrix dimensions.
- Comment-only or purely cosmetic edits.
- Steps reordered — reordering is not a loosening.

## Step identity

Steps are paired across revisions by a stable key, not by index: an insertion
near the top of a job would otherwise report every step after it as removed. The
key is the first of `id:`, `name:`, `uses:` (with its `@ref` stripped), `run:`,
and finally the step's own serialized content.

A step whose identifying field is _edited_ therefore reads as a replacement
rather than a modification — the old key vanishes and a new one appears. That is
not reported as `step-removed`, because the containment backstop catches the edit
first and reports it as `unclassified-change`; either way the change is gated.

## The containment backstop

When no named rule fires, the classifier asks one more question: **does the head
document still contain everything the base one did?** If yes, the change is
additive or cosmetic, and the verdict is `tightening`. If no, something
structural changed that no rule recognises, and the verdict is `loosening` via
`unclassified-change`.

Containment is recursive and order-insensitive for sequences, and it compares
`uses:` values with their `@ref` stripped, so a Dependabot action bump does not
trip it. A node that merely _gained_ a field still contains its base version — a
step that acquired `continue-on-error: false` is the same step grown, not a
removal plus an addition.

This backstop is what makes the classifier deliberately trigger-happy, and that
is the intended posture. A false positive costs a person one sign-off on a
change they were going to look at anyway. A false negative merges a CI loosening with no
sign-off at all.

## Scope

Only `.github/workflows/**/*.yml` and `.yaml` are classified
(`src/ci-change/workflow-paths.ts`). A composite action
under `.github/actions/` can change behaviour too, but it is invoked _by_ a
workflow step, so a change there that matters shows up here — and widening the
scope would put a human sign-off gate on every consuming repo's Action edits.
