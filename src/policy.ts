/**
 * How a repo wants its PRs reconciled: the caller's options, separate from the
 * PR's facts (src/facts.ts). See docs/reconciler-design.md.
 */

export interface ReconcilePolicy {
  /**
   * When set, only these logins (case-insensitive) may author a counting verdict,
   * in addition to the write-permission requirement. It narrows trust and never
   * widens it.
   */
  trustedAuthors?: readonly string[];
  /** Arm/disarm native auto-merge from the lifecycle state. Off by default. */
  armAutoMerge?: boolean;
  /**
   * Bring an approved PR up to date with `update-branch` when merge-safety labels
   * it `update required`. A Dependabot PR is never updated (see `UpdateAction`).
   * Off by default.
   */
  autoUpdate?: boolean;
  /**
   * Don't wait for requested bot reviewers (e.g. Copilot) before
   * `review-requested`. Rarely needed: a bot that won't review is never requested.
   * Off by default. Deprecated: the wait now ends on its own; kept so existing
   * callers keep working.
   */
  skipCopilotReview?: boolean;
  /**
   * Required checks whose *pending* is a hold on a human act, not a running build;
   * their failures still count. Defaults to `DEFAULT_HOLD_CHECKS` (src/ci.ts).
   */
  holdChecks?: readonly string[];
  /** Required checks the CI gate never counts. Defaults to `DEFAULT_IGNORED_CHECKS`. */
  ignoredChecks?: readonly string[];
  /**
   * The repo's UAT setting, which also turns on reconciling the UAT labels
   * (docs/uat.md): `on` holds a PR without a UAT decision at `UAT pending` until
   * it is signed off, and `off` gives every PR `no UAT needed`. Absent, the UAT
   * labels are neither read nor written. The CLI passes `on` unless `--uat off`.
   */
  uat?: UatSetting;
  /**
   * The format version of the `pr-lifecycle/sign-off` status
   * (docs/sign-off-status.md). Defaults to `v1`. Post `v2` only once the repo's
   * pr-policy accepts it (`@rmartz/pr-policy` 1.8.0): an older one holds every
   * PR on an unknown version.
   */
  signOffStatus?: SignOffStatusVersion;
}

export const UAT_SETTINGS = ['off', 'on'] as const;
export type UatSetting = (typeof UAT_SETTINGS)[number];

/** The sign-off status description's format versions (docs/sign-off-status.md). */
export const SIGN_OFF_STATUS_VERSIONS = ['v1', 'v2'] as const;
export type SignOffStatusVersion = (typeof SIGN_OFF_STATUS_VERSIONS)[number];
