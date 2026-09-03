import { findCycles, incomingOf, longestSyncDepth, orphanNodes, outgoingOf } from './graph.js';
import type { ArchGraph, Finding, GraphIndex, Rule, Severity } from './types.js';

/** Depth beyond which a synchronous call chain starts to hurt tail latency. */
const MAX_SYNC_DEPTH = 3;
/** Outbound synchronous dependencies past which a service looks like a hub. */
const MAX_SYNC_FANOUT = 5;
/** Retry count that turns a slow dependency into a self-inflicted load spike. */
const RETRY_STORM_THRESHOLD = 3;

/** Author-marked critical nodes escalate a warning into an error. */
function escalate(base: Severity, critical: boolean | undefined): Severity {
  return critical && base === 'warning' ? 'error' : base;
}

const singleInstanceDependency: Rule = {
  id: 'spof-single-instance',
  name: 'Single point of failure',
  rationale:
    'A component with one instance takes every caller down with it when it restarts, ' +
    'deploys, or loses its host. Redundancy is what turns an outage into a blip.',
  run(graph, index) {
    const findings: Finding[] = [];
    for (const node of graph.nodes) {
      if (node.kind === 'external') continue; // Not ours to scale.
      if (node.replicas > 1) continue;

      const dependents = incomingOf(index, node.id, 'sync');
      if (dependents.length === 0) continue;

      const callers = new Set(dependents.map((e) => e.source));
      findings.push({
        ruleId: this.id,
        severity: escalate(callers.size > 1 ? 'error' : 'warning', node.critical),
        title: `${node.label} is a single point of failure`,
        detail:
          `${node.label} runs ${node.replicas} instance and ${callers.size} ` +
          `${callers.size === 1 ? 'component depends' : 'components depend'} on it synchronously. ` +
          `Losing it takes all of them down.`,
        nodeIds: [node.id, ...callers],
        edgeIds: dependents.map((e) => e.id),
      });
    }
    return findings;
  },
};

const syncMissingTimeout: Rule = {
  id: 'sync-missing-timeout',
  name: 'Synchronous call without a timeout',
  rationale:
    'A synchronous call with no timeout waits forever. Under load the caller runs out ' +
    'of connections or threads while blocked, so a slow dependency becomes a total ' +
    'outage of everything upstream of it.',
  run(graph, index) {
    const findings: Finding[] = [];
    for (const edge of graph.edges) {
      if (edge.kind !== 'sync') continue;
      if (edge.timeoutMs !== undefined) continue;

      const source = index.byId.get(edge.source);
      const target = index.byId.get(edge.target);
      if (!source || !target) continue;

      findings.push({
        ruleId: this.id,
        severity: escalate('warning', source.critical || target.critical),
        title: `${source.label} calls ${target.label} with no timeout`,
        detail:
          `An unbounded synchronous call means ${source.label} will block indefinitely if ` +
          `${target.label} stops responding, exhausting its own capacity.`,
        nodeIds: [source.id, target.id],
        edgeIds: [edge.id],
      });
    }
    return findings;
  },
};

const retryWithoutTimeout: Rule = {
  id: 'retry-without-timeout',
  name: 'Retries without a timeout',
  rationale:
    'Retrying a call that has no timeout multiplies the worst case instead of bounding ' +
    'it. The retry cannot fire until the first attempt gives up, and it never does.',
  run(graph, index) {
    const findings: Finding[] = [];
    for (const edge of graph.edges) {
      if (edge.retries === undefined || edge.retries <= 0) continue;
      if (edge.timeoutMs !== undefined) continue;

      const source = index.byId.get(edge.source);
      const target = index.byId.get(edge.target);
      if (!source || !target) continue;

      findings.push({
        ruleId: this.id,
        severity: 'error',
        title: `Retries on ${source.label} to ${target.label} are unbounded`,
        detail:
          `This edge retries ${edge.retries} times but sets no timeout, so a hung call ` +
          `never reaches the retry at all. Set a timeout first, then retry.`,
        nodeIds: [source.id, target.id],
        edgeIds: [edge.id],
      });
    }
    return findings;
  },
};

const externalWithoutCircuitBreaker: Rule = {
  id: 'external-no-circuit-breaker',
  name: 'Unprotected third-party dependency',
  rationale:
    'You cannot fix, scale, or roll back a third party. A circuit breaker lets you fail ' +
    'fast and degrade deliberately instead of queueing behind someone else outage.',
  run(graph, index) {
    const findings: Finding[] = [];
    for (const edge of graph.edges) {
      if (edge.kind !== 'sync') continue;
      if (edge.circuitBreaker) continue;

      const target = index.byId.get(edge.target);
      const source = index.byId.get(edge.source);
      if (!target || !source || target.kind !== 'external') continue;

      findings.push({
        ruleId: this.id,
        severity: escalate('warning', source.critical),
        title: `${source.label} calls ${target.label} without a circuit breaker`,
        detail:
          `${target.label} is outside your control. Without a breaker, its bad day becomes ` +
          `${source.label}'s bad day.`,
        nodeIds: [source.id, target.id],
        edgeIds: [edge.id],
      });
    }
    return findings;
  },
};

