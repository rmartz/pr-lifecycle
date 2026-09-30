# @rmartz/pr-lifecycle

An **event-driven pull-request lifecycle reconciler** for GitHub Actions. On every
relevant GitHub event it recomputes a PR's lifecycle state from the PR's current
facts — draft status, pending bot review requests, the latest verdict from a
trusted author and the head SHA it reviewed — converges the PR's labels to match,
and **arms GitHub-native auto-merge when the PR reaches `approved`**. The
consumer's branch ruleset (required checks) then decides when the merge lands.

It joins the same family as
[`@rmartz/merge-safety`](https://github.com/rmartz/merge-safety),
[`@rmartz/repo-hygiene`](https://github.com/rmartz/repo-hygiene), and
[`@rmartz/bot-automerge`](https://github.com/rmartz/bot-automerge): a small
TypeScript package distributed as a version-pinned action that Dependabot keeps
current in consuming repos.

It is run in consumer repos by
[`rmartz/pr-lifecycle-action`](https://github.com/rmartz/pr-lifecycle-action). The
design is in [docs/overview.md](docs/overview.md), and the `pr-lifecycle` CLI is
documented in [docs/cli.md](docs/cli.md).

## Documentation

See [docs/index.md](docs/index.md). Contributors (human or agent) should start with
[AGENTS.md](AGENTS.md).

## Requirements

- Node.js >= 22
- pnpm 10 (pinned via `packageManager`)

Consuming repos will need neither — the published action runs on a GitHub-hosted
runner.

## Local development

```bash
NODE_AUTH_TOKEN=$(gh auth token) pnpm install
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test:coverage
pnpm run hygiene
```

## Releases

Versioned by [semantic-release](.releaserc.json): a push to `main` analyzes the
Conventional-Commit history since the last `v*` tag and, when a release is
warranted, publishes the package to npmjs (public, via OIDC trusted publishing
with provenance) and creates the tag and GitHub Release. Versions up to 5.0.0
were published to GitHub Packages and stay there for existing pins.

## License

[MIT](LICENSE)
