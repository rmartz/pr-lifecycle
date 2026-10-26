import type { ReviewFact } from './facts.js';
import { isObjectId } from './object-id.js';

/**
 * Verdict marker parsing. A review is a verdict when it carries a /review
 * `skill-meta` marker with at least one readable dimension, or (with no marker) a
 * native APPROVED / CHANGES_REQUESTED state. A marker records each decision of a
 * review pass as its own dimension (#141): `code` (the verdict) and `uat`. See
 * docs/reconciler-design.md §Verdicts.
 */

export const VERDICTS = ['approved', 'blocked', 'changes-requested', 'escalation-needed'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const UAT_VERDICTS = ['not-needed', 'required', 'unchanged'] as const;

/**
 * A review's UAT decision. `unchanged` says a person's `UAT passed` on `since`
 * still holds for the reviewed commit: nothing since then changes behavior.
 */
export type UatVerdict =
  { kind: 'not-needed' } | { kind: 'required' } | { kind: 'unchanged'; since: string };

export interface VerdictRecord {
  /** The code verdict, or undefined when this review doesn't update it. */
  code: Verdict | undefined;
  /** The UAT decision, or undefined when this review doesn't update it. */
  uat: UatVerdict | undefined;
  /** The head SHA the marker says was reviewed, when the marker names one. */
  markerHead: string | undefined;
}

// Review bodies are attacker-controlled (anyone can comment), so the marker is
// located with a linear scan: this pattern matches only the marker opening (no
// overlapping quantifiers), and the payload runs to the next `-->` via indexOf.
// A single `<!--\s*skill-meta:\s*(.*?)\s*-->` regex backtracks cubically on an
// unterminated marker padded with whitespace (CodeQL js/polynomial-redos).
const SKILL_META_OPENING = /<!--\s*skill-meta:/;
const COMMENT_CLOSE = '-->';

type Payload = Readonly<Record<string, unknown>>;

// The hyphenated verdict names are the canonical marker outcomes. The legacy
// spelling older /review markers carry (`changes requested`) is still read.
// `blocked` is a verdict of its own: the change is ready but waits on another PR
// or issue, and the next /review lifts it when that closes (#81).
const LEGACY_MARKER_OUTCOMES: Readonly<Record<string, Verdict>> = {
  'changes requested': 'changes-requested',
};

// A /review pass that deliberately did nothing: not a verdict.
const SKIPPED_OUTCOME = 'skipped';

function isPayload(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The verdict a /review marker's outcome expresses, or undefined for `skipped`.
 * Any other outcome, including a missing or non-string one, fails closed to
 * `escalation-needed`: a /review verdict that can't be read must never let an
 * earlier approval stand, so a human looks at it.
 */
function markerVerdict(outcome: unknown): Verdict | undefined {
  if (outcome === SKIPPED_OUTCOME) {
    return undefined;
  }
  if (typeof outcome !== 'string') {
    return 'escalation-needed';
  }
  const canonical = VERDICTS.find((verdict) => verdict === outcome);
  if (canonical !== undefined) {
    return canonical;
  }
  return Object.hasOwn(LEGACY_MARKER_OUTCOMES, outcome)
    ? LEGACY_MARKER_OUTCOMES[outcome]
    : 'escalation-needed';
}

/**
 * The UAT decision a marker records. Any value it can't read, including
 * `unchanged` without a valid `uat_since` commit, fails closed to `required`: an
 * unreadable UAT decision must never let an earlier waiver stand.
 */
function markerUat(meta: Payload, verdicts: Payload): UatVerdict | undefined {
  if (!Object.hasOwn(verdicts, 'uat')) {
    return undefined;
  }
  const uat = verdicts.uat;
  if (uat === 'not-needed') {
    return { kind: 'not-needed' };
  }
  const since = meta.uat_since;
  if (uat === 'unchanged' && typeof since === 'string' && isObjectId(since)) {
    return { kind: 'unchanged', since };
  }
  return { kind: 'required' };
}

/**
 * A marker's dimensions. With a `verdicts` map, each dimension it names is
 * updated and each it leaves out isn't: a review may record only its UAT
 * decision. Its code verdict falls back to `outcome`, so a marker may carry both
 * while the tooling migrates. A map naming neither dimension records nothing
 * readable, so it is read like a legacy marker and fails closed the same way.
 * Without a map (or with one that isn't an object), the marker is a legacy one:
 * `outcome` is the code verdict, and there is no UAT decision.
 */
function markerDimensions(meta: Payload): Pick<VerdictRecord, 'code' | 'uat'> {
  const verdicts = meta.verdicts;
  if (!isPayload(verdicts)) {
    return { code: markerVerdict(meta.outcome), uat: undefined };
  }
  let code: Verdict | undefined;
  if (Object.hasOwn(verdicts, 'code')) {
    code = markerVerdict(verdicts.code);
  } else if (Object.hasOwn(meta, 'outcome') || !Object.hasOwn(verdicts, 'uat')) {
    code = markerVerdict(meta.outcome);
  }
  return { code, uat: markerUat(meta, verdicts) };
}

function readSkillMeta(body: string): Payload | undefined {
  const opening = SKILL_META_OPENING.exec(body);
  if (opening === null) {
    return undefined;
  }
  const payloadStart = opening.index + opening[0].length;
  const payloadEnd = body.indexOf(COMMENT_CLOSE, payloadStart);
  if (payloadEnd === -1) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body.slice(payloadStart, payloadEnd).trim());
    return isPayload(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Every dimension a review records, or undefined when it is not a verdict. */
export function parseVerdictRecord(
  review: Pick<ReviewFact, 'body' | 'state'>,
): VerdictRecord | undefined {
  // A dismissed review was revoked by a maintainer, and a pending one was never
  // submitted: neither is a verdict, whatever its body's marker says.
  if (review.state === 'DISMISSED' || review.state === 'PENDING') {
    return undefined;
  }
  const meta = readSkillMeta(review.body);
  if (meta?.skill === 'review') {
    // A /review marker is authoritative, including `skipped` (not a verdict)
    // and an unreadable outcome (escalation).
    const { code, uat } = markerDimensions(meta);
    if (code === undefined && uat === undefined) {
      return undefined;
    }
    const markerHead = typeof meta.pr_head === 'string' ? meta.pr_head : undefined;
    return { code, uat, markerHead };
  }
  switch (review.state) {
    case 'APPROVED':
      return { code: 'approved', uat: undefined, markerHead: undefined };
    case 'CHANGES_REQUESTED':
      return { code: 'changes-requested', uat: undefined, markerHead: undefined };
    case 'COMMENTED':
      return undefined;
  }
}
