---
type: Reference
title: Development and CI
description: The pr-lifecycle toolchain, each CI workflow and what it gates, repo hygiene and the pre-commit hook, GitHub Packages auth, Dependabot, and semantic-release.
tags: [ci, tooling, dependabot, releases, conventions]
---

# Development and CI

## Toolchain

| Concern  | Tool                                                                  |
| -------- | --------------------------------------------------------------------- |
| Language | TypeScript 6, strict (`tsconfig.json` type-checks `src/` and `test/`) |
| Build    | tsup → ESM + `.d.ts` in `dist/` (`tsconfig.build.json`)               |
| Lint     | ESLint flat config, type-aware (`eslint.config.mjs`)                  |
| Format   | Prettier (`.prettierrc.json`)                                         |
| Test     | Vitest + v8 coverage with enforced thresholds                         |
| Packages | pnpm (version pinned by `packageManager`)                             |
| Releases | semantic-release (`.releaserc.json`)                                  |
| Hygiene  | `@rmartz/repo-hygiene` (CI action + pre-commit hook)                  |

Node 24 runs CI; the package supports Node ≥ 22.

## GitHub Packages auth

The `@rmartz/repo-hygiene` devDependency is published to GitHub Packages, so
`pnpm install` needs a token. The repo-root [`.npmrc`](../.npmrc) reads it from
`NODE_AUTH_TOKEN`:

```bash
NODE_AUTH_TOKEN=$(gh auth token) pnpm install
```

In CI the shared setup action (`.github/actions/setup`) passes the job's
`GITHUB_TOKEN`, which is why CI jobs grant `packages: read`. The `.npmrc` also
pins npmjs as the base registry so Dependabot resolves public packages correctly.

## CI workflows

| Workflow                | Trigger                     | Gates                                                                                                                                       |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                | PR + push to `main`         | Typecheck, Lint, Format, Build, Test (with coverage)                                                                                        |
| `release-check.yml`     | PR                          | `release-check / release-check`: the release config works with the shared semantic-release-ci toolchain                                     |
| `repo-hygiene.yml`      | PR + push to `main`         | conflict markers, action/package pins, docs links, AGENTS/CLAUDE pairing, OKF frontmatter + index, file caps                                |
| `merge-safety.yml`      | `pull_request_target`, push | the `merge-safety` check-run (base currency, conflicts)                                                                                     |
| `pr-policy.yml`         | `pull_request_target`       | runs `rmartz/pr-policy-action` with `skip-uat: true` (nothing here to user-test): the required `pr-policy` check (title rules, CI sign-off) |
| `pr-lifecycle.yml`      | PR, review, CI completion   | dogfoods the published reconciler: lifecycle labels, and arms auto-merge on `approved`                                                      |
| `commit-convention.yml` | push to `main`              | post-merge tripwire: every subject on `main` is conventional                                                                                |
| `release.yml`           | push to `main`              | shared semantic-release-ci workflow: publish + tag + GitHub Release                                                                         |

Every job has a timeout; a hit is a signal to investigate, not a number to raise.
The default-branch ruleset requires the CI jobs, `Repo hygiene`,
`merge-safety`, `release-check / release-check`, and
`pr-policy`. PR titles are checked by pr-policy's `title` check, part of the
`pr-policy` check. Changing CI follows the fleet rules: a
change that loosens CI (removing a job, `continue-on-error`, lowering a coverage
threshold, raising a timeout) lands alone in its own `ci:` PR.

## Repo hygiene

Every check in [`.repo-hygiene.yml`](../.repo-hygiene.yml) runs at `error`
severity. The same check list runs in two places:

- **Pre-commit** — `.husky/pre-commit` runs `pnpm run hygiene:staged` over staged
  content (installed by the `prepare` script on `pnpm install`).
- **CI** — the Repo Hygiene workflow, via the SHA-pinned
  `rmartz/repo-hygiene-action`.