const synchronousCycle: Rule = {
  id: 'sync-cycle',
  name: 'Circular synchronous dependency',
  rationale:
    'Services that call each other in a loop cannot be started, deployed, or recovered ' +
    'independently, and a slowdown anywhere in the ring feeds back on itself.',
  run(graph, index) {
    const findings: Finding[] = [];
    for (const cycle of findCycles(graph, index, 'sync')) {
      const labels = cycle.map((id) => index.byId.get(id)?.label ?? id);
      const edgeIds: string[] = [];
      for (let i = 0; i < cycle.length; i++) {
        const from = cycle[i]!;
        const to = cycle[(i + 1) % cycle.length]!;
        for (const edge of outgoingOf(index, from, 'sync')) {
          if (edge.target === to) edgeIds.push(edge.id);
        }
      }

      findings.push({
        ruleId: this.id,
        severity: 'error',
        title: `Circular dependency: ${labels.join(' to ')}`,
        detail:
          `These ${cycle.length} components call each other synchronously in a loop. ` +
          `Break the ring by making one hop asynchronous or by extracting the shared concern.`,
        nodeIds: cycle,
        edgeIds,
      });
    }
    return findings;
  },
};

const deepSyncChain: Rule = {
  id: 'sync-chain-depth',
  name: 'Deep synchronous call chain',
  rationale:
    'Latency and failure probability both compound along a synchronous chain. Five hops ' +
    'of 99.9% availability is 99.5%, and the slowest hop sets the floor for all of them.',
  run(graph, index) {
    const findings: Finding[] = [];
    for (const node of graph.nodes) {
      // Only report from the front of a chain, otherwise every node in a long
      // path reports the same problem.
      if (incomingOf(index, node.id, 'sync').length > 0) continue;

      const depth = longestSyncDepth(index, node.id);
      if (depth <= MAX_SYNC_DEPTH) continue;

      findings.push({
        ruleId: this.id,
        severity: escalate('warning', node.critical),
        title: `${node.label} sits at the head of a ${depth}-hop synchronous chain`,
        detail:
          `A request entering ${node.label} can traverse ${depth} blocking calls before it ` +
          `returns. Consider collapsing hops or making the tail of the chain asynchronous.`,
        nodeIds: [node.id],
        edgeIds: [],
      });
    }
    return findings;
  },
};

const excessiveFanout: Rule = {
  id: 'sync-fanout',
  name: 'High synchronous fan-out',
  rationale:
    'A component that must synchronously call many others to do its job is only as ' +
    'available as the product of all of them. This is the distributed monolith smell.',
  run(graph, index) {
    const findings: Finding[] = [];
    for (const node of graph.nodes) {
      const out = outgoingOf(index, node.id, 'sync');
      if (out.length <= MAX_SYNC_FANOUT) continue;

      findings.push({
        ruleId: this.id,
        severity: escalate('warning', node.critical),
        title: `${node.label} synchronously depends on ${out.length} components`,
        detail:
          `Every one of those ${out.length} dependencies must be healthy for ${node.label} ` +
          `to serve a request. Consider async messaging or an aggregation layer.`,
        nodeIds: [node.id, ...out.map((e) => e.target)],
        edgeIds: out.map((e) => e.id),
      });
    }
    return findings;
  },
};

const datastoreDurability: Rule = {
  id: 'datastore-durability',
  name: 'Datastore without replication or backups',
  rationale:
    'Replication protects availability; backups protect against deletion and corruption. ' +
    'They solve different problems and neither substitutes for the other.',
  run(graph) {
    const findings: Finding[] = [];
    for (const node of graph.nodes) {
      if (node.kind !== 'datastore') continue;

      const missing: string[] = [];
      if (!node.hasReplica) missing.push('replication');
      if (!node.hasBackup) missing.push('backups');
      if (missing.length === 0) continue;

      findings.push({
        ruleId: this.id,
        severity: escalate(missing.length === 2 ? 'error' : 'warning', node.critical),
        title: `${node.label} has no ${missing.join(' and no ')}`,
        detail:
          missing.includes('backups')
            ? `Without backups, an accidental delete or a bad migration against ${node.label} ` +
              `is unrecoverable. Replication will faithfully copy the mistake.`
            : `Without a replica, ${node.label} is unavailable for the entire duration of any ` +
              `host failure or maintenance window.`,
        nodeIds: [node.id],
        edgeIds: [],
      });
    }
    return findings;
  },
};

