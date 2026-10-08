#!/usr/bin/env node
// Read-out for the pr-lifecycle labels-only pilots (rmartz/pr-lifecycle#75).
//
// For each pilot repo it measures, since the day `pr-lifecycle.yml` landed on the
// default branch, the arming criteria agreed on #75:
//   - window: 5 working days or 15 merged PRs, whichever comes first;
//   - no failed `reconcile` run (cancelled runs, and held runs GitHub later fails
//     without starting a job, are counted but not failures);
//   - no PR whose lifecycle label disagrees with its `/review` verdict once the
//     reconciler has caught up;
//   - a list of PRs that carried `fix required`, `ci failing`, `blocked` or
//     `escalation needed`, to check the coordinator routed them sensibly. That
//     criterion needs a person's judgment, so the script only gathers the cases.
//
// REST only (via `gh api`), so it runs while the GraphQL quota is exhausted.
// Verdicts are read with the package's own `parseVerdict`, so build first:
//   pnpm run build && node scripts/pilot-readout.mjs [owner/repo ...] [--json]

import { execFileSync } from 'node:child_process';

import { parseVerdict } from '../dist/index.js';

const DEFAULT_REPOS = ['rmartz/personal-budget', 'rmartz/hidden-role-game', 'rmartz/group-picks'];
const WINDOW_WORKING_DAYS = 5;
const WINDOW_MERGED_PRS = 15;
// An open PR updated more recently than this may not have been reconciled yet.
const SETTLE_MS = 15 * 60 * 1000;
const RECONCILER = 'github-actions[bot]';

const VERDICT_LABEL = {
  approved: 'approved',
  blocked: 'blocked',
  'changes-requested': 'changes requested',
  'escalation-needed': 'escalation needed',
};
const VERDICT_LABELS = new Set(Object.values(VERDICT_LABEL));
// States that outrank a verdict on an open PR: the verdict label is absent by design.
const OUTRANKING_LABELS = ['fix required', 'ci failing'];
const ROUTING_LABELS = ['fix required', 'ci failing', 'blocked', 'escalation needed'];

function gh(path) {
  const out = execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out);
}

/** Every page of a list endpoint, flattened. `key` picks the list out of an object page. */
function ghAll(path, key) {
  const out = execFileSync('gh', ['api', '--paginate', '--slurp', path], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  const pages = JSON.parse(out);
  return pages.flatMap((page) => (key === undefined ? page : page[key]));
}

/** When `pr-lifecycle.yml` first landed on the default branch, or undefined. */
function pilotStart(repo, branch) {
  const commits = ghAll(
    `repos/${repo}/commits?sha=${branch}&path=.github/workflows/pr-lifecycle.yml&per_page=100`,
  );
  const oldest = commits.at(-1);
  return oldest === undefined ? undefined : new Date(oldest.commit.committer.date);
}

/** Monday–Friday days elapsed between two dates. */
function workingDaysBetween(start, end) {
  let days = 0;
  const cursor = new Date(start);
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (cursor <= end && weekday !== 0 && weekday !== 6) {
      days += 1;
    }
  }
  return days;
}

/**
 * The verdict label a PR should carry: the latest `/review` verdict a User posted on
 * the head, mapped to its label. Trust is approximated as "a User, not a Bot"; the
 * pilots' verdicts come from the owner's token. Undefined when there is none.
 */
function expectedVerdictLabel(reviews, headSha) {
  let latest;
  for (const review of reviews) {
    if (review.user?.type !== 'User' || review.commit_id !== headSha) {
      continue;
    }
    const parsed = parseVerdict({ body: review.body ?? '', state: review.state });
    if (
      parsed === undefined ||
      (parsed.markerHead !== undefined && parsed.markerHead !== headSha)
    ) {
      continue;
    }
    if (latest === undefined || Date.parse(review.submitted_at) >= Date.parse(latest.at)) {
      latest = { verdict: parsed.verdict, at: review.submitted_at };
    }
  }
  return latest === undefined ? undefined : { label: VERDICT_LABEL[latest.verdict], at: latest.at };
}

/** Whether a person removed `escalation needed` after the escalation (#79). */
function escalationResolved(events, since) {
  return events.some(
    (event) =>
      event.event === 'unlabeled' &&
      event.label?.name === 'escalation needed' &&
      event.actor?.type === 'User' &&
      Date.parse(event.created_at) > Date.parse(since),
  );
}

function checkPullRequest(repo, pr, now) {
  const labels = pr.labels.map((label) => label.name);
  const events = ghAll(`repos/${repo}/issues/${pr.number}/events?per_page=100`);
  const routing = ROUTING_LABELS.filter((name) =>
    events.some(
      (event) =>
        event.event === 'labeled' &&
        event.label?.name === name &&
        event.actor?.login === RECONCILER,
    ),
  );
  const result = { number: pr.number, title: pr.title, merged: pr.merged_at !== null, routing };

  if (pr.merged_at === null) {
    if (pr.draft || now - Date.parse(pr.updated_at) < SETTLE_MS) {
      return { ...result, check: 'skipped (draft or still settling)' };
    }
    if (OUTRANKING_LABELS.some((name) => labels.includes(name))) {
      return { ...result, check: 'skipped (fix required / ci failing outranks the verdict)' };
    }
  }
  const reviews = ghAll(`repos/${repo}/pulls/${pr.number}/reviews?per_page=100`);
  const expected = expectedVerdictLabel(reviews, pr.head.sha);
  if (expected === undefined) {
    return { ...result, check: 'no /review verdict on the head' };
  }
  let want = expected.label;
  if (want === 'escalation needed' && escalationResolved(events, expected.at)) {
    want = undefined;
  }
  const present = labels.filter((name) => VERDICT_LABELS.has(name));
  const agrees =
    want === undefined ? present.length === 0 : present.length === 1 && present[0] === want;
  return {
    ...result,
    check: agrees ? 'agrees' : 'MISMATCH',
    expected: want ?? '(none: escalation resolved)',
    present,
  };
}

