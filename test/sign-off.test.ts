import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { FileChange, PullRequestFacts, UatSetting } from '../src/facts.js';
import type { SignOffClassification } from '../src/sign-off.js';
import {
  classifySignOff,
  requirementFor,
  SIGN_OFF_REASONS,
  signOffStatusDescription,
} from '../src/sign-off.js';
import { planSignOff } from '../src/sign-off-plan.js';
import { waiverState } from '../src/uat.js';
import { BASE_WORKFLOW, edited } from './ci-change/fixtures/workflow.js';
import { makeAuthor, OLD_SHA } from './fixtures.js';
import {
  BEFORE_HEAD,
  makeApproval,
  makeSignOff,
  makeUatFacts,
  makeUatReview,
  withSignOffs,
} from './uat-fixtures.js';

const WORKFLOW = '.github/workflows/ci.yml';

/** A workflow edit that only adds a matrix entry: more coverage. */
const TIGHTENING: FileChange = {
  path: WORKFLOW,
  baseText: BASE_WORKFLOW,
  headText: edited('        node: [20, 22]', '        node: [20, 22, 24]'),
};

/** A workflow edit that lets a job fail without failing the run. */
const LOOSENING: FileChange = {
  path: WORKFLOW,
  baseText: BASE_WORKFLOW,
  headText: edited(
    '    runs-on: ubuntu-latest',
    '    runs-on: ubuntu-latest\n    continue-on-error: true',
  ),
};

/** A Dependabot-style action bump: only a `uses:` ref moved. */
const PIN_BUMP: FileChange = {
  path: WORKFLOW,
  baseText: BASE_WORKFLOW,
  headText: edited('actions/checkout@v4', 'actions/checkout@v5'),
};

const REUSABLE: FileChange = {
  path: '.github/workflows/deploy.yml',
  baseText: 'on:\n  workflow_call:\njobs:\n  d:\n    runs-on: ubuntu-latest\n',
  headText: 'on:\n  workflow_call:\njobs:\n  d:\n    runs-on: ubuntu-22.04\n',
};

function classify(
  title: string,
  changedPaths: string[] | undefined,
  workflowChanges: FileChange[] = [],
  setting: UatSetting = 'on',
): SignOffClassification {
  const facts: PullRequestFacts = makeUatFacts({ title, workflowChanges });
  if (changedPaths === undefined) {
    delete facts.changedPaths;
  } else {
    facts.changedPaths = changedPaths;
  }
  return classifySignOff(facts, setting);
}

describe('classifySignOff — ci PRs', () => {
  it('needs nothing for a ci PR whose workflow change only tightens', () => {
    expect(classify('ci: test on node 24', [WORKFLOW], [TIGHTENING])).toEqual({
      requirement: 'none',
      reason: 'ci-safe',
      loosening: false,
    });
  });

  it('needs nothing for a ci PR adding trivial paths beside a tightening', () => {
    const facts = classify('ci: tidy', [WORKFLOW, 'README.md'], [TIGHTENING]);

    expect(facts.requirement).toBe('none');
  });

  it('needs the CI sign-off for a ci PR touching scripts', () => {
    expect(classify('ci: add a lint script', ['scripts/lint.sh'])).toEqual({
      requirement: 'ci',
      reason: 'ci-paths',
      loosening: false,
    });
  });

  it('needs the CI sign-off for a ci PR changing a composite action', () => {
    expect(classify('ci: a', ['.github/actions/setup/action.yml']).reason).toBe('ci-paths');
  });

  it('needs the CI sign-off for a ci PR that loosens a workflow', () => {
    expect(classify('ci: let the build fail', [WORKFLOW], [LOOSENING])).toEqual({
      requirement: 'ci',
      reason: 'ci-loosening',
      loosening: true,
    });
  });

  it('needs the CI sign-off for a ci PR whatever the UAT setting', () => {
    expect(classify('ci: add a script', ['scripts/a.sh'], [], 'off').requirement).toBe('ci');
  });

  it('needs the CI sign-off for a ci PR whose file list is incomplete', () => {
    expect(classify('ci: a', undefined)).toEqual({
      requirement: 'ci',
      reason: 'ci-loosening',
      loosening: true,
    });
  });
});

