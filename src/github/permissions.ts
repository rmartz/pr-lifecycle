import type { ActorType, RepoPermission, ReviewAuthor } from '../facts.js';
import { REPO_PERMISSIONS } from '../facts.js';
import type { GitHubClient } from './client.js';
import { isApiStatus } from './client.js';

/**
 * Repository permissions for the actors whose acts count only when trusted:
 * review authors, label removers, and sign-off label appliers. The trust
 * judgment itself is pure, in the core (`isTrustedAuthor`).
 */

function isRepoPermission(value: string): value is RepoPermission {
  return REPO_PERMISSIONS.some((permission) => permission === value);
}

/**
 * The author's permission, preferring the fine-grained role (which distinguishes
 * maintain and triage) and falling back to the legacy level for custom roles.
 * A non-collaborator (404) has no permission.
 */
async function lookupPermission(client: GitHubClient, login: string): Promise<RepoPermission> {
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

/** Someone whose act counts only if trusted. */
export interface ActorData {
  /** Undefined when the account was deleted (a "ghost"). */
  login: string | undefined;
  type: ActorType;
}

/**
 * Permissions for every actor who could possibly be trusted. Bots and deleted
 * ("ghost") accounts can never be trusted, so they skip the lookup.
 */
export async function lookupPermissions(
  client: GitHubClient,
  actors: readonly ActorData[],
): Promise<Map<string, RepoPermission>> {
  const logins = new Set<string>();
  for (const actor of actors) {
    if (actor.login !== undefined && actor.type === 'User') {
      logins.add(actor.login);
    }
  }
  const entries = await Promise.all(
    [...logins].map(async (login) => [login, await lookupPermission(client, login)] as const),
  );
  return new Map(entries);
}

export function toAuthor(actor: ActorData, permissions: Map<string, RepoPermission>): ReviewAuthor {
  // Only looked-up Users have an entry; bots and ghosts get no permission.
  const permission = actor.login === undefined ? undefined : permissions.get(actor.login);
  return { login: actor.login ?? 'ghost', type: actor.type, permission: permission ?? 'none' };
}
