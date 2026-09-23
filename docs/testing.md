---
type: Reference
title: Testing strategy
description: How pr-lifecycle is tested — a pure fact-to-state core, fact fixtures, per-state and security tests, replay/idempotency properties, and enforced coverage thresholds.
tags: [testing, vitest, coverage, conventions]
---

# Testing strategy

The reconciler decides when a PR may merge, so a missed branch is a potential
wrong merge. The test suite is designed around that.

## Shape of the code under test

- **A pure core.** State computation is a pure function from a PR's facts to its
  desired lifecycle state and label set. It takes no clients and does no I/O, so
  it is tested exhaustively with plain values.
- **Thin, injected edges.** Gathering facts and applying label/auto-merge changes
  go through a GitHub client interface passed in by the caller. Edge tests use a
  hand-written fake of that interface — never a mocked `fetch` or network.
- **A thin process shim.** `src/bin/` only wires argv/stdio/exit code to a tested
  module and is excluded from coverage for that reason.

## What every change must test

- **Each state, directly.** One table-driven case per lifecycle state, built from
  facts that produce exactly that state.
- **Security rules, including the negative case.** A verdict from a
  non-allowlisted author — even carrying a well-formed `skill-meta` marker — must
  not approve. An approval bound to a non-current head SHA must not count.
- **Replay and idempotency.** Reconciling the same facts twice yields no second
  change; applying event sequences in any order converges to the same labels.
- **No-op safety.** A PR whose labels already match its state produces no writes.

## Property-based tests

`test/properties.test.ts` uses [fast-check](https://fast-check.dev) to generate
random fact sets and policies and assert the core's guarantees hold for all of
them: idempotency, order independence, inertness of untrusted and stale reviews,
and scoped label writes. When you add a state, fact, or rule, extend the
arbitraries so the new input is generated, and add a property for any new
guarantee. Deterministic example tests still cover every state and rule directly:
a property shows an invariant holds, an example shows the intended behavior.

## Conventions

- `describe`/`it` from Vitest; `test()` is lint-banned.
- Fixture builders in `test/fixtures.ts` are named `make{Domain}()` (e.g.
  `makeFacts()`, `makeReview()`) and take overrides, so each test states only the
  facts it depends on. `applyPlan()` simulates applying a plan in pure-core tests.
- Edge-layer tests use `FakeGitHubClient` (`test/github/fake-client.ts`): an
  in-memory GitHub that mutates its state on writes (so gather → execute → gather
  round-trips), records every call in order (`calls`, `writes`), and injects
  failures with `failNext(method, error)`. The HTTP client is tested against a
  fake `fetch` transport passed through its options, never a mocked global.
- Assert on explicit, non-default values; one reason to fail per test.
- Test files live under `test/` and mirror `src/` paths
  (`src/verdict.ts` → `test/verdict.test.ts`).

## Coverage

`pnpm run test:coverage` (what CI's **Test** job runs) enforces the thresholds in
[`vitest.config.ts`](../vitest.config.ts). They are a floor, not a target: a
passing threshold does not mean a state is tested. Lowering a threshold is a CI
loosening and must land in its own dedicated PR with its own justification.