describe('classifySignOff — other PRs', () => {
  it('needs UAT for a feat with a bundled loosening, and reports the loosening', () => {
    expect(classify('feat: a', ['src/a.ts', WORKFLOW], [LOOSENING])).toEqual({
      requirement: 'uat',
      reason: 'needs-uat',
      loosening: true,
    });
  });

  it('needs UAT for a chore touching source', () => {
    expect(classify('chore: tidy', ['src/a.ts']).requirement).toBe('uat');
  });

  it.each(['docs: a', 'test: a', 'refactor: a'])('needs UAT for %j: no title exempts', (title) => {
    expect(classify(title, ['src/a.ts'])).toEqual({
      requirement: 'uat',
      reason: 'needs-uat',
      loosening: false,
    });
  });

  it('needs UAT when every path is trivial: no path exempts', () => {
    expect(classify('chore(deps): bump', ['pnpm-lock.yaml']).reason).toBe('needs-uat');
  });

  it('needs UAT for a docs-only PR', () => {
    expect(classify('docs: a', ['README.md']).requirement).toBe('uat');
  });

  it('needs nothing with UAT off', () => {
    expect(classify('feat: a', ['src/a.ts'], [], 'off')).toEqual({
      requirement: 'none',
      reason: 'uat-off',
      loosening: false,
    });
  });

  it('treats a docs PR that bundles a loosening as a CI change', () => {
    expect(classify('docs: a', ['README.md', WORKFLOW], [LOOSENING])).toEqual({
      requirement: 'ci',
      reason: 'ci-loosening',
      loosening: true,
    });
  });

  it('counts a changed workflow it could not read as a loosening', () => {
    expect(classify('feat: a', ['src/a.ts', WORKFLOW], []).loosening).toBe(true);
  });

  it('counts a deleted workflow as a loosening', () => {
    const removed = { path: WORKFLOW, baseText: BASE_WORKFLOW, headText: undefined };

    expect(classify('feat: a', ['src/a.ts', WORKFLOW], [removed]).loosening).toBe(true);
  });

  it('needs UAT when the file list is incomplete, and counts a loosening', () => {
    expect(classify('feat: a', undefined)).toEqual({
      requirement: 'uat',
      reason: 'needs-uat',
      loosening: true,
    });
  });
});

describe('classifySignOff — CI changes under other titles', () => {
  it('needs nothing for a chore(deps) action pin bump', () => {
    expect(classify('chore(deps): bump actions', [WORKFLOW], [PIN_BUMP])).toEqual({
      requirement: 'none',
      reason: 'ci-safe',
      loosening: false,
    });
  });

  it('needs nothing for a pin bump beside a lockfile', () => {
    expect(classify('chore: a', [WORKFLOW, 'pnpm-lock.yaml'], [PIN_BUMP]).requirement).toBe('none');
  });

  it('needs the CI sign-off, not UAT, for a chore that loosens a workflow', () => {
    expect(classify('chore: a', [WORKFLOW], [LOOSENING])).toEqual({
      requirement: 'ci',
      reason: 'ci-loosening',
      loosening: true,
    });
  });

  it('needs the CI sign-off for a chore workflow change it could not read', () => {
    expect(classify('chore: a', [WORKFLOW], []).reason).toBe('ci-loosening');
  });

  it('needs the CI sign-off for a chore changing a composite action', () => {
    expect(classify('chore: a', ['.github/actions/setup/action.yml'])).toEqual({
      requirement: 'ci',
      reason: 'ci-paths',
      loosening: false,
    });
  });

  it('needs the CI sign-off for a CI change whatever the UAT setting', () => {
    expect(classify('chore: a', [WORKFLOW], [LOOSENING], 'off').requirement).toBe('ci');
  });

  it('needs UAT for a change to a shipped reusable workflow', () => {
    expect(classify('fix: a', [REUSABLE.path], [REUSABLE]).requirement).toBe('uat');
  });

  it('needs UAT for a CI change bundled with source', () => {
    expect(classify('chore: a', [WORKFLOW, 'src/a.ts'], [PIN_BUMP]).requirement).toBe('uat');
  });
});

describe('requirementFor', () => {
  it.each([
    ['ci-safe', 'none'],
    ['uat-off', 'none'],
    ['ci-loosening', 'ci'],
    ['ci-paths', 'ci'],
    ['needs-uat', 'uat'],
  ] as const)('maps %s to %s', (reason, requirement) => {
    expect(requirementFor(reason)).toBe(requirement);
  });
});

describe('waiverState', () => {
  it('is absent without a waiver', () => {
    expect(waiverState(makeUatFacts(), {})).toBe('absent');
  });

  it('is current for a trusted waiver on the head', () => {
    expect(waiverState(withSignOffs(makeUatFacts(), makeSignOff()), {})).toBe('current');
  });

  it('is stale for a trusted waiver from an earlier head', () => {
    const facts = withSignOffs(makeUatFacts(), makeSignOff({ appliedAt: BEFORE_HEAD }));

    expect(waiverState(facts, {})).toBe('stale');
  });

  it('is absent for a waiver from a bot', () => {
    const actor = makeAuthor({ login: 'github-actions[bot]', type: 'Bot', permission: 'none' });

    expect(waiverState(withSignOffs(makeUatFacts(), makeSignOff({ actor })), {})).toBe('absent');
  });

  it('is absent once the label was removed', () => {
    expect(waiverState({ ...makeUatFacts(), uatSignOffs: [makeSignOff()] }, {})).toBe('absent');
  });
});

