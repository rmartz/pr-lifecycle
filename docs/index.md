---
okf_version: '0.2'
---

# Documentation

Documentation for `@rmartz/pr-lifecycle`, written in
[Open Knowledge Format](okf-format.md). Agents: read this index and the pages
relevant to your task before editing code — see
[AGENTS.md](../AGENTS.md#documentation-lifecycle--every-task).

- [What pr-lifecycle is](overview.md) — the event-driven lifecycle reconciler, its
  design constraints and settled decisions, how it relates to sibling packages,
  and the remaining open questions.
- [Reconciler core design](reconciler-design.md) — the pure facts → state → plan
  core: the fact model, verdict trust and head binding, state priority, the label
  and auto-merge plan, and the properties the tests guarantee.
- [Lifecycle routing design (v2)](lifecycle-routing-design.md) — the routing
  extension: what is built (CI gate, merge-conflict and base-health states) and
  what remains (approval carry-over across clean base updates, and auto-update).
- [GitHub edge layer](github-edge-layer.md) — gathering facts from and applying
  plans to GitHub: the client seam, permission mapping, fail-safe write order,
  tolerated errors, and the HTTP client.
- [Bot-PR eligibility](bot-eligibility.md) — which bot PRs count as approved
  without review, how the Dependabot update type is read, and why fork PRs are
  never eligible.
- [The `ai-pr-lifecycle` CLI](cli.md) — the `reconcile` command's flags,
  environment, exit codes, and the versioned `--json` contract the action builds
  on.
- [Testing strategy](testing.md) — how the reconciler is tested: pure state
  computation, fact fixtures, replay/idempotency, security cases, coverage.
- [Development and CI](development.md) — the toolchain, the CI jobs and what each
  gates, repo hygiene, Dependabot, and releases.
- [The OKF documentation format](okf-format.md) — how these pages are structured
  and validated in this repo.
