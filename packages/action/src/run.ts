import { execFileSync } from 'node:child_process';
import { appendFileSync, globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkDiagrams, type CheckOptions, type CheckReport, type DiagramInput, type FailOn, type FailScope } from './check.ts';
import { upsertComment, type GitHubContext } from './github.ts';
import { renderReport } from './markdown.ts';

export interface RunDeps {
  env: NodeJS.ProcessEnv;
  /** Contents of `path` at `revision`: null if absent there, undefined if the revision itself is unknown. */
  readAtRevision: (revision: string, file: string) => string | null | undefined;
  log: (line: string) => void;
  fetch?: typeof fetch;
}

/** The whole action, minus process-level side effects, so it can be tested. */
export async function run(deps: RunDeps): Promise<{ report: CheckReport; exitCode: number }> {
  const { env, log } = deps;
  const input = (name: string, fallback = ''): string => (env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim() || fallback;

  const options: CheckOptions = {
    failOn: parseChoice(input('fail-on', 'never'), ['error', 'warning', 'info', 'never'], 'fail-on') as FailOn,
    failScope: parseChoice(input('fail-scope', 'new'), ['new', 'all'], 'fail-scope') as FailScope,
    disabledRuleIds: splitList(input('disabled-rules')),
  };

  const workspace = env['GITHUB_WORKSPACE'] ?? process.cwd();
  const patterns = splitList(input('diagrams', '**/*.keel.json'));
  const files = [
    ...new Set(
      patterns.flatMap((pattern) =>
        globSync(pattern, { cwd: workspace, exclude: (name) => name === 'node_modules' || name === '.git' }),
      ),
    ),
  ].sort();

  const event = readEvent(env['GITHUB_EVENT_PATH']);
  const baseSha = event?.pull_request?.base?.sha;

  const inputs: DiagramInput[] = files.map((file) => ({
    path: file.split(path.sep).join('/'),
    head: readFileSync(path.join(workspace, file), 'utf8'),
    ...(baseSha ? { base: deps.readAtRevision(baseSha, file) } : {}),
  }));

  const report = checkDiagrams(inputs, options);
  const markdown = renderReport(report, options);

  for (const diagram of report.diagrams) {
    for (const error of diagram.errors ?? []) log(annotation('error', diagram.path, undefined, 'Keel: unreadable diagram', error));
    const pool = diagram.compared ? diagram.introduced : diagram.findings;
    for (const finding of pool) {
      log(annotation(finding.severity === 'info' ? 'notice' : finding.severity, diagram.path, finding.line, `Keel: ${finding.title}`, finding.detail));
    }
  }

  if (env['GITHUB_STEP_SUMMARY']) appendFileSync(env['GITHUB_STEP_SUMMARY'], `${markdown}\n`);
  if (env['GITHUB_OUTPUT']) {
    const count = (predicate: (d: CheckReport['diagrams'][number]) => number) =>
      report.diagrams.reduce((n, d) => n + predicate(d), 0);
    appendFileSync(
      env['GITHUB_OUTPUT'],
      [
        `findings=${count((d) => d.findings.length)}`,
        `introduced=${count((d) => d.introduced.length)}`,
        `resolved=${count((d) => d.resolved.length)}`,
        `blocking=${report.blocking.length}`,
        '',
      ].join('\n'),
    );
  }

  const prNumber = event?.pull_request?.number;
  const wantsComment = input('comment', 'true') !== 'false';
  const token = input('github-token');
  const repository = env['GITHUB_REPOSITORY'];
  if (wantsComment && prNumber && token && repository && files.length > 0) {
    const [owner = '', repo = ''] = repository.split('/');
    const context: GitHubContext = {
      apiUrl: env['GITHUB_API_URL'] ?? 'https://api.github.com',
      token,
      owner,
      repo,
      issueNumber: prNumber,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    };
    try {
      log(`Keel report comment ${await upsertComment(context, markdown)}.`);
    } catch (error) {
      // A fork's PR gets a read-only token. The summary and annotations still
      // carry the report, so a missing comment must not fail the check.
      log(`::warning::Could not post the report comment (${error instanceof Error ? error.message : String(error)}). Grant "pull-requests: write" to enable it.`);
    }
  }

  if (files.length === 0) log(`::warning::No diagram files matched ${patterns.join(', ')}.`);
  return { report, exitCode: report.failed ? 1 : 0 };
}

/** `git show`, fetching the base commit first if a shallow clone lacks it. */
export function gitReadAtRevision(cwd: string): RunDeps['readAtRevision'] {
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const known = new Map<string, boolean>();

  return (revision, file) => {
    if (!known.has(revision)) {
      let present = tryGit(() => git(['cat-file', '-e', `${revision}^{commit}`])) !== undefined;
      if (!present) present = tryGit(() => git(['fetch', '--no-tags', '--depth=1', 'origin', revision])) !== undefined;
      known.set(revision, present);
    }
    if (!known.get(revision)) return undefined;
    return tryGit(() => git(['show', `${revision}:${file.split(path.sep).join('/')}`])) ?? null;
  };
}

function tryGit(fn: () => string): string | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

interface PullRequestEvent {
  pull_request?: { number?: number; base?: { sha?: string } };
}

function readEvent(eventPath: string | undefined): PullRequestEvent | null {
  if (!eventPath) return null;
  try {
    return JSON.parse(readFileSync(eventPath, 'utf8')) as PullRequestEvent;
  } catch {
    return null;
  }
}

function parseChoice(value: string, choices: readonly string[], name: string): string {
  if (!choices.includes(value)) throw new Error(`Input "${name}" must be one of ${choices.join(', ')}; got "${value}".`);
  return value;
}

function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** A workflow command. Properties and message are escaped as the runner expects. */
function annotation(level: string, file: string, line: number | undefined, title: string, message: string): string {
  const prop = (v: string) => v.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
  const data = (v: string) => v.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const props = [`file=${prop(file)}`, ...(line ? [`line=${line}`] : []), `title=${prop(title)}`].join(',');
  return `::${level} ${props}::${data(message)}`;
}
