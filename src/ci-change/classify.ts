/**
 * The classifier: given the before/after text of every CI workflow file a pull
 * request touches, decide whether the change **tightens** or **loosens** CI.
 *
 * Deciding this in code rather than by a reviewer reading the diff removes the
 * two failure modes an LLM-judged gate has: it cannot
 * be skipped (nothing has to remember to run a review), and it cannot misread a
 * diff. It is deliberately trigger-happy — see {@link containsAll}.
 */
import { parse } from 'yaml';
import type { FileChange } from '../facts.js';
import {
  ambiguousIndicator,
  looseningIndicator,
  type CiChangeVerdict,
  type Indicator,
} from './indicators.js';
import { jobIndicators } from './job-rules.js';
import { containsAll, normalizeUses, type Node } from './structure.js';
import { topLevelIndicators, triggerIndicators } from './workflow-rules.js';

/** One workflow file's before/after text. */
export type WorkflowFileChange = FileChange;

/** The verdict for a pull request, with the evidence that produced it. */
export interface Classification {
  verdict: CiChangeVerdict;
  indicators: Indicator[];
}

function parseWorkflow(text: string): { doc: Node } | { error: string } {
  try {
    return { doc: parse(text) as Node };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Every indicator for a single workflow file. */
export function classifyWorkflowFile(change: WorkflowFileChange): Indicator[] {
  const { path, baseText, headText } = change;

  // A deleted workflow takes every check in it away — the plainest loosening there is.
  if (headText === undefined) {
    if (baseText === undefined) return [];
    return [
      looseningIndicator(
        'workflow-removed',
        path,
        path,
        'The workflow file was deleted, removing every check it defined.',
      ),
    ];
  }

  // A brand-new workflow only adds coverage.
  if (baseText === undefined) return [];

  const before = parseWorkflow(baseText);
  const after = parseWorkflow(headText);
  if ('error' in after) {
    return [
      ambiguousIndicator(
        'unparseable',
        path,
        path,
        `The workflow could not be parsed at head, so its change cannot be classified: ${after.error}`,
      ),
    ];
  }
  if ('error' in before) {
    return [
      ambiguousIndicator(
        'unparseable',
        path,
        path,
        `The workflow could not be parsed at the merge base, so its change cannot be classified: ${before.error}`,
      ),
    ];
  }

  const found = [
    ...triggerIndicators(path, before.doc, after.doc),
    ...topLevelIndicators(path, before.doc, after.doc),
    ...jobIndicators(path, before.doc, after.doc),
  ];
  if (found.length > 0) return found;

  // Nothing named fired. Only call it tightening if the head document still
  // contains everything the base one did (ignoring action version refs) — i.e.
  // the change is additive or cosmetic. Anything else is a structural edit no
  // rule recognised, and the directive says to treat that as a loosening.
  if (containsAll(normalizeUses(before.doc), normalizeUses(after.doc))) return [];
  return [
    ambiguousIndicator(
      'unclassified-change',
      path,
      path,
      'The workflow changed in a way that is not purely additive and matches no known tightening pattern.',
    ),
  ];
}

/** The pull-request-wide verdict across every workflow file it touches. */
export function classifyWorkflowChanges(changes: readonly WorkflowFileChange[]): Classification {
  if (changes.length === 0) return { verdict: 'no-change', indicators: [] };
  const indicators = changes.flatMap(classifyWorkflowFile);
  return { verdict: indicators.length > 0 ? 'loosening' : 'tightening', indicators };
}
