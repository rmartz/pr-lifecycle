---
type: Design
title: UAT gate
description: The opt-in `uat` check-run a consumer ruleset can require — where the UAT requirement comes from (the head-bound verdict, not a label), the human-only `UAT passed` / `no UAT needed` overrides and how their actor is verified, and the decisions behind it.
tags: [reconciler, design, uat, check-run, security]
---

# UAT gate

**Status: built** (`src/uat.ts`, posted by `src/github/uat-check.ts`; the
decisions are from #25). UAT is the one merge gate this package owns
([overview](overview.md#design-constraints)). It becomes a check-run so a
consumer's ruleset can require it, and native auto-merge then waits on it like
any other required check.

## Where the requirement comes from

`/review` already decides whether a PR needs a human to test it. It records that
decision as a `uat` field in its verdict's `skill-meta` marker:

```text
<!-- skill-meta: {"skill": "review", "outcome": "approved", "uat": "required", ...} -->
```

The requirement is read from the **latest counting verdict**, found with the same
trust and head-binding rules as the verdict itself
([Verdicts](reconciler-design.md#verdicts)), so it carries over a clean base
update along with its verdict ([carry-over](reconciler-design.md#approval-carry-over)).
It is **not** inferred from labels. `/review` posts the verdict and then the UAT
label, and with arming on, a PR that is `approved` with no label yet could merge
in that window.

| Source                                                                | Requirement  |
| --------------------------------------------------------------------- | ------------ |
| latest counting verdict has `"uat": "exempt"`                         | not required |
| latest counting verdict has `"uat": "required"`                       | required     |
| latest counting verdict has no `uat` field (or an unknown value)      | required     |
| no counting verdict, and the PR is [bot-eligible](bot-eligibility.md) | not required |
| no counting verdict otherwise                                         | required     |

**Missing means required (fail closed).** A native GitHub approval and every
verdict posted before rmartz/dotfiles#1583 emits the field therefore require
UAT. Turn the gate on in a repo only after `/review` emits `uat`; otherwise every
PR needs a human override. An eligible bot PR has no verdict to read, and bot
eligibility already stands in for review, so it stands in for the UAT decision
too.

## Human overrides

Two labels pass a required gate. Both are human judgments, and are **inputs**:
the reconciler reads them and never adds or removes them.

| Label           | Meaning                                             |
| --------------- | --------------------------------------------------- |
| `UAT passed`    | A person tested the PR.                             |
| `no UAT needed` | UAT was requested; a person is waiving it untested. |

Until rmartz/dotfiles#1572 finishes the fleet rename, `tested` is read as
`UAT passed` (and `ready for UAT` as `UAT ready`, though the gate doesn't read
it). Automation never applies either override: rmartz/dotfiles#1583 drops the
`/review` path that applied `no UAT needed` to exempt PRs, since exempt is now
the verdict's `uat` field.

**Actor check.** An override counts only if the **latest** timeline `labeled`
event for it names a `User` (not a `Bot` or GitHub App) with `write`, `maintain`,
or `admin` permission, the same trust rule as verdicts. Triage permission can
label a PR but can't merge one, so it can't pass the gate either.

Coordinator agents act with the user's personal token, so an agent-applied
override is indistinguishable from the user's own. For now that is held by
convention (automation never applies the overrides); moving agents to a
separate identity is tracked in rmartz/dotfiles#1585.

## The check-run

- **Name:** `uat`. The name is a fleet contract that rulesets reference, like
  `merge-safety`.
- **Opt-in:** `--uat-gate` (`policy.uatGate`), off by default like
  `--arm-auto-merge`. Only consumers who enable it need `checks: write` on the
  workflow token.
- **Result:** posted on the head SHA. It is `success` when UAT is not required,
  or when it is required and an override counts. Otherwise it stays
  `in_progress` (a hold, not a failure), with a summary saying what it's waiting
  for. It never fails.
- **Arming waits for it.** With `--arm-auto-merge`, an `approved` PR is armed
  only once the gate passes, and an armed PR whose gate starts holding (a new
  verdict requires UAT) is disarmed. So UAT holds the merge even in a repo whose
  ruleset doesn't require `uat` yet, and a stale `success` on the head can never
  let a direct merge through.
- **CI never waits on it.** The CI gate always treats `uat` as a hold check, so a
  pending `uat` never keeps a PR in `awaiting-ci` (see
  [CI gate](reconciler-design.md#ci-gate)).
- **Posted only when it changes,** before any arm, with the workflow token. A PAT
  can't create check-runs (see [Execute](github-edge-layer.md#execute)).
- **Triggers:** the `labeled`/`unlabeled` and review events the reconciler
  already runs on.
- **Rulesets:** require `uat` from the GitHub Actions app, so a `uat` check
  posted by any other app can't satisfy it.

## Open questions

- Should an override be bound to the head? `UAT passed` applied before a later
  push still counts today, as the label does in the fleet now. The latest
  `/review` verdict re-decides whether UAT is required on every new head, but not
  whether the earlier test still covers it.