function checkRuns(repo, since) {
  const runs = ghAll(
    `repos/${repo}/actions/workflows/pr-lifecycle.yml/runs?created=>=${since.toISOString()}&per_page=100`,
    'workflow_runs',
  );
  const counts = {
    total: runs.length,
    success: 0,
    cancelled: 0,
    held: 0,
    heldFailed: 0,
    failed: [],
  };
  for (const run of runs) {
    if (run.conclusion === 'success') counts.success += 1;
    else if (run.conclusion === 'cancelled') counts.cancelled += 1;
    else if (run.conclusion === 'action_required' || run.status === 'waiting') counts.held += 1;
    else if (run.conclusion === 'failure') {
      // A held run GitHub fails without ever starting a job is not a reconcile failure.
      const jobs = gh(`repos/${repo}/actions/runs/${run.id}/jobs`);
      if (jobs.total_count === 0) counts.heldFailed += 1;
      else counts.failed.push({ id: run.id, url: run.html_url, event: run.event });
    }
  }
  return counts;
}

function readRepo(repo, now) {
  const branch = gh(`repos/${repo}`).default_branch;
  const start = pilotStart(repo, branch);
  if (start === undefined) {
    return { repo, started: false };
  }
  const closed = ghAll(
    `repos/${repo}/pulls?state=closed&base=${branch}&sort=updated&direction=desc&per_page=100`,
  ).filter((pr) => pr.merged_at !== null && Date.parse(pr.merged_at) >= start.getTime());
  const open = ghAll(`repos/${repo}/pulls?state=open&base=${branch}&per_page=100`);
  const prs = [...closed, ...open].map((pr) => checkPullRequest(repo, pr, now));
  const runs = checkRuns(repo, start);
  const workingDays = workingDaysBetween(start, new Date(now));
  const windowMet = workingDays >= WINDOW_WORKING_DAYS || closed.length >= WINDOW_MERGED_PRS;
  const mismatches = prs.filter((pr) => pr.check === 'MISMATCH');
  return {
    repo,
    started: true,
    start: start.toISOString(),
    workingDays,
    merged: closed.length,
    windowMet,
    runs,
    prs,
    mismatches,
    routingCases: prs.filter((pr) => pr.routing.length > 0),
    passes: windowMet && runs.failed.length === 0 && mismatches.length === 0,
  };
}

function render(results) {
  const lines = ['# pr-lifecycle pilot read-out', ''];
  for (const r of results) {
    lines.push(`## ${r.repo}`, '');
    if (!r.started) {
      lines.push('pr-lifecycle.yml is not on the default branch yet.', '');
      continue;
    }
    const window = `${r.workingDays}/${WINDOW_WORKING_DAYS} working days, ${r.merged}/${WINDOW_MERGED_PRS} merged PRs`;
    lines.push(
      `- Since ${r.start}: ${window} — window ${r.windowMet ? 'met' : 'not yet met'}`,
      `- reconcile runs: ${r.runs.total} (${r.runs.success} succeeded, ${r.runs.cancelled} cancelled, ${r.runs.held} awaiting approval, ${r.runs.heldFailed} held then failed without a job), **${r.runs.failed.length} failed**`,
      ...r.runs.failed.map((run) => `  - ${run.event}: ${run.url}`),
      `- Label checks: ${r.prs.filter((pr) => pr.check === 'agrees').length} agree, **${r.mismatches.length} mismatch**, ${r.prs.filter((pr) => pr.check.startsWith('no ') || pr.check.startsWith('skipped')).length} not comparable`,
      ...r.mismatches.map(
        (pr) =>
          `  - #${pr.number} ${pr.title}: expected \`${pr.expected}\`, has ${pr.present.map((l) => `\`${l}\``).join(', ') || 'none'}`,
      ),
      `- Routing cases to review by hand: ${r.routingCases.length}`,
      ...r.routingCases.map(
        (pr) =>
          `  - #${pr.number} ${pr.title} (${pr.routing.join(', ')})${pr.merged ? ', merged' : ''}`,
      ),
      `- **${r.passes ? 'Meets the arming criteria' : 'Not ready to arm'}**${r.passes && r.routingCases.length > 0 ? ' (after the routing cases are checked)' : ''}`,
      '',
    );
  }
  return lines.join('\n');
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const repos = args.filter((arg) => !arg.startsWith('--'));
const now = Date.now();
const results = (repos.length > 0 ? repos : DEFAULT_REPOS).map((repo) => readRepo(repo, now));
process.stdout.write(json ? `${JSON.stringify(results, null, 2)}\n` : `${render(results)}\n`);
