import type { ReconcilePolicy } from '../facts.js';
import type { UatOverrideFact } from '../uat.js';
import { overrideForLabel, UAT_CHECK_NAME } from '../uat.js';
import type { CheckRunData, GitHubClient, LabelEventData, PullRequestData } from './client.js';
import { lookupPermission } from './permissions.js';

/**
 * Gathers the UAT gate's facts: the override labels on the PR with who last
 * applied each (from the issue events, since the label itself records nobody),
 * and the `uat` check-runs already on the head, so an unchanged gate isn't
 * posted again. Nothing is read unless the gate is on. See docs/uat-gate.md.
 */

export interface UatFacts {
  overrides: UatOverrideFact[];
  checks: CheckRunData[];
}

const NO_UAT: UatFacts = { overrides: [], checks: [] };

/** The latest `labeled` event for a label name; re-applying a label replaces who applied it. */
function latestLabeling(
  events: readonly LabelEventData[],
  name: string,
): LabelEventData | undefined {
  let latest: LabelEventData | undefined;
  for (const event of events) {
    if (event.label === name && (latest === undefined || event.createdAt >= latest.createdAt)) {
      latest = event;
    }
  }
  return latest;
}

async function toOverrideFact(
  client: GitHubClient,
  events: readonly LabelEventData[],
  name: string,
): Promise<UatOverrideFact | undefined> {
  const label = overrideForLabel(name);
  if (label === undefined) {
    return undefined;
  }
  const event = latestLabeling(events, name);
  if (event?.login === undefined) {
    // Nobody verifiable applied it, so it can't count.
    return { label, appliedBy: undefined };
  }
  // Bots can never pass the gate, so they skip the permission lookup.
  const permission = event.type === 'User' ? await lookupPermission(client, event.login) : 'none';
  return { label, appliedBy: { login: event.login, type: event.type, permission } };
}

async function gatherOverrides(
  client: GitHubClient,
  pr: number,
  labels: readonly string[],
): Promise<UatOverrideFact[]> {
  const names = labels.filter((name) => overrideForLabel(name) !== undefined);
  if (names.length === 0) {
    return [];
  }
  const events = await client.listLabelEvents(pr);
  const facts = await Promise.all(names.map((name) => toOverrideFact(client, events, name)));
  return facts.filter((fact) => fact !== undefined);
}

export async function gatherUatFacts(
  client: GitHubClient,
  pr: number,
  pull: PullRequestData,
  policy: ReconcilePolicy,
): Promise<UatFacts> {
  if (policy.uatGate !== true || pull.state !== 'open') {
    return NO_UAT;
  }
  const [overrides, runs] = await Promise.all([
    gatherOverrides(client, pr, pull.labels),
    client.listCheckRuns(pull.headSha),
  ]);
  return { overrides, checks: runs.filter((run) => run.name === UAT_CHECK_NAME) };
}
