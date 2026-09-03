import type { ArchGraph } from '@keel/shared';

/**
 * Render the graph as compact text for the model.
 *
 * Not JSON. A JSON dump of the same graph costs noticeably more tokens for no
 * gain in comprehension, and the ids are what matter: every finding the model
 * returns must cite one, and citing it is only possible if it is visible here.
 *
 * Nodes and edges are sorted by id so the same design always produces the same
 * string. That stability is what lets the prompt prefix be cached.
 */
export function serializeGraph(graph: ArchGraph): string {
  const lines: string[] = ['# Components'];

  for (const node of [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const attributes: string[] = [`kind=${node.kind}`, `replicas=${node.replicas}`];
    if (node.tech) attributes.push(`tech=${node.tech}`);
    if (node.critical) attributes.push('critical');
    if (node.kind === 'datastore') {
      attributes.push(`replicated=${Boolean(node.hasReplica)}`, `backups=${Boolean(node.hasBackup)}`);
    }
    if (node.kind === 'queue') attributes.push(`dlq=${Boolean(node.hasDlq)}`);

    lines.push(`- [${node.id}] "${node.label}" (${attributes.join(', ')})`);
    if (node.notes) lines.push(`    note: ${node.notes}`);
  }

  lines.push('', '# Dependencies');

  if (graph.edges.length === 0) {
    lines.push('(none)');
  }

  for (const edge of [...graph.edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const source = graph.nodes.find((n) => n.id === edge.source);
    const target = graph.nodes.find((n) => n.id === edge.target);
    if (!source || !target) continue;

    const attributes: string[] = [`kind=${edge.kind}`];
    attributes.push(edge.timeoutMs === undefined ? 'timeout=none' : `timeout=${edge.timeoutMs}ms`);
    if (edge.retries !== undefined) attributes.push(`retries=${edge.retries}`);
    if (edge.circuitBreaker) attributes.push('circuit-breaker');
    if (edge.idempotent) attributes.push('idempotent-consumer');

    const label = edge.label ? ` "${edge.label}"` : '';
    lines.push(
      `- [${edge.id}]${label} ${source.label} -> ${target.label} (${attributes.join(', ')})`,
    );
  }

  return lines.join('\n');
}
