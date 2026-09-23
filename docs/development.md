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

| Workflow                | Trigger                     | Gates                                                                                                        |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ci.yml`                | PR + push to `main`         | Typecheck, Lint, Format, Build, Test (with coverage)                                                         |
| `repo-hygiene.yml`      | PR + push to `main`         | conflict markers, action/package pins, docs links, AGENTS/CLAUDE pairing, OKF frontmatter + index, file caps |
| `pr-title-lint.yml`     | PR opened/edited/synced     | Conventional-Commit PR title, no `[WIP]`                                                                     |
| `merge-safety.yml`      | `pull_request_target`, push | the `merge-safety` check-run (base currency, conflicts)                                                      |
| `bot-automerge.yml`     | `pull_request_target`       | arms auto-merge on Dependabot patch/minor PRs                                                                |
| `commit-convention.yml` | push to `main`              | post-merge tripwire: every subject on `main` is conventional                                                 |
| `release.yml`           | push to `main`              | semantic-release publish + tag + GitHub Release                                                              |

Every job has a timeout; a hit is a signal to investigate, not a number to raise.
The default-branch ruleset requires the CI jobs, `Repo hygiene`,
`Validate PR title`, and `merge-safety`. Changing CI follows the fleet rules: a
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
release). Prettier and TypeScript bumps get their own PRs; everything else is
batched per dependency type. The npm entry authenticates to GitHub Packages via
the `DEPENDABOT_PACKAGES_TOKEN` **Dependabot** secret (separate from Actions
secrets); without it, all npm updates silently stop.

## Releases

A push to `main` runs semantic-release with the `conventionalcommits` preset on
both the commit analyzer and notes generator, so `feat` → minor, `fix` → patch,
`!` → major, and other types release nothing. It publishes to GitHub Packages and
creates the `v*` tag and GitHub Release using the built-in `GITHUB_TOKEN`. Because
the repo squash-merges with the PR title, the PR title is what determines the
release.
