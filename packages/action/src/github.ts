import { COMMENT_MARKER } from './markdown.ts';

/**
 * The two GitHub calls the action makes, over plain fetch.
 *
 * No Octokit: the action is bundled into one committed file, and two REST
 * calls do not justify a dependency tree in it.
 */
export interface GitHubContext {
  apiUrl: string;
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  fetch?: typeof fetch;
}

interface Comment {
  id: number;
  body?: string;
}

/**
 * Create the report comment, or update it in place on later pushes, so a PR
 * carries one current report rather than one per commit.
 */
export async function upsertComment(context: GitHubContext, body: string): Promise<'created' | 'updated'> {
  const call = context.fetch ?? fetch;
  const base = `${context.apiUrl}/repos/${context.owner}/${context.repo}/issues/${context.issueNumber}/comments`;
  const headers = {
    authorization: `Bearer ${context.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  };

  const existing = await findOwnComment(call, base, headers);
  const response = existing
    ? await call(`${context.apiUrl}/repos/${context.owner}/${context.repo}/issues/comments/${existing.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ body }),
      })
    : await call(base, { method: 'POST', headers, body: JSON.stringify({ body }) });

  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return existing ? 'updated' : 'created';
}

async function findOwnComment(
  call: typeof fetch,
  base: string,
  headers: Record<string, string>,
): Promise<Comment | null> {
  // Paged, because a busy PR buries the report under other comments.
  for (let page = 1; page <= 10; page += 1) {
    const response = await call(`${base}?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    const comments = (await response.json()) as Comment[];
    const mine = comments.find((c) => c.body?.startsWith(COMMENT_MARKER));
    if (mine) return mine;
    if (comments.length < 100) return null;
  }
  return null;
}
