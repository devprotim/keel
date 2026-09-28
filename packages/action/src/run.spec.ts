import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serializeDiagram, type ArchNode } from '@keel/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMENT_MARKER } from './markdown.ts';
import { gitReadAtRevision, run } from './run.ts';

const node = (id: string, replicas: number): ArchNode => ({ id, kind: 'service', label: id, x: 0, y: 0, w: 1, h: 1, replicas });
const diagram = (timeoutMs: number | undefined) =>
  serializeDiagram({
    nodes: [node('api', 2), node('orders', 2)],
    edges: [{ id: 'e1', source: 'api', target: 'orders', kind: 'sync', ...(timeoutMs ? { timeoutMs } : {}) }],
  });

/**
 * A real repository with a base commit and a changed working tree, as
 * actions/checkout leaves it for a pull request.
 */
let repo: string;
let baseSha: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'keel-action-'));
  git('init', '-q');
  git('config', 'user.email', 'ci@example.com');
  git('config', 'user.name', 'CI');
  mkdirSync(path.join(repo, 'docs'));
  writeFileSync(path.join(repo, 'docs/arch.keel.json'), diagram(500));
  git('add', '.');
  git('commit', '-qm', 'base');
  baseSha = git('rev-parse', 'HEAD');
  writeFileSync(path.join(repo, 'docs/arch.keel.json'), diagram(undefined));
  writeFileSync(path.join(repo, 'event.json'), JSON.stringify({ pull_request: { number: 7, base: { sha: baseSha } } }));
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function env(inputs: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_WORKSPACE: repo,
    GITHUB_EVENT_PATH: path.join(repo, 'event.json'),
    GITHUB_REPOSITORY: 'acme/shop',
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_STEP_SUMMARY: path.join(repo, 'summary.md'),
    GITHUB_OUTPUT: path.join(repo, 'output.txt'),
    'INPUT_GITHUB-TOKEN': 'token-123',
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
  };
}

/** Records GitHub calls; `existing` is what the comment listing returns. */
function fakeGitHub(existing: { id: number; body: string }[] = []) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetch = ((url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    const payload = (init?.method ?? 'GET') === 'GET' ? existing : { id: 1 };
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

describe('run', () => {
  it('compares against the base commit, comments, annotates, and fails on a new problem', async () => {
    const github = fakeGitHub();
    const lines: string[] = [];
    const { exitCode, report } = await run({
      env: env({ 'fail-on': 'warning' }),
      readAtRevision: gitReadAtRevision(repo),
      log: (line) => lines.push(line),
      fetch: github.fetch,
    });

    expect(exitCode).toBe(1);
    expect(report.diagrams[0]?.path).toBe('docs/arch.keel.json');
    expect(report.diagrams[0]?.introduced.map((f) => f.ruleId)).toContain('sync-missing-timeout');

    const post = github.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('https://api.github.test/repos/acme/shop/issues/7/comments');
    expect((JSON.parse(post?.body ?? '{}') as { body: string }).body).toContain(COMMENT_MARKER);

    expect(lines.some((l) => /^::(error|warning) file=docs\/arch\.keel\.json,line=\d+,title=Keel%3A /.test(l))).toBe(true);
    expect(readFileSync(path.join(repo, 'summary.md'), 'utf8')).toContain('Keel architecture check');
    expect(readFileSync(path.join(repo, 'output.txt'), 'utf8')).toMatch(/introduced=[1-9]/);
  });

  it('updates its own earlier comment instead of adding another', async () => {
    const github = fakeGitHub([
      { id: 11, body: 'unrelated' },
      { id: 42, body: `${COMMENT_MARKER}\nold report` },
    ]);
    await run({ env: env(), readAtRevision: gitReadAtRevision(repo), log: () => undefined, fetch: github.fetch });

    const patch = github.calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe('https://api.github.test/repos/acme/shop/issues/comments/42');
    expect(github.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('reports without failing by default', async () => {
    const { exitCode } = await run({
      env: env(),
      readAtRevision: gitReadAtRevision(repo),
      log: () => undefined,
      fetch: fakeGitHub().fetch,
    });
    expect(exitCode).toBe(0);
  });

  it('does not fail the check when the comment cannot be posted, as on a fork', async () => {
    const lines: string[] = [];
    const forbidden = (() =>
      Promise.resolve(new Response('Resource not accessible by integration', { status: 403 }))) as typeof fetch;
    const { exitCode } = await run({
      env: env(),
      readAtRevision: gitReadAtRevision(repo),
      log: (line) => lines.push(line),
      fetch: forbidden,
    });
    expect(exitCode).toBe(0);
    expect(lines.some((l) => l.startsWith('::warning::Could not post'))).toBe(true);
  });

  it('treats a diagram added by this change as entirely new', async () => {
    writeFileSync(path.join(repo, 'docs/new.keel.json'), diagram(undefined));
    const { report } = await run({
      env: env({ comment: 'false' }),
      readAtRevision: gitReadAtRevision(repo),
      log: () => undefined,
    });
    const added = report.diagrams.find((d) => d.path === 'docs/new.keel.json');
    expect(added?.compared).toBe(true);
    expect(added?.introduced.length).toBe(added?.findings.length);
  });

  it('rejects an unknown fail-on value rather than guessing', async () => {
    await expect(
      run({ env: env({ 'fail-on': 'sometimes' }), readAtRevision: gitReadAtRevision(repo), log: () => undefined }),
    ).rejects.toThrow(/fail-on/);
  });
});
