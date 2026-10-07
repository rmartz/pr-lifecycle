import { ESCALATION_LABEL } from '../state.js';
import { parseVerdict } from '../verdict.js';
import type { GitHubClient, LabelRemovalData, ReviewData } from './client.js';

/**
 * Who removed `escalation needed`, and when: the fact that lets a person resolve
 * an escalation by removing its label (see `currentVerdict`). Only an escalation
 * verdict can be resolved this way, so the issue events are read only when one of
 * the reviews is one, sparing the API call on every other run. Author trust is
 * decided later, in the core.
 */
export async function gatherEscalationRemovals(
  client: Pick<GitHubClient, 'listLabelRemovals'>,
  pr: number,
  reviews: readonly ReviewData[],
): Promise<LabelRemovalData[]> {
  const escalated = reviews.some((review) => parseVerdict(review)?.verdict === 'escalation-needed');
  return escalated ? client.listLabelRemovals(pr, ESCALATION_LABEL) : [];
}
