import type { ForcePushFact } from '../facts.js';
import { parseVerdict } from '../verdict.js';
import type { GitHubClient, ReviewData } from './client.js';

/**
 * The PR's force-pushes: the fact that catches a review GitHub moved onto a
 * rebased head after it was submitted (see `currentVerdict`). They can only stop
 * a verdict from counting, so the issue events are read only when one of the
 * reviews is a verdict, sparing the API call on every other run.
 */
export async function gatherForcePushes(
  client: Pick<GitHubClient, 'listForcePushes'>,
  pr: number,
  reviews: readonly ReviewData[],
): Promise<ForcePushFact[]> {
  const hasVerdict = reviews.some((review) => parseVerdict(review) !== undefined);
  return hasVerdict ? client.listForcePushes(pr) : [];
}
