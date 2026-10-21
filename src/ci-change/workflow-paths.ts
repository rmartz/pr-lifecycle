/**
 * Which files this guard considers "a CI workflow".
 *
 * Scoped to `.github/workflows/**` as the CI directive is: those are the files
 * whose content decides what CI runs. A composite action under
 * `.github/actions/` can change behaviour too, but it is invoked *by* a workflow
 * step, so a change there that matters shows up as a step change here — and
 * widening the scope would make every consuming repo's Action edits carry a
 * human sign-off gate.
 */

const WORKFLOW_FILE = /^\.github\/workflows\/.+\.ya?ml$/;

export function isWorkflowPath(path: string): boolean {
  return WORKFLOW_FILE.test(path);
}
