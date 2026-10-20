import { classifyWorkflowFile } from '../../../src/ci-change/classify.js';
import type { Indicator } from '../../../src/ci-change/indicators.js';

/**
 * A realistic consumer workflow, used as the *base* side of every rule test so
 * each case exercises a genuine before/after pair rather than a synthetic stub.
 */
export const BASE_WORKFLOW = `name: CI
on:
  pull_request:
    branches: [main, 'release/**']
  push:
    branches: [main]
permissions:
  contents: read
env:
  CI: 'true'
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
    strategy:
      matrix:
        node: [20, 22]
        os: [ubuntu-latest]
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: pnpm install --frozen-lockfile
      - name: Test
        run: pnpm test
  deploy:
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        run: ./deploy.sh
`;

export const WORKFLOW_PATH = '.github/workflows/ci.yml';

/** Classify an edit of {@link BASE_WORKFLOW} and return the indicator kinds it produced. */
export function kindsFor(headText: string): string[] {
  return classifyWorkflowFile({
    path: WORKFLOW_PATH,
    baseText: BASE_WORKFLOW,
    headText,
  }).map((indicator: Indicator) => indicator.kind);
}

/** Apply a literal search/replace to {@link BASE_WORKFLOW}, asserting the needle exists. */
export function edited(find: string, replace: string): string {
  if (!BASE_WORKFLOW.includes(find)) {
    throw new Error(`fixture does not contain: ${find}`);
  }
  return BASE_WORKFLOW.replace(find, replace);
}