const queueWithoutDlq: Rule = {
  id: 'queue-no-dlq',
  name: 'Queue without a dead-letter queue',
  rationale:
    'One malformed message with no dead-letter path is retried forever at the head of the ' +
    'queue, blocking every message behind it.',
  run(graph) {
    const findings: Finding[] = [];
    for (const node of graph.nodes) {
      if (node.kind !== 'queue' || node.hasDlq) continue;

      findings.push({
        ruleId: this.id,
        severity: escalate('warning', node.critical),
        title: `${node.label} has no dead-letter queue`,
        detail:
          `A poison message on ${node.label} will be redelivered indefinitely and stall the ` +
          `consumer. A dead-letter queue quarantines it so the rest keeps flowing.`,
        nodeIds: [node.id],
        edgeIds: [],
      });
    }
    return findings;
  },
};

const nonIdempotentConsumer: Rule = {
  id: 'async-not-idempotent',
  name: 'At-least-once delivery into a non-idempotent consumer',
  rationale:
    'Every practical broker delivers at least once, which means duplicates are normal ' +
    'operation rather than an error case. A non-idempotent consumer will double-process.',
  run(graph, index) {
    const findings: Finding[] = [];
    for (const edge of graph.edges) {
      if (edge.kind === 'sync') continue;
      if (edge.idempotent) continue;

      const source = index.byId.get(edge.source);
      const target = index.byId.get(edge.target);
      if (!source || !target) continue;

      findings.push({
        ruleId: this.id,
        severity: escalate('warning', target.critical),
        title: `${target.label} is not marked idempotent`,
        detail:
          `${source.label} delivers to ${target.label} ${edge.kind === 'stream' ? 'as a stream' : 'asynchronously'}, ` +
          `so ${target.label} must expect the same message more than once.`,
        nodeIds: [source.id, target.id],
        edgeIds: [edge.id],
      });
    }
    return findings;
  },
};

const retryStorm: Rule = {
  id: 'retry-storm',
  name: 'Aggressive retries against a fragile dependency',
  rationale:
    'Retrying hard into an already-struggling single instance adds load exactly when it ' +
    'can least afford it, converting a partial degradation into a full collapse.',
  run(graph, index) {
    const findings: Finding[] = [];
    for (const edge of graph.edges) {
      if (edge.kind !== 'sync') continue;
      if ((edge.retries ?? 0) < RETRY_STORM_THRESHOLD) continue;

      const target = index.byId.get(edge.target);
      const source = index.byId.get(edge.source);
      if (!target || !source || target.replicas > 1) continue;

      findings.push({
        ruleId: this.id,
        severity: 'warning',
        title: `${source.label} retries ${edge.retries} times into a single instance`,
        detail:
          `${target.label} runs one instance. Aggressive retries from ${source.label} will ` +
          `amplify load on it during exactly the incident you are trying to survive. ` +
          `Add backoff with jitter, or a circuit breaker.`,
        nodeIds: [source.id, target.id],
        edgeIds: [edge.id],
      });
    }
    return findings;
  },
};

const sharedDatastore: Rule = {
  id: 'shared-datastore',
  name: 'Datastore shared by multiple services',
  rationale:
    'When several services write the same store, its schema becomes an undocumented public ' +
    'API. Nobody can migrate it without coordinating every writer.',
  run(graph, index) {
    const findings: Finding[] = [];
    for (const node of graph.nodes) {
      if (node.kind !== 'datastore') continue;

      const writers = new Set(
        incomingOf(index, node.id)
          .map((e) => index.byId.get(e.source))
          .filter((n) => n?.kind === 'service' || n?.kind === 'job')
          .map((n) => n!.id),
      );
      if (writers.size < 2) continue;

      findings.push({
        ruleId: this.id,
        severity: 'warning',
        title: `${writers.size} services share ${node.label}`,
        detail:
          `${node.label} is written by ${writers.size} components, so its schema is coupled ` +
          `to all of them. Consider one owning service that the others go through.`,
        nodeIds: [node.id, ...writers],
        edgeIds: incomingOf(index, node.id)
          .filter((e) => writers.has(e.source))
          .map((e) => e.id),
      });
    }
    return findings;
  },
};

const disconnectedNode: Rule = {
  id: 'orphan-node',
  name: 'Disconnected component',
  rationale:
    'A box with no edges is either an unfinished thought or a component nobody uses. ' +
    'Both are worth resolving before the diagram is trusted.',
  run(graph, index) {
    return orphanNodes(graph, index).map((node) => ({
      ruleId: 'orphan-node',
      severity: 'info' as const,
      title: `${node.label} is not connected to anything`,
      detail: `${node.label} has no inbound or outbound dependencies.`,
      nodeIds: [node.id],
      edgeIds: [],
    }));
  },
};

/** Every rule, in the order findings are reported. */
export const RULES: readonly Rule[] = [
  synchronousCycle,
  retryWithoutTimeout,
  singleInstanceDependency,
  syncMissingTimeout,
  externalWithoutCircuitBreaker,
  datastoreDurability,
  retryStorm,
  deepSyncChain,
  excessiveFanout,
  queueWithoutDlq,
  nonIdempotentConsumer,
  sharedDatastore,
  disconnectedNode,
];

export type { ArchGraph, GraphIndex };