describe('signOffStatusDescription', () => {
  const FIELDS = { waiver: 'current', signoff: 'waived' } as const;

  it.each([
    ['v1', { requirement: 'uat', loosening: false }, 'v1 requirement=uat waiver=current'],
    [
      'v1',
      { requirement: 'uat', loosening: true },
      'v1 requirement=uat waiver=current loosening=yes',
    ],
    ['v1', { requirement: 'ci', loosening: true }, 'v1 requirement=ci loosening=yes'],
    ['v1', { requirement: 'none', loosening: false }, 'v1 requirement=none'],
    ['v2', { requirement: 'uat', loosening: false }, 'v2 requirement=uat signoff=waived'],
    [
      'v2',
      { requirement: 'uat', loosening: true },
      'v2 requirement=uat signoff=waived loosening=yes',
    ],
    ['v2', { requirement: 'ci', loosening: false }, 'v2 requirement=ci'],
    ['v2', { requirement: 'none', loosening: false }, 'v2 requirement=none'],
  ] as const)('writes %s %j as %j', (version, shape, description) => {
    expect(signOffStatusDescription(version, { ...shape, ...FIELDS })).toBe(description);
  });

  it.each([
    ['v1', /^v1 requirement=(none|ci|uat)( waiver=(current|stale|absent))?( loosening=yes)?$/],
    ['v2', /^v2 requirement=(none|ci|uat)( signoff=(waived|passed|absent))?( loosening=yes)?$/],
  ] as const)(
    'always matches the %s grammar, with the sign-off exactly on uat and within 140 characters',
    (version, grammar) => {
      fc.assert(
        fc.property(
          fc.constantFrom(...SIGN_OFF_REASONS),
          fc.boolean(),
          fc.constantFrom('current', 'stale', 'absent'),
          fc.constantFrom('waived', 'passed', 'absent'),
          (reason, loosening, waiver, signoff) => {
            const requirement = requirementFor(reason);
            const description = signOffStatusDescription(version, {
              requirement,
              loosening,
              waiver,
              signoff,
            });
            const match = grammar.exec(description);
            expect([
              match !== null,
              (match?.[2] !== undefined) === (requirement === 'uat'),
              description.length <= 140,
            ]).toEqual([true, true, true]);
          },
        ),
      );
    },
  );
});

describe('planSignOff — the status for each UAT outcome', () => {
  function describeFor(facts: PullRequestFacts, signOffStatus: 'v1' | 'v2'): string | undefined {
    return planSignOff(facts, { uat: 'on', signOffStatus })?.status.description;
  }

  it('reports no sign-off for a PR approved through bot eligibility', () => {
    expect(describeFor(makeUatFacts({ botEligible: true }), 'v2')).toBe('v2 requirement=none');
  });

  it('defaults to v1', () => {
    expect(planSignOff(makeUatFacts(), { uat: 'on' })?.status.description).toBe(
      'v1 requirement=uat waiver=absent',
    );
  });

  it("reports the review agent's waiver as waived in v2", () => {
    const facts = makeUatFacts({ reviews: [makeUatReview('not-needed')] });

    expect(describeFor(facts, 'v2')).toBe('v2 requirement=uat signoff=waived');
  });

  it("leaves the review agent's waiver to a person's label in v1", () => {
    const facts = makeUatFacts({ reviews: [makeUatReview('not-needed')] });

    expect(describeFor(facts, 'v1')).toBe('v1 requirement=uat waiver=absent');
  });

  it("reports a person's waiver as waived in v2", () => {
    expect(describeFor(withSignOffs(makeUatFacts(), makeSignOff()), 'v2')).toBe(
      'v2 requirement=uat signoff=waived',
    );
  });

  it('reports a carried UAT passed as passed in v2', () => {
    const facts = withSignOffs(
      makeUatFacts({ reviews: [makeApproval(OLD_SHA)], cleanAncestors: [OLD_SHA] }),
      makeSignOff({ label: 'UAT passed', appliedAt: BEFORE_HEAD }),
    );
    facts.commitArrivals = { ...facts.commitArrivals, [OLD_SHA]: '2026-10-19T08:00:00Z' };

    expect(describeFor(facts, 'v2')).toBe('v2 requirement=uat signoff=passed');
  });

  it('reports an approved PR waiting for UAT as absent in v2', () => {
    expect(describeFor(makeUatFacts({ reviews: [makeApproval()] }), 'v2')).toBe(
      'v2 requirement=uat signoff=absent',
    );
  });
});
