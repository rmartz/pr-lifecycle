import type { RepoPermission } from '../facts.js';
import { REPO_PERMISSIONS } from '../facts.js';
import type { GitHubClient } from './client.js';
import { isApiStatus } from './client.js';

/**
 * Looks up a user's permission on the repository, for the trust checks on
 * verdict authors and UAT override appliers.
 */

function isRepoPermission(value: string): value is RepoPermission {
  return REPO_PERMISSIONS.some((permission) => permission === value);
}

/**
 * The author's permission, preferring the fine-grained role (which distinguishes
 * maintain and triage) and falling back to the legacy level for custom roles.
 * A non-collaborator (404) has no permission.
 */
export async function lookupPermission(client: GitHubClient, login: string): Promise<RepoPermission> {
  try {
    const { permission, roleName } = await client.getCollaboratorPermission(login);
    if (isRepoPermission(roleName)) {
      return roleName;
    }
    return isRepoPermission(permission) ? permission : 'none';
  } catch (error) {
    if (isApiStatus(error, 404)) {
      return 'none';
    }
    throw error;
  }
}
