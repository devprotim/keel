import type { Finding, Severity } from '@keel/shared';
import type { CheckOptions, CheckReport, DiagramReport } from './check.ts';

/** Hidden marker, so the action edits its own comment instead of adding another. */
export const COMMENT_MARKER = '<!-- keel-architecture-check -->';

const ICON: Record<Severity, string> = { error: '🔴', warning: '🟠', info: '🔵' };

/** GitHub rejects comment bodies over 65,536 characters. */
const MAX_BODY = 60_000;

export function renderReport(report: CheckReport, options: CheckOptions): string {
  const lines: string[] = [COMMENT_MARKER, '## Keel architecture check', ''];

  lines.push(headline(report, options), '');

  for (const diagram of report.diagrams) lines.push(...renderDiagram(diagram), '');

  lines.push(
    `<sub>${policy(options)} · Findings come from Keel's deterministic rules, the same ones the canvas runs.</sub>`,
  );

  const body = lines.join('\n');
  return body.length <= MAX_BODY ? body : `${body.slice(0, MAX_BODY)}\n\n…report truncated. See the job summary.`;
}

function headline(report: CheckReport, options: CheckOptions): string {
  if (report.diagrams.length === 0) return 'No diagram files matched.';
  const unreadable = report.diagrams.filter((d) => d.errors).length;
  if (unreadable > 0) return `**${unreadable} diagram file${unreadable === 1 ? '' : 's'} could not be read.**`;

  const introduced = report.diagrams.reduce((n, d) => n + d.introduced.length, 0);
  const resolved = report.diagrams.reduce((n, d) => n + d.resolved.length, 0);
  const compared = report.diagrams.some((d) => d.compared);

  const parts: string[] = [];
  if (report.failed) parts.push(`**Blocking: ${report.blocking.length} ${plural(report.blocking.length, 'finding')}**`);
  if (compared) {
    parts.push(
      introduced === 0 ? 'This change introduces no new findings.' : `This change introduces ${introduced} ${plural(introduced, 'finding')}.`,
    );
    if (resolved > 0) parts.push(`It resolves ${resolved}.`);
  } else {
    const total = report.diagrams.reduce((n, d) => n + d.findings.length, 0);
    parts.push(`${total} ${plural(total, 'finding')} (no base revision to compare against).`);
  }
  if (!report.failed && options.failOn !== 'never' && introduced + resolved === 0 && compared) parts.push('✅');
  return parts.join(' ');
}

function renderDiagram(diagram: DiagramReport): string[] {
  const lines = [`### \`${diagram.path}\``];
  if (diagram.errors) {
    lines.push('', ...diagram.errors.map((e) => `- ${e}`));
    return lines;
  }

  lines.push(
    '',
    `${diagram.nodes} ${plural(diagram.nodes, 'component')}, ${diagram.edges} ${plural(diagram.edges, 'dependency', 'dependencies')} · score ${diagram.score}/100`,
  );

  if (diagram.compared) {
    if (diagram.introduced.length > 0) lines.push('', '**New in this change**', '', ...table(diagram.introduced));
    if (diagram.resolved.length > 0) {
      lines.push('', '**Resolved**', '', ...diagram.resolved.map((f) => `- ~~${escape(f.title)}~~`));
    }
    const existing = diagram.findings.length - diagram.introduced.length;
    if (existing > 0) {
      const carried = diagram.findings.filter((f) => !diagram.introduced.includes(f));
      lines.push('', `<details><summary>${existing} existing ${plural(existing, 'finding')}</summary>`, '', ...table(carried), '', '</details>');
    }
    if (diagram.findings.length === 0) lines.push('', 'No findings.');
  } else if (diagram.findings.length > 0) {
    lines.push('', ...table(diagram.findings));
  } else {
    lines.push('', 'No findings.');
  }
  return lines;
}

function table(findings: readonly Finding[]): string[] {
  return [
    '| | Finding | Rule |',
    '|---|---|---|',
    ...findings.map((f) => `| ${ICON[f.severity]} | **${escape(f.title)}**<br>${escape(f.detail)} | \`${f.ruleId}\` |`),
  ];
}

function policy(options: CheckOptions): string {
  if (options.failOn === 'never') return 'Reporting only (fail-on: never)';
  const scope = options.failScope === 'new' ? 'new' : 'any';
  return `Fails on ${scope} ${options.failOn === 'info' ? 'finding' : `${options.failOn}-or-worse finding`}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** Keep diagram text from breaking the table or injecting markup. */
function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}
