import type { ForcePushFact } from '../facts.js';
import { parseVerdict } from '../verdict.js';
import type { GitHubClient, ReviewData } from './client.js';

/**
 * The PR's force-pushes: the fact that catches a review GitHub moved onto a
 * rebased head after it was submitted (see `currentVerdict`), and that binds a
 * UAT sign-off to the head it was applied to (src/uat-binding.ts). They can only
 * stop a verdict or a sign-off from counting, so the timeline is read only when
 * one of the reviews is a verdict or a sign-off label is present
 * (`forSignOff`), sparing the API call on every other run.
 */
export async function gatherForcePushes(
  client: Pick<GitHubClient, 'listForcePushes'>,
  pr: number,
  reviews: readonly ReviewData[],
  forSignOff = false,
): Promise<ForcePushFact[]> {
  const hasVerdict = reviews.some((review) => parseVerdict(review) !== undefined);
  return hasVerdict || forSignOff ? client.listForcePushes(pr) : [];
}
