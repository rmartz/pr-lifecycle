/**
 * Whether a changed workflow is a **shipped reusable workflow**: one whose only
 * trigger is `workflow_call`. In an action or reusable-workflow repo that file
 * is the product consumers call, not the repo's own CI, so the UAT path rules
 * don't exempt it. Ported from pr-policy (`src/checks/title/workflow-change.ts`
 * there), which draws the same line for its UAT and title checks.
 */
import { parse } from 'yaml';
import type { FileChange } from '../facts.js';
import type { Node } from './structure.js';
import { triggersOf } from './workflow-rules.js';

function parsed(text: string): { doc: Node } | undefined {
  try {
    return { doc: parse(text) as Node };
  } catch {
    return undefined;
  }
}

/**
 * Judged on the head content (the base content, for a deletion). Only the
 * trigger is inspected: a `workflow_call`-only file the repo also calls by local
 * path reads as shipped, which only ever asks for UAT, never skips it.
 */
export function isShippedReusableWorkflow(change: FileChange): boolean {
  const text = change.headText ?? change.baseText;
  if (text === undefined) {
    return false;
  }
  const result = parsed(text);
  if (result === undefined) {
    return false;
  }
  const events = Object.keys(triggersOf(result.doc) ?? {});
  return events.length === 1 && events[0] === 'workflow_call';
}
