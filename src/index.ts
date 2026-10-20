export {
  classifyBotPr,
  DEPENDABOT_LOGIN,
  DEPENDABOT_UPDATE_TYPES,
  parseDependabotUpdateType,
  RELEASE_PLEASE_BRANCH_PREFIX,
} from './bot-eligibility.js';
export type {
  BotEligibility,
  BotPrCommit,
  BotPrFacts,
  BotPrType,
  DependabotUpdateType,
} from './bot-eligibility.js';
export { EXIT_TRANSIENT, runCli, USAGE } from './cli.js';
export type { CliDeps, CliIo } from './cli.js';
export { parseArgs } from './cli/args.js';
export type { ParsedArgs, ReconcileArgs } from './cli/args.js';
export { formatSummary, SCHEMA_VERSION, toReconcileJson } from './cli/output.js';
export type { ReconcileJson, ReconcileTarget } from './cli/output.js';
export {
  ACTOR_TYPES,
  BRANCH_UPDATERS,
  PR_STATUSES,
  REPO_PERMISSIONS,
  REVIEW_STATES,
  UAT_SETTINGS,
  UAT_SIGN_OFF_LABELS,
} from './facts.js';
export type {
  ActorType,
  BranchUpdater,
  FileChange,
  ForcePushFact,
  UatSetting,
  UatSignOffFact,
  UatSignOffLabel,
  PullRequestFacts,
  PullRequestStatus,
  ReconcilePolicy,
  RepoPermission,
  ReviewAuthor,
  ReviewFact,
  ReviewState,
} from './facts.js';
export { GitHubApiError, isApiStatus, isTransientError } from './github/client.js';
export type {
  CheckSuiteData,
  CollaboratorPermission,
  CommitData,
  GitHubClient,
  LabelApplicationData,
  LabelDefinition,
  PullRequestData,
  ReleaseActions,
  ReviewData,
  UatLabelWrites,
} from './github/client.js';
export {
  DEPENDABOT_REBASING_NOTICE,
  DEPENDABOT_RECREATING_NOTICE,
  isDependabotRebasing,
} from './github/dependabot-rebase.js';
export { executePlan } from './github/execute.js';
export type { ExecuteOutcome, PlanTarget } from './github/execute.js';
export { gatherFacts } from './github/gather.js';
export type { GatheredPullRequest } from './github/gather.js';
export { createHttpClient } from './github/http-client.js';
export type { HttpClientOptions } from './github/http-client.js';
export { OWNED_LABEL_DEFINITIONS } from './github/label-roster.js';
export { gatherLineage, MAX_CHAIN_STEPS, MAX_REBASE_CHECKS } from './github/lineage-facts.js';
export type { Lineage, LineageInput } from './github/lineage-facts.js';
export { checkCleanRebase } from './github/lineage-rebase.js';
export type { RebaseCheck, RebaseInput } from './github/lineage-rebase.js';
export { reconcilePullRequest } from './github/reconcile.js';
export { DEFAULT_SETTLE_MS } from './github/settle.js';
export type { SettleOptions } from './github/settle.js';
export { classifyReleaseDiff, isVersionOnlyPatch } from './release-diff.js';
export type { ChangedFile, ReleaseDiffVerdict } from './release-diff.js';
export type { ReconcileOptions, ReconcileResult } from './github/reconcile.js';
export {
  buildTokenAdvisoryBody,
  postTokenAdvisory,
  RELEASE_TOKEN_DOCS_URL,
  TOKEN_ADVISORY_MARKER,
} from './github/token-advisory.js';
export type { SkippedForToken } from './github/token-advisory.js';
export type { GatherOptions } from './github/gather.js';
export { createGitRunner, parseGitVersion } from './lineage/git.js';
export type { GitResult, GitRunner } from './lineage/git.js';
export {
  DEFAULT_PROSE_PATTERNS,
  overlappingProse,
  proseMatcher,
  proseOverlapReason,
} from './lineage/prose.js';
export type { ProseMatcher } from './lineage/prose.js';
export { createMergeVerifier, isObjectId } from './lineage/verify.js';
export type { MergeStep, MergeVerifier, RepoSource } from './lineage/verify.js';
export {
  AUTO_MERGE_LABEL,
  DEPENDABOT_REBASING_LABEL,
  LIFECYCLE_LABELS,
  planReconcile,
  UPDATE_REQUIRED_LABEL,
  withoutReleaseActions,
  withoutUatWaiver,
} from './plan.js';
export type { AutoMergeAction, LifecycleLabel, ReconcilePlan, UpdateAction } from './plan.js';
export { computeState, LIFECYCLE_STATES } from './state.js';
export type { LifecycleState } from './state.js';
export {
  classifyUat,
  exemptionOf,
  hasApproval,
  NO_UAT_NEEDED_LABEL,
  UAT_LABELS,
  UAT_OUTCOMES,
  UAT_PASSED_LABEL,
  UAT_PENDING_LABEL,
  UAT_READY_LABEL,
  uatLabelFor,
} from './uat.js';
export type { UatLabel, UatOutcome } from './uat.js';
export { isRetitledSince, isSignOffCurrent } from './uat-binding.js';
export { isTestPath, LOCKFILES, TRIVIAL_CATEGORIES, trivialCategories } from './uat-paths.js';
export type { TrivialCategory } from './uat-paths.js';
export { COMMIT_TYPES, isUatExemptTitle, titleType, UAT_EXEMPT_TYPES } from './uat-title.js';
export type { CommitType } from './uat-title.js';
export { currentVerdict, isTrustedAuthor, parseVerdict, VERDICTS } from './verdict.js';
export type { ParsedVerdict, Verdict } from './verdict.js';
