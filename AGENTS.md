# Agent guide — @rmartz/pr-lifecycle

This repo is the home of `@rmartz/pr-lifecycle`: an event-driven reconciler that
recomputes a pull request's lifecycle state from its current facts on every GitHub
event, converges its labels to match, and arms native auto-merge when a PR reaches
`approved`. It is being built per
[rmartz/ai-tools#306](https://github.com/rmartz/ai-tools/issues/306); the design,
constraints, and open questions are summarized in
[docs/overview.md](docs/overview.md).

Because an approval here **authorizes a merge**, correctness and security bugs are
merge-authorization bugs. Test accordingly (see §Testing).

## Documentation lifecycle — every task

Docs live in [`docs/`](docs/index.md) as an OKF bundle. They are part of the
change, not an afterthought.

**On task start — read.** Before editing code, read [docs/index.md](docs/index.md),
then every page relevant to what you are touching, so your change is consistent
with what is documented and you don't re-derive a decision already recorded.

**On task finish — extend, update, trim.** Before opening the PR:

- **Extend.** New behavior, module, CLI flag, workflow input, label, or decision
  gets documented — a new page (with OKF frontmatter, linked from its directory's
  `index.md`) or a section on an existing one.
- **Update.** Anything your change contradicts is corrected in the same PR. An
  outdated doc is worse than none.
- **Trim.** Delete what is no longer true or no longer earns its place: resolved
  open questions (replace with the decision), "not yet implemented" notes for
  things now implemented, superseded plans, duplicated prose (link instead).
  Docs describe the current state; history belongs in git and PRs.
- **Correct drift you notice** along the way, or file an issue if out of scope.

Keep this file short — it is capped (see `.repo-hygiene.yml`) and only earns its
keep if agents read it. Put detail in `docs/` and link to it from here.

## Common commands

```bash
NODE_AUTH_TOKEN=$(gh auth token) pnpm install   # first, in every worktree
pnpm run build           # tsup → dist (ESM + d.ts)
pnpm run typecheck       # tsc --noEmit over src/ and test/
pnpm run lint            # eslint, type-aware (incl. max-lines caps)
pnpm run format:check    # prettier --check
pnpm run test            # vitest
pnpm run test:coverage   # vitest + enforced coverage thresholds (what CI runs)
pnpm run hygiene         # repo-hygiene checks (the pre-commit hook runs --staged)
```

`NODE_AUTH_TOKEN` authenticates the `@rmartz/repo-hygiene` devDependency from
GitHub Packages. Before pushing, run `ai-pre-push-verify -C <worktree>` and fix
every failure. Toolchain and CI details: [docs/development.md](docs/development.md).

## Code standards

Most are enforced by ESLint; the intent:

- **Strict TypeScript.** No `any`, no `@ts-ignore` (use `@ts-expect-error` with a
  reason). Favor type inference; explicit generic args are a smell.
- **Exhaustive state handling.** Switch over state/verdict unions without a
  `default` so `switch-exhaustiveness-check` flags a newly added member.
- **Pure core, thin edges.** State computation is a pure function of facts; all
  GitHub I/O lives at the edges behind an injected client so the core is testable
  without network or mocks of `fetch`.
- **Named exports only**; no default exports. No IIFEs. `async/await`, not `.then()`.
- **Value sets:** a structural string union or `as const` array over an `enum`
  (labels and verdicts cross the GitHub API boundary).
- **File caps:** `max-lines` 400 (src) / 600 (tests); split src at ~240. The
  response to a cap is extraction, never terser code.
- **Pin dependencies** to full `major.minor.patch` (caret kept — this is a
  published package) and **SHA-pin** every third-party Action with a `# vX.Y.Z`
  comment.

## Testing

See [docs/testing.md](docs/testing.md) for the full strategy. The rules:

- `describe`/`it` from Vitest (`test()` is lint-banned); fixtures via `make{Domain}()`.
- **Control inputs and outputs** — assert on explicit, non-default values.
- **One reason to fail per test.**
- **Every lifecycle state and every security rule gets a direct test**, including
  negative cases (a forged verdict marker from a non-allowlisted author must not
  approve; an approval bound to a stale head SHA must not count).
- **Idempotency/replay** — reconciling twice, or replaying events in any order,
  converges to the same labels.
- **Coverage thresholds are a floor, not a target.** Lowering one (or any other
  CI loosening) goes in its own dedicated PR, justified on its own merits.

## Repository conformance

This repo is held to the shared
[repository checklist](https://github.com/rmartz/ai/blob/main/docs/guidance/repository-checklist.md)
and **self-manages** its own config: fix conformance gaps directly here, in a PR.
Bootstrap (`ai-ensure-*`) is a one-time starter, not an ongoing manager.

## Worktrees, PRs, and releases

- **Work in a dedicated worktree** under `.git-worktrees/` (`ai-new-worktree`),
  never on `main` in the root checkout. (The one exception was the genesis commit,
  which had no prior branch to base a worktree on.)
- **PR titles must be Conventional Commits** (`feat:`, `fix:`, `docs:`, `ci:`, …).
  The repo squash-merges using the PR title, so it is the only conventional
  subject that reaches `main`; branch commits stay plain.
- **Releases are automated** by semantic-release on push to `main`: it publishes
  `@rmartz/pr-lifecycle` to npmjs and creates the `v*` tag + GitHub Release. Never
  bump the version or tag by hand. npm auth is OIDC trusted publishing tied to the
  `release.yml` filename (no `NPM_TOKEN`); renaming that workflow breaks
  publishing until the trusted publisher on npmjs is updated.

## Agent directive files

- **`AGENTS.md` is the single source of truth** for a directory's agent
  instructions — author directives here, never in `CLAUDE.md`.
- **Every `AGENTS.md` has a companion `CLAUDE.md`** in the same directory whose only
  content is `@AGENTS.md`. Enforced by the `md-pairing` check.