> **Known gap:** the CI path is currently vacuous. `repo-hygiene-action` runs the
> CLI through npm's `node_modules/.bin` symlink, and the CLI exits 0 there without
> running any check ([rmartz/repo-hygiene#67](https://github.com/rmartz/repo-hygiene/issues/67)).
> The pre-commit hook is unaffected (pnpm's shim execs the real path), so it is
> the working gate until a fixed action version arrives via Dependabot. Remove
> this note once the fix lands.

## Dependabot

[`.github/dependabot.yml`](../.github/dependabot.yml) updates npm and GitHub
Actions weekly. Commit prefixes follow what each change ships: production npm
deps use `fix` (cuts a patch release), dev deps and Actions use `chore` (no
release). Prettier and TypeScript bumps get their own PRs. Other patch and minor
bumps are batched, per dependency type for npm and in one group for Actions, so
the reconciler can approve and arm them as eligible bot PRs. Every major gets its
own PR for review, so a pending major never holds the routine bumps back. The npm
entry authenticates to GitHub Packages via
the `DEPENDABOT_PACKAGES_TOKEN` **Dependabot** secret (separate from Actions
secrets); without it, all npm updates silently stop.

## Pilot read-out

`pnpm run pilot-readout [owner/repo ...] [--json]` measures the labels-only pilots
of the fleet rollout (#75) against the arming criteria agreed there. By default it
covers personal-budget, hidden-role-game and group-picks. For each repo, starting
from when `pr-lifecycle.yml` landed on its default branch, it reports:

- **Window:** working days elapsed and PRs merged, against the agreed threshold of
  5 working days or 15 merged PRs.
- **`reconcile` runs:** succeeded, cancelled (superseded), awaiting approval, and
  held runs GitHub later failed without starting a job. Only a run that ran a job
  and failed counts as a failure.
- **Label checks:** whether each merged PR, and each settled open PR, carries the
  label matching the latest `/review` verdict on its head. The verdict is read
  with this package's own `parseVerdict`, which is why the script builds first.
  PRs with no verdict on the head, or whose CI state outranks the verdict, are
  reported as not comparable.
- **Routing cases:** PRs the reconciler labelled `fix required`, `ci failing`,
  `blocked`, or `escalation needed`. Checking that the coordinator routed them
  sensibly is the one criterion left to a person.

It calls only the REST API (through `gh api`), so it works while the GraphQL quota
is exhausted. It is rollout tooling under `scripts/`, not part of the published
package.

## Releases

A push to `main` runs semantic-release with the `conventionalcommits` preset on
both the commit analyzer and notes generator, so `feat` → minor, `fix` → patch,
`!` → major, and other types release nothing. It publishes to npmjs through OIDC
trusted publishing (no `NPM_TOKEN`) and creates the `v*` tag and GitHub Release
using the built-in `GITHUB_TOKEN`. Because
the repo squash-merges with the PR title, the PR title is what determines the
release.

**The release toolchain lives in
[semantic-release-ci](https://github.com/rmartz/semantic-release-ci) and is
verified on every PR.** `release.yml` calls its shared release workflow, and the
toolchain (`semantic-release`, its plugins and the changelog preset) is **not** in
this repo's `package.json`. semantic-release only runs on `main`, after merge, so a
broken release config would otherwise surface only as a failed publish. The
required **`release-check / release-check`** check
([`release-check.yml`](../.github/workflows/release-check.yml)) loads
`.releaserc.json` the way semantic-release does and renders notes and analyzes
commits through the real plugins of the shared toolchain. It needs no token, no
network and no push, so it works on Dependabot and fork PRs. A
`semantic-release --dry-run` is deliberately not used: on a PR branch it exits
before rendering notes (a false pass), and forcing it onto the branch runs a
push-permission check that fails on the read-only token Dependabot PRs get.

This guard exists because the break already happened once:
`conventional-changelog-conventionalcommits` 10.x needs a newer
`conventional-changelog-writer` than semantic-release 25 ships, and every Release
run on `main` failed until the preset was pinned back to 9.x. A toolchain bump like
that is now tested once, in semantic-release-ci, and never reaches this repo's pin
unless it renders.
