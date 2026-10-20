import type { ForcePushFact } from '../facts.js';
import type { CheckSuiteData, GitHubClient, LabelApplicationData } from './client.js';
import { isApiStatus } from './client.js';
import type { HttpTransport } from './http-transport.js';
import { PAGE_SIZE } from './http-transport.js';
import type { RestIssueEvent } from './rest-payloads.js';
import { toActorType } from './rest-payloads.js';

/**
 * The real GitHubClient's reads of a PR's history, for binding UAT sign-offs to
 * a head (docs/uat.md): who applied a label and when, title changes, the
 * force-pushes with the heads they replaced, when a commit's check suites were
 * created, and a file's text at a commit.
 */

export type HistoryMethods = Pick<
  GitHubClient,
  | 'getFileText'
  | 'listCheckSuites'
  | 'listForcePushes'
  | 'listLabelApplications'
  | 'listTitleChanges'
>;

// REST's `head_ref_force_pushed` event names only the new head; the timeline's
// GraphQL type also names the head it replaced.
const FORCE_PUSHES = `query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on HeadRefForcePushedEvent { createdAt beforeCommit { oid } afterCommit { oid } } }
      }
    }
  }
}`;

interface ForcePushPage {
  repository: {
    pullRequest: {
      timelineItems: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          createdAt: string;
          beforeCommit: { oid: string } | null;
          afterCommit: { oid: string } | null;
        }[];
      };
    } | null;
  } | null;
}

interface RestCheckSuite {
  head_branch: string | null;
  created_at: string;
}

interface RestContent {
  encoding?: string;
  content?: string;
}

/** Each path segment encoded, the separators kept. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function createHistoryMethods(transport: HttpTransport): HistoryMethods {
  const { repoPath, request, paginate, graphqlData, owner, repo } = transport;
  return {
    async listLabelApplications(pr, label): Promise<LabelApplicationData[]> {
      const events = await paginate<RestIssueEvent>(`${repoPath}/issues/${pr}/events`);
      return events
        .filter((event) => event.event === 'labeled' && event.label?.name === label)
        .map((event) => {
          const actor = event.actor ?? undefined;
          return {
            login: actor?.login,
            // A deleted account can never be trusted, so it reads as a bot.
            type: actor === undefined ? 'Bot' : toActorType(actor.type),
            appliedAt: event.created_at,
          };
        });
    },
    async listTitleChanges(pr) {
      const events = await paginate<RestIssueEvent>(`${repoPath}/issues/${pr}/events`);
      return events.filter((event) => event.event === 'renamed').map((event) => event.created_at);
    },
    async listForcePushes(pr): Promise<ForcePushFact[]> {
      const pushes: ForcePushFact[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = (await graphqlData(FORCE_PUSHES, {
          owner,
          repo,
          pr,
          cursor,
        })) as ForcePushPage;
        const items = page.repository?.pullRequest?.timelineItems;
        if (items === undefined) {
          throw new Error(`pull request #${pr} not found reading its force-pushes`);
        }
        for (const node of items.nodes) {
          pushes.push({
            headSha: node.afterCommit?.oid,
            beforeSha: node.beforeCommit?.oid,
            pushedAt: node.createdAt,
          });
        }
        if (!items.pageInfo.hasNextPage || items.pageInfo.endCursor === null) {
          return pushes;
        }
        cursor = items.pageInfo.endCursor;
      }
    },
    async listCheckSuites(sha): Promise<CheckSuiteData[]> {
      const suites: RestCheckSuite[] = [];
      for (let page = 1; ; page += 1) {
        const batch = (await request(
          'GET',
          `${repoPath}/commits/${sha}/check-suites?per_page=${PAGE_SIZE}&page=${page}`,
        )) as { check_suites: RestCheckSuite[] };
        suites.push(...batch.check_suites);
        if (batch.check_suites.length < PAGE_SIZE) {
          break;
        }
      }
      return suites.map((suite) => ({
        headBranch: suite.head_branch ?? undefined,
        createdAt: suite.created_at,
      }));
    },
    async getFileText(path, ref) {
      let content: RestContent;
      try {
        content = (await request(
          'GET',
          `${repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
        )) as RestContent;
      } catch (error) {
        if (isApiStatus(error, 404)) {
          return undefined;
        }
        throw error;
      }
      // A file over 1 MB comes back without its content: read as unknown.
      if (content.encoding !== 'base64' || content.content === undefined) {
        return undefined;
      }
      return Buffer.from(content.content, 'base64').toString('utf8');
    },
  };
}
