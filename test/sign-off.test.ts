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
import { waiverState } from '../src/uat.js';
import { BASE_WORKFLOW, edited } from './ci-change/fixtures/workflow.js';
import { makeAuthor } from './fixtures.js';
import { BEFORE_HEAD, makeSignOff, makeUatFacts, withSignOffs } from './uat-fixtures.js';

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
      reason: 'trivial-paths',
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

  it.each(['docs: a', 'test: a', 'refactor: a'])('needs nothing for %j', (title) => {
    expect(classify(title, ['src/a.ts'])).toEqual({
      requirement: 'none',
      reason: 'safe-title',
      loosening: false,
    });
  });

  it('needs nothing when every path is trivial', () => {
    expect(classify('chore(deps): bump', ['pnpm-lock.yaml']).reason).toBe('trivial-paths');
  });

  it('needs nothing with UAT off', () => {
    expect(classify('feat: a', ['src/a.ts'], [], 'off')).toEqual({
      requirement: 'none',
      reason: 'uat-off',
      loosening: false,
    });
  });

  it('reports a loosening on a docs PR that bundles one', () => {
    expect(classify('docs: a', ['README.md', WORKFLOW], [LOOSENING])).toEqual({
      requirement: 'none',
      reason: 'safe-title',
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

describe('requirementFor', () => {
  it.each([
    ['safe-title', 'none'],
    ['trivial-paths', 'none'],
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
  it.each([
    [{ requirement: 'uat', loosening: false }, 'current', 'v1 requirement=uat waiver=current'],
    [
      { requirement: 'uat', loosening: true },
      'stale',
      'v1 requirement=uat waiver=stale loosening=yes',
    ],
    [{ requirement: 'ci', loosening: true }, 'absent', 'v1 requirement=ci loosening=yes'],
    [{ requirement: 'ci', loosening: false }, 'current', 'v1 requirement=ci'],
    [{ requirement: 'none', loosening: false }, 'current', 'v1 requirement=none'],
  ] as const)('describes %j with waiver %s as %j', (shape, waiver, description) => {
    const classification = { ...shape, reason: 'needs-uat' as const };

    expect(signOffStatusDescription(classification, waiver)).toBe(description);
  });

  it('always matches the v1 grammar, with waiver exactly on uat and within 140 characters', () => {
    const grammar =
      /^v1 requirement=(none|ci|uat)( waiver=(current|stale|absent))?( loosening=yes)?$/;
    fc.assert(
      fc.property(
        fc.constantFrom(...SIGN_OFF_REASONS),
        fc.boolean(),
        fc.constantFrom('current', 'stale', 'absent'),
        (reason, loosening, waiver) => {
          const classification = { requirement: requirementFor(reason), reason, loosening };
          const description = signOffStatusDescription(classification, waiver);
          const match = grammar.exec(description);
          expect([
            match !== null,
            (match?.[2] !== undefined) === (classification.requirement === 'uat'),
            description.length <= 140,
          ]).toEqual([true, true, true]);
        },
      ),
    );
  });
});
