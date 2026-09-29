"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/run.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"), 1);

// ../shared/dist/types.js
var NODE_KINDS = [
  "service",
  "datastore",
  "queue",
  "cache",
  "gateway",
  "job",
  "external"
];
var EDGE_KINDS = ["sync", "async", "stream"];

// ../shared/dist/graph.js
function indexGraph(graph) {
  const byId = /* @__PURE__ */ new Map();
  for (const node of graph.nodes)
    byId.set(node.id, node);
  const outgoing = /* @__PURE__ */ new Map();
  const incoming = /* @__PURE__ */ new Map();
  for (const node of graph.nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target))
      continue;
    outgoing.get(edge.source).push(edge);
    incoming.get(edge.target).push(edge);
  }
  return { byId, outgoing, incoming };
}
function outgoingOf(index, nodeId, kind) {
  const edges = index.outgoing.get(nodeId) ?? [];
  return kind ? edges.filter((e) => e.kind === kind) : edges;
}
function incomingOf(index, nodeId, kind) {
  const edges = index.incoming.get(nodeId) ?? [];
  return kind ? edges.filter((e) => e.kind === kind) : edges;
}
function findCycles(graph, index, kind) {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = /* @__PURE__ */ new Map();
  for (const node of graph.nodes)
    color.set(node.id, WHITE);
  const cycles = [];
  const seen = /* @__PURE__ */ new Set();
  const path2 = [];
  for (const root of graph.nodes) {
    if (color.get(root.id) !== WHITE)
      continue;
    const stack = [{ id: root.id, next: 0 }];
    color.set(root.id, GREY);
    path2.push(root.id);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const edges = outgoingOf(index, frame.id, kind);
      if (frame.next >= edges.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        path2.pop();
        continue;
      }
      const target = edges[frame.next].target;
      frame.next += 1;
      const targetColor = color.get(target);
      if (targetColor === GREY) {
        const start = path2.lastIndexOf(target);
        if (start !== -1) {
          const cycle = path2.slice(start);
          const key = canonicalCycleKey(cycle);
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(cycle);
          }
        }
      } else if (targetColor === WHITE) {
        color.set(target, GREY);
        path2.push(target);
        stack.push({ id: target, next: 0 });
      }
    }
  }
  return cycles;
}
function canonicalCycleKey(cycle) {
  let minIndex = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIndex])
      minIndex = i;
  }
  return [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)].join(">");
}
function longestSyncDepth(index, nodeId) {
  const memo = /* @__PURE__ */ new Map();
  const walk = (id, onPath) => {
    if (onPath.has(id))
      return { depth: 0, truncated: true };
    const cached = memo.get(id);
    if (cached !== void 0)
      return { depth: cached, truncated: false };
    onPath.add(id);
    let best = 0;
    let truncated = false;
    for (const edge of outgoingOf(index, id, "sync")) {
      if (onPath.has(edge.target)) {
        truncated = true;
        continue;
      }
      const result = walk(edge.target, onPath);
      truncated ||= result.truncated;
      best = Math.max(best, 1 + result.depth);
    }
    onPath.delete(id);
    if (!truncated)
      memo.set(id, best);
    return { depth: best, truncated };
  };
  return walk(nodeId, /* @__PURE__ */ new Set()).depth;
}
function orphanNodes(graph, index) {
  return graph.nodes.filter((n) => (index.outgoing.get(n.id)?.length ?? 0) === 0 && (index.incoming.get(n.id)?.length ?? 0) === 0);
}
function graphFingerprint(graph) {
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => `${n.id}:${n.kind}:${n.label}:${n.replicas}:${n.hasReplica ?? ""}:${n.hasBackup ?? ""}:${n.hasDlq ?? ""}:${n.critical ?? ""}`);
  const edges = [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)).map((e) => `${e.id}:${e.source}>${e.target}:${e.kind}:${e.timeoutMs ?? ""}:${e.retries ?? ""}:${e.circuitBreaker ?? ""}:${e.idempotent ?? ""}`);
  return fnv1a([...nodes, ...edges].join("|"));
}
function fnv1a(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ../shared/dist/rules.js
var MAX_SYNC_DEPTH = 3;
var MAX_SYNC_FANOUT = 5;
var RETRY_STORM_THRESHOLD = 3;
function escalate(base, critical) {
  return critical && base === "warning" ? "error" : base;
}
var singleInstanceDependency = {
  id: "spof-single-instance",
  name: "Single point of failure",
  rationale: "A component with one instance takes every caller down with it when it restarts, deploys, or loses its host. Redundancy is what turns an outage into a blip.",
  run(graph, index) {
    const findings = [];
    for (const node of graph.nodes) {
      if (node.kind === "external")
        continue;
      if (node.replicas > 1)
        continue;
      const dependents = incomingOf(index, node.id, "sync");
      if (dependents.length === 0)
        continue;
      const callers = new Set(dependents.map((e) => e.source));
      findings.push({
        ruleId: this.id,
        severity: escalate(callers.size > 1 ? "error" : "warning", node.critical),
        title: `${node.label} is a single point of failure`,
        detail: `${node.label} runs ${node.replicas} instance and ${callers.size} ${callers.size === 1 ? "component depends" : "components depend"} on it synchronously. Losing it takes all of them down.`,
        nodeIds: [node.id, ...callers],
        edgeIds: dependents.map((e) => e.id)
      });
    }
    return findings;
  }
};
var syncMissingTimeout = {
  id: "sync-missing-timeout",
  name: "Synchronous call without a timeout",
  rationale: "A synchronous call with no timeout waits forever. Under load the caller runs out of connections or threads while blocked, so a slow dependency becomes a total outage of everything upstream of it.",
  run(graph, index) {
    const findings = [];
    for (const edge of graph.edges) {
      if (edge.kind !== "sync")
        continue;
      if (edge.timeoutMs !== void 0)
        continue;
      const source = index.byId.get(edge.source);
      const target = index.byId.get(edge.target);
      if (!source || !target)
        continue;
      findings.push({
        ruleId: this.id,
        severity: escalate("warning", source.critical || target.critical),
        title: `${source.label} calls ${target.label} with no timeout`,
        detail: `An unbounded synchronous call means ${source.label} will block indefinitely if ${target.label} stops responding, exhausting its own capacity.`,
        nodeIds: [source.id, target.id],
        edgeIds: [edge.id]
      });
    }
    return findings;
  }
};
var retryWithoutTimeout = {
  id: "retry-without-timeout",
  name: "Retries without a timeout",
  rationale: "Retrying a call that has no timeout multiplies the worst case instead of bounding it. The retry cannot fire until the first attempt gives up, and it never does.",
  run(graph, index) {
    const findings = [];
    for (const edge of graph.edges) {
      if (edge.retries === void 0 || edge.retries <= 0)
        continue;
      if (edge.timeoutMs !== void 0)
        continue;
      const source = index.byId.get(edge.source);
      const target = index.byId.get(edge.target);
      if (!source || !target)
        continue;
      findings.push({
        ruleId: this.id,
        severity: "error",
        title: `Retries on ${source.label} to ${target.label} are unbounded`,
        detail: `This edge retries ${edge.retries} times but sets no timeout, so a hung call never reaches the retry at all. Set a timeout first, then retry.`,
        nodeIds: [source.id, target.id],
        edgeIds: [edge.id]
      });
    }
    return findings;
  }
};
var externalWithoutCircuitBreaker = {
  id: "external-no-circuit-breaker",
  name: "Unprotected third-party dependency",
  rationale: "You cannot fix, scale, or roll back a third party. A circuit breaker lets you fail fast and degrade deliberately instead of queueing behind someone else outage.",
  run(graph, index) {
    const findings = [];
    for (const edge of graph.edges) {
      if (edge.kind !== "sync")
        continue;
      if (edge.circuitBreaker)
        continue;
      const target = index.byId.get(edge.target);
      const source = index.byId.get(edge.source);
      if (!target || !source || target.kind !== "external")
        continue;
      findings.push({
        ruleId: this.id,
        severity: escalate("warning", source.critical),
        title: `${source.label} calls ${target.label} without a circuit breaker`,
        detail: `${target.label} is outside your control. Without a breaker, its bad day becomes ${source.label}'s bad day.`,
        nodeIds: [source.id, target.id],
        edgeIds: [edge.id]
      });
    }
    return findings;
  }
};
var synchronousCycle = {
  id: "sync-cycle",
  name: "Circular synchronous dependency",
  rationale: "Services that call each other in a loop cannot be started, deployed, or recovered independently, and a slowdown anywhere in the ring feeds back on itself.",
  run(graph, index) {
    const findings = [];
    for (const cycle of findCycles(graph, index, "sync")) {
      const labels = cycle.map((id) => index.byId.get(id)?.label ?? id);
      const edgeIds = [];
      for (let i = 0; i < cycle.length; i++) {
        const from = cycle[i];
        const to = cycle[(i + 1) % cycle.length];
        for (const edge of outgoingOf(index, from, "sync")) {
          if (edge.target === to)
            edgeIds.push(edge.id);
        }
      }
      findings.push({
        ruleId: this.id,
        severity: "error",
        title: `Circular dependency: ${labels.join(" to ")}`,
        detail: `These ${cycle.length} components call each other synchronously in a loop. Break the ring by making one hop asynchronous or by extracting the shared concern.`,
        nodeIds: cycle,
        edgeIds
      });
    }
    return findings;
  }
};
var deepSyncChain = {
  id: "sync-chain-depth",
  name: "Deep synchronous call chain",
  rationale: "Latency and failure probability both compound along a synchronous chain. Five hops of 99.9% availability is 99.5%, and the slowest hop sets the floor for all of them.",
  run(graph, index) {
    const findings = [];
    for (const node of graph.nodes) {
      if (incomingOf(index, node.id, "sync").length > 0)
        continue;
      const depth = longestSyncDepth(index, node.id);
      if (depth <= MAX_SYNC_DEPTH)
        continue;
      findings.push({
        ruleId: this.id,
        severity: escalate("warning", node.critical),
        title: `${node.label} sits at the head of a ${depth}-hop synchronous chain`,
        detail: `A request entering ${node.label} can traverse ${depth} blocking calls before it returns. Consider collapsing hops or making the tail of the chain asynchronous.`,
        nodeIds: [node.id],
        edgeIds: []
      });
    }
    return findings;
  }
};
var excessiveFanout = {
  id: "sync-fanout",
  name: "High synchronous fan-out",
  rationale: "A component that must synchronously call many others to do its job is only as available as the product of all of them. This is the distributed monolith smell.",
  run(graph, index) {
    const findings = [];
    for (const node of graph.nodes) {
      const out = outgoingOf(index, node.id, "sync");
      if (out.length <= MAX_SYNC_FANOUT)
        continue;
      findings.push({
        ruleId: this.id,
        severity: escalate("warning", node.critical),
        title: `${node.label} synchronously depends on ${out.length} components`,
        detail: `Every one of those ${out.length} dependencies must be healthy for ${node.label} to serve a request. Consider async messaging or an aggregation layer.`,
        nodeIds: [node.id, ...out.map((e) => e.target)],
        edgeIds: out.map((e) => e.id)
      });
    }
    return findings;
  }
};
var datastoreDurability = {
  id: "datastore-durability",
  name: "Datastore without replication or backups",
  rationale: "Replication protects availability; backups protect against deletion and corruption. They solve different problems and neither substitutes for the other.",
  run(graph) {
    const findings = [];
    for (const node of graph.nodes) {
      if (node.kind !== "datastore")
        continue;
      const missing = [];
      if (!node.hasReplica)
        missing.push("replication");
      if (!node.hasBackup)
        missing.push("backups");
      if (missing.length === 0)
        continue;
      findings.push({
        ruleId: this.id,
        severity: escalate(missing.length === 2 ? "error" : "warning", node.critical),
        title: `${node.label} has no ${missing.join(" and no ")}`,
        detail: missing.includes("backups") ? `Without backups, an accidental delete or a bad migration against ${node.label} is unrecoverable. Replication will faithfully copy the mistake.` : `Without a replica, ${node.label} is unavailable for the entire duration of any host failure or maintenance window.`,
        nodeIds: [node.id],
        edgeIds: []
      });
    }
    return findings;
  }
};
var queueWithoutDlq = {
  id: "queue-no-dlq",
  name: "Queue without a dead-letter queue",
  rationale: "One malformed message with no dead-letter path is retried forever at the head of the queue, blocking every message behind it.",
  run(graph) {
    const findings = [];
    for (const node of graph.nodes) {
      if (node.kind !== "queue" || node.hasDlq)
        continue;
      findings.push({
        ruleId: this.id,
        severity: escalate("warning", node.critical),
        title: `${node.label} has no dead-letter queue`,
        detail: `A poison message on ${node.label} will be redelivered indefinitely and stall the consumer. A dead-letter queue quarantines it so the rest keeps flowing.`,
        nodeIds: [node.id],
        edgeIds: []
      });
    }
    return findings;
  }
};
var nonIdempotentConsumer = {
  id: "async-not-idempotent",
  name: "At-least-once delivery into a non-idempotent consumer",
  rationale: "Every practical broker delivers at least once, which means duplicates are normal operation rather than an error case. A non-idempotent consumer will double-process.",
  run(graph, index) {
    const findings = [];
    for (const edge of graph.edges) {
      if (edge.kind === "sync")
        continue;
      if (edge.idempotent)
        continue;
      const source = index.byId.get(edge.source);
      const target = index.byId.get(edge.target);
      if (!source || !target)
        continue;
      findings.push({
        ruleId: this.id,
        severity: escalate("warning", target.critical),
        title: `${target.label} is not marked idempotent`,
        detail: `${source.label} delivers to ${target.label} ${edge.kind === "stream" ? "as a stream" : "asynchronously"}, so ${target.label} must expect the same message more than once.`,
        nodeIds: [source.id, target.id],
        edgeIds: [edge.id]
      });
    }
    return findings;
  }
};
var retryStorm = {
  id: "retry-storm",
  name: "Aggressive retries against a fragile dependency",
  rationale: "Retrying hard into an already-struggling single instance adds load exactly when it can least afford it, converting a partial degradation into a full collapse.",
  run(graph, index) {
    const findings = [];
    for (const edge of graph.edges) {
      if (edge.kind !== "sync")
        continue;
      if ((edge.retries ?? 0) < RETRY_STORM_THRESHOLD)
        continue;
      const target = index.byId.get(edge.target);
      const source = index.byId.get(edge.source);
      if (!target || !source || target.replicas > 1)
        continue;
      findings.push({
        ruleId: this.id,
        severity: "warning",
        title: `${source.label} retries ${edge.retries} times into a single instance`,
        detail: `${target.label} runs one instance. Aggressive retries from ${source.label} will amplify load on it during exactly the incident you are trying to survive. Add backoff with jitter, or a circuit breaker.`,
        nodeIds: [source.id, target.id],
        edgeIds: [edge.id]
      });
    }
    return findings;
  }
};
var sharedDatastore = {
  id: "shared-datastore",
  name: "Datastore shared by multiple services",
  rationale: "When several services write the same store, its schema becomes an undocumented public API. Nobody can migrate it without coordinating every writer.",
  run(graph, index) {
    const findings = [];
    for (const node of graph.nodes) {
      if (node.kind !== "datastore")
        continue;
      const writers = new Set(incomingOf(index, node.id).map((e) => index.byId.get(e.source)).filter((n) => n?.kind === "service" || n?.kind === "job").map((n) => n.id));
      if (writers.size < 2)
        continue;
      findings.push({
        ruleId: this.id,
        severity: "warning",
        title: `${writers.size} services share ${node.label}`,
        detail: `${node.label} is written by ${writers.size} components, so its schema is coupled to all of them. Consider one owning service that the others go through.`,
        nodeIds: [node.id, ...writers],
        edgeIds: incomingOf(index, node.id).filter((e) => writers.has(e.source)).map((e) => e.id)
      });
    }
    return findings;
  }
};
var disconnectedNode = {
  id: "orphan-node",
  name: "Disconnected component",
  rationale: "A box with no edges is either an unfinished thought or a component nobody uses. Both are worth resolving before the diagram is trusted.",
  run(graph, index) {
    return orphanNodes(graph, index).map((node) => ({
      ruleId: "orphan-node",
      severity: "info",
      title: `${node.label} is not connected to anything`,
      detail: `${node.label} has no inbound or outbound dependencies.`,
      nodeIds: [node.id],
      edgeIds: []
    }));
  }
};
var RULES = [
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
  disconnectedNode
];

// ../shared/dist/evidence.js
var DEFAULT_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var HOT_SHARE = 0.25;
function resolveEvidence(graph, sets, options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_EVIDENCE_MAX_AGE_MS;
  const byRef = /* @__PURE__ */ new Map();
  for (const node of graph.nodes) {
    const key = node.ref?.trim() || node.id;
    const bucket = byRef.get(key);
    if (bucket)
      bucket.push(node);
    else
      byRef.set(key, [node]);
  }
  const edgesByPair = /* @__PURE__ */ new Map();
  for (const edge of graph.edges) {
    const key = pairKey(edge.source, edge.target);
    const bucket = edgesByPair.get(key);
    if (bucket)
      bucket.push(edge);
    else
      edgesByPair.set(key, [edge]);
  }
  const evidence = {
    nodes: {},
    edges: {},
    traffic: {},
    hotNodeIds: [],
    sources: [],
    undiagrammed: []
  };
  const ordered = [...sets].sort((a, b) => timeOf(a.observedAt) - timeOf(b.observedAt));
  const undiagrammed = /* @__PURE__ */ new Map();
  for (const set of ordered) {
    const observedAt = timeOf(set.observedAt);
    const ageMs = Number.isFinite(observedAt) ? Math.max(0, now - observedAt) : Number.POSITIVE_INFINITY;
    const stale = !(ageMs <= maxAgeMs);
    const matchedNodeIds = /* @__PURE__ */ new Set();
    const matchedEdgeIds = /* @__PURE__ */ new Set();
    const unmatchedRefs = /* @__PURE__ */ new Set();
    for (const observation of set.nodes ?? []) {
      const targets = byRef.get(observation.ref);
      if (!targets) {
        unmatchedRefs.add(observation.ref);
        continue;
      }
      const fields = defined({
        replicas: observation.replicas,
        hasReplica: observation.hasReplica,
        hasBackup: observation.hasBackup,
        hasDlq: observation.hasDlq,
        rps: observation.rps,
        errorRate: observation.errorRate
      });
      for (const node of targets) {
        matchedNodeIds.add(node.id);
        if (!stale)
          evidence.nodes[node.id] = { ...evidence.nodes[node.id], ...fields };
      }
    }
    for (const observation of set.edges ?? []) {
      const sources = byRef.get(observation.source);
      const targets = byRef.get(observation.target);
      if (!sources)
        unmatchedRefs.add(observation.source);
      if (!targets)
        unmatchedRefs.add(observation.target);
      if (!sources || !targets)
        continue;
      const fields = defined({
        timeoutMs: observation.timeoutMs,
        retries: observation.retries,
        circuitBreaker: observation.circuitBreaker,
        p99Ms: observation.p99Ms,
        rps: observation.rps,
        errorRate: observation.errorRate
      });
      for (const from of sources) {
        for (const to of targets) {
          const drawn = edgesByPair.get(pairKey(from.id, to.id));
          if (!drawn) {
            if (!stale && observation.rps !== 0) {
              undiagrammed.set(pairKey(from.id, to.id), {
                sourceId: from.id,
                targetId: to.id,
                source: set.source,
                ...observation.rps !== void 0 ? { rps: observation.rps } : {}
              });
            }
            continue;
          }
          for (const edge of drawn) {
            matchedEdgeIds.add(edge.id);
            if (!stale)
              evidence.edges[edge.id] = { ...evidence.edges[edge.id], ...fields };
          }
        }
      }
    }
    evidence.sources.push({
      source: set.source,
      observedAt: set.observedAt,
      ageMs,
      stale,
      matchedNodeIds: [...matchedNodeIds].sort(),
      matchedEdgeIds: [...matchedEdgeIds].sort(),
      unmatchedRefs: [...unmatchedRefs].sort()
    });
  }
  evidence.undiagrammed = [...undiagrammed.values()];
  computeTraffic(graph, evidence);
  return evidence;
}
function computeTraffic(graph, evidence) {
  const inbound = /* @__PURE__ */ new Map();
  for (const edge of graph.edges) {
    const rps = evidence.edges[edge.id]?.rps;
    if (rps === void 0)
      continue;
    evidence.traffic[edge.id] = rps;
    inbound.set(edge.target, (inbound.get(edge.target) ?? 0) + rps);
  }
  let busiest = 0;
  for (const node of graph.nodes) {
    const rps = evidence.nodes[node.id]?.rps ?? inbound.get(node.id);
    if (rps === void 0)
      continue;
    evidence.traffic[node.id] = rps;
    busiest = Math.max(busiest, rps);
  }
  if (busiest <= 0)
    return;
  evidence.hotNodeIds = graph.nodes.filter((node) => (evidence.traffic[node.id] ?? 0) >= busiest * HOT_SHARE).map((node) => node.id);
}
function applyEvidence(graph, evidence) {
  const hot = new Set(evidence.hotNodeIds);
  const nodes = graph.nodes.map((node) => {
    const observed = evidence.nodes[node.id];
    const isHot = hot.has(node.id);
    if (!observed && !isHot)
      return node;
    const next = { ...node };
    if (observed?.replicas !== void 0)
      next.replicas = observed.replicas;
    if (observed?.hasReplica !== void 0)
      next.hasReplica = observed.hasReplica;
    if (observed?.hasBackup !== void 0)
      next.hasBackup = observed.hasBackup;
    if (observed?.hasDlq !== void 0)
      next.hasDlq = observed.hasDlq;
    if (isHot)
      next.critical = true;
    return next;
  });
  const edges = graph.edges.map((edge) => {
    const observed = evidence.edges[edge.id];
    if (!observed)
      return edge;
    const next = { ...edge };
    if (observed.timeoutMs === null)
      delete next.timeoutMs;
    else if (observed.timeoutMs !== void 0)
      next.timeoutMs = observed.timeoutMs;
    if (observed.retries !== void 0)
      next.retries = observed.retries;
    if (observed.circuitBreaker !== void 0)
      next.circuitBreaker = observed.circuitBreaker;
    return next;
  });
  return { nodes, edges };
}
var pairKey = (source, target) => `${source}\0${target}`;
var timeOf = (iso) => Date.parse(iso);
function defined(value) {
  const out = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== void 0)
      out[key] = field;
  }
  return out;
}

// ../shared/dist/intent.js
var NODE_INTENT_FIELDS = ["kind", "replicas", "critical", "hasReplica", "hasBackup", "hasDlq", "ref"];
var EDGE_INTENT_FIELDS = ["kind", "source", "target", "timeoutMs", "retries", "circuitBreaker", "idempotent"];
var BOOLEAN_FIELDS = /* @__PURE__ */ new Set(["critical", "hasReplica", "hasBackup", "hasDlq", "circuitBreaker", "idempotent"]);
function normalizeField(field, value) {
  if (BOOLEAN_FIELDS.has(field))
    return value === true;
  if (field === "retries")
    return typeof value === "number" ? value : 0;
  if (value === void 0 || value === null)
    return null;
  if (typeof value === "string")
    return field === "ref" ? value.trim() || null : value;
  if (typeof value === "number" || typeof value === "boolean")
    return value;
  return null;
}
function declaredField(element, field) {
  return normalizeField(field, element[field]);
}
function intentFieldsFor(kind) {
  return kind === "node" ? NODE_INTENT_FIELDS : EDGE_INTENT_FIELDS;
}
function readLayout(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return void 0;
  const record = value;
  const layout = {};
  for (const key of ["label", "tech", "notes"]) {
    if (typeof record[key] === "string")
      layout[key] = record[key];
  }
  for (const key of ["x", "y", "w", "h"]) {
    const n = record[key];
    if (typeof n === "number" && Number.isFinite(n))
      layout[key] = n;
  }
  return layout;
}

// ../shared/dist/reality.js
var REALITY_CHECKS = [
  {
    id: "observed-drift",
    name: "Running system differs from the diagram",
    rationale: "A number typed into a diagram is a claim. When the running system reports a different value, every rule that trusted the claim was checking a system that does not exist."
  },
  {
    id: "unapproved-change",
    name: "Change without approval",
    rationale: "Without a record of what was approved, an intended change and an accident look identical. A baseline is what makes drift actionable."
  },
  {
    id: "timeout-below-latency",
    name: "Timeout below observed latency",
    rationale: "A timeout shorter than the real p99 fails healthy requests every day, and retries turn each of those failures into extra load on the dependency that was already slow."
  },
  {
    id: "undiagrammed-dependency",
    name: "Dependency missing from the diagram",
    rationale: "A call that runs in production but is not drawn is invisible to every rule. The riskiest dependency is usually the one nobody remembered to draw."
  },
  {
    id: "stale-evidence",
    name: "Stale observations",
    rationale: "Evidence older than the freshness window is not applied, so the components it covered fall back to trusting what was typed."
  }
];
var NODE_OBSERVABLE = ["replicas", "hasReplica", "hasBackup", "hasDlq"];
var EDGE_OBSERVABLE = ["timeoutMs", "retries", "circuitBreaker"];
function realityFindings(input) {
  const findings = [];
  const effectiveById = /* @__PURE__ */ new Map();
  for (const node of input.effective.nodes)
    effectiveById.set(node.id, node);
  const effectiveEdges = /* @__PURE__ */ new Map();
  for (const edge of input.effective.edges)
    effectiveEdges.set(edge.id, edge);
  const hasBaseline = Object.keys(input.intent).length > 0;
  const labelOf = (id) => input.index.byId.get(id)?.label ?? id;
  for (const node of input.declared.nodes) {
    const critical = effectiveById.get(node.id)?.critical;
    findings.push(...compareElement({
      element: node,
      kind: "node",
      label: node.label,
      observed: input.evidence?.nodes[node.id],
      observable: NODE_OBSERVABLE,
      intent: input.intent[node.id],
      hasBaseline,
      critical,
      nodeIds: [node.id],
      edgeIds: [],
      labelOf
    }));
  }
  for (const edge of input.declared.edges) {
    if (!input.index.byId.has(edge.source) || !input.index.byId.has(edge.target))
      continue;
    const critical = effectiveById.get(edge.source)?.critical || effectiveById.get(edge.target)?.critical;
    findings.push(...compareElement({
      element: edge,
      kind: "edge",
      label: `${labelOf(edge.source)} to ${labelOf(edge.target)}`,
      observed: input.evidence?.edges[edge.id],
      observable: EDGE_OBSERVABLE,
      intent: input.intent[edge.id],
      hasBaseline,
      critical,
      nodeIds: [edge.source, edge.target],
      edgeIds: [edge.id],
      labelOf
    }));
  }
  const present = /* @__PURE__ */ new Set([...input.declared.nodes.map((n) => n.id), ...input.declared.edges.map((e) => e.id)]);
  for (const [id, approved] of Object.entries(input.intent)) {
    if (present.has(id))
      continue;
    findings.push({
      ruleId: "unapproved-change",
      severity: "info",
      title: `${approved.label} was removed from the approved design`,
      detail: `The approved baseline still includes this ${approved.kind === "node" ? "component" : "dependency"}. Approve the removal if it was intended.`,
      nodeIds: [],
      edgeIds: [],
      deltas: [{ elementId: id, field: "exists", declared: false, approved: true }],
      fix: "approve"
    });
  }
  if (input.evidence) {
    findings.push(...latencyFindings(input, effectiveById, effectiveEdges, labelOf));
    findings.push(...undiagrammedFindings(input.evidence, effectiveById, labelOf));
    findings.push(...staleFindings(input.evidence, input.maxAgeMs));
  }
  return findings;
}
function compareElement(input) {
  const { element, intent } = input;
  const drift = /* @__PURE__ */ new Map();
  const changes = /* @__PURE__ */ new Map();
  for (const field of intentFieldsFor(input.kind)) {
    const declared = declaredField(element, field);
    const observed = input.observable.includes(field) ? observedField(input.observed, field) : void 0;
    const approval = intent?.fields[field];
    const delta = {
      elementId: element.id,
      field,
      declared,
      ...observed !== void 0 ? { observed } : {},
      ...approval ? { approved: approval.value } : {}
    };
    const drifted = observed !== void 0 && observed !== declared;
    const changed = approval !== void 0 && approval.value !== declared;
    if (drifted) {
      let kind;
      if (!approval)
        kind = "drift";
      else if (observed === approval.value)
        kind = null;
      else if (!changed && "previous" in approval && observed === approval.previous)
        kind = "rollout-pending";
      else
        kind = "unapproved-drift";
      if (kind) {
        const bucket = drift.get(kind) ?? { deltas: [], dangerous: false };
        bucket.deltas.push(delta);
        bucket.dangerous ||= isDangerous(field, declared, observed);
        drift.set(kind, bucket);
      }
    }
    if (changed) {
      const kind = observed !== void 0 && observed === declared ? "shipped" : "pending";
      changes.set(kind, [...changes.get(kind) ?? [], delta]);
    }
  }
  const findings = [];
  const cite = { nodeIds: input.nodeIds, edgeIds: input.edgeIds };
  const describe = (deltas, pick) => deltas.map((d) => `${FIELD_NAMES[d.field] ?? d.field} ${pick(d)}`).join("; ");
  const fmt = (d, value) => formatValue(d.field, value ?? null, input.labelOf);
  const plain = drift.get("drift");
  if (plain) {
    findings.push({
      ruleId: "observed-drift",
      severity: plain.dangerous ? escalate2("warning", input.critical) : "info",
      title: `${input.label} does not run the way it is drawn`,
      detail: `Drawn vs running: ${describe(plain.deltas, (d) => `${fmt(d, d.declared)} vs ${fmt(d, d.observed)}`)}. Findings here use the running values.`,
      ...cite,
      observed: true,
      deltas: plain.deltas,
      fix: "accept-observed"
    });
  }
  const accident = drift.get("unapproved-drift");
  if (accident) {
    findings.push({
      ruleId: "observed-drift",
      severity: accident.dangerous ? "error" : "warning",
      title: `${input.label} drifted from the approved design`,
      detail: `Approved: ${describe(accident.deltas, (d) => fmt(d, d.approved))}. Running: ${describe(accident.deltas, (d) => fmt(d, d.observed))}. Nobody approved this, so treat it as an accident until someone does.`,
      ...cite,
      observed: true,
      deltas: accident.deltas,
      fix: "accept-observed"
    });
  }
  const rollout = drift.get("rollout-pending");
  if (rollout) {
    findings.push({
      ruleId: "observed-drift",
      severity: "info",
      title: `Approved change to ${input.label} is not live yet`,
      detail: `Approved: ${describe(rollout.deltas, (d) => fmt(d, d.approved))}. Still running the previous value: ${describe(rollout.deltas, (d) => fmt(d, d.observed))}.`,
      ...cite,
      observed: true,
      deltas: rollout.deltas
    });
  }
  const shipped = changes.get("shipped");
  if (shipped) {
    findings.push({
      ruleId: "unapproved-change",
      severity: "warning",
      title: `Unapproved change to ${input.label} is already live`,
      detail: `${capitalise(describe(shipped, (d) => `approved ${fmt(d, d.approved)}, now ${fmt(d, d.declared)}`))}. The running system matches the diagram, but nobody approved the change.`,
      ...cite,
      deltas: shipped,
      fix: "approve"
    });
  }
  const pending = changes.get("pending");
  if (pending) {
    findings.push({
      ruleId: "unapproved-change",
      severity: "info",
      title: `${input.label} changed since it was approved`,
      detail: `${capitalise(describe(pending, (d) => `approved ${fmt(d, d.approved)}, drawn ${fmt(d, d.declared)}`))}. Approve it to make this the new baseline.`,
      ...cite,
      deltas: pending,
      fix: "approve"
    });
  }
  if (!intent && input.hasBaseline) {
    findings.push({
      ruleId: "unapproved-change",
      severity: "info",
      title: `${input.label} is not in the approved design`,
      detail: `It was added after the baseline was approved.`,
      ...cite,
      deltas: intentFieldsFor(input.kind).map((field) => ({
        elementId: element.id,
        field,
        declared: declaredField(element, field)
      })),
      fix: "approve"
    });
  }
  return findings;
}
function latencyFindings(input, nodes, edges, labelOf) {
  const findings = [];
  for (const [edgeId, observed] of Object.entries(input.evidence?.edges ?? {})) {
    const edge = edges.get(edgeId);
    const p99 = observed.p99Ms;
    if (!edge || p99 === void 0 || edge.timeoutMs === void 0 || p99 < edge.timeoutMs)
      continue;
    const source = labelOf(edge.source);
    const target = labelOf(edge.target);
    const retries = edge.retries ?? 0;
    const critical = nodes.get(edge.source)?.critical || nodes.get(edge.target)?.critical;
    findings.push({
      ruleId: "timeout-below-latency",
      severity: retries > 0 ? "error" : escalate2("warning", critical),
      title: `${source} to ${target} times out in normal operation`,
      detail: `Observed p99 is ${formatMs(p99)} against a ${formatMs(edge.timeoutMs)} timeout, so at least 1% of healthy calls fail` + (retries > 0 ? ` and each one is retried ${retries} ${retries === 1 ? "time" : "times"}, adding load to ${target}` : "") + `. Raise the timeout above real latency, or fix the latency.`,
      nodeIds: [edge.source, edge.target],
      edgeIds: [edge.id],
      observed: true
    });
  }
  return findings;
}
function undiagrammedFindings(evidence, nodes, labelOf) {
  return evidence.undiagrammed.map((call) => {
    const source = labelOf(call.sourceId);
    const target = labelOf(call.targetId);
    const critical = nodes.get(call.sourceId)?.critical || nodes.get(call.targetId)?.critical;
    return {
      ruleId: "undiagrammed-dependency",
      severity: escalate2("warning", critical),
      title: `${source} calls ${target}, but the diagram does not show it`,
      detail: `${call.source} observed this call${call.rps !== void 0 ? ` at ${formatRps(call.rps)}` : ""}. Every rule that reasons about ${source}'s dependencies is blind to it until it is drawn.`,
      nodeIds: [call.sourceId, call.targetId],
      edgeIds: [],
      observed: true,
      ...call.rps !== void 0 ? { trafficRps: call.rps } : {}
    };
  });
}
function staleFindings(evidence, maxAgeMs) {
  return evidence.sources.filter((source) => source.stale).map((source) => {
    const covered = source.matchedNodeIds.length + source.matchedEdgeIds.length;
    return {
      ruleId: "stale-evidence",
      severity: "info",
      title: Number.isFinite(source.ageMs) ? `Observations from ${source.source} are ${formatAge(source.ageMs)} old` : `Observations from ${source.source} have no valid timestamp`,
      detail: `Anything older than ${formatAge(maxAgeMs)} is not applied, so the ${covered} ${covered === 1 ? "element" : "elements"} it covers ${covered === 1 ? "is" : "are"} validated as drawn. Push fresh observations to keep the diagram honest.`,
      nodeIds: source.matchedNodeIds,
      edgeIds: source.matchedEdgeIds
    };
  });
}
function observedField(observed, field) {
  if (!observed)
    return void 0;
  const raw = observed[field];
  if (raw === void 0)
    return void 0;
  return normalizeField(field, raw);
}
function isDangerous(field, declared, observed) {
  switch (field) {
    case "replicas":
      return typeof declared === "number" && typeof observed === "number" && observed < declared;
    case "timeoutMs":
      return typeof declared === "number" && (observed === null || typeof observed === "number" && observed > declared);
    case "retries":
      return typeof declared === "number" && typeof observed === "number" && observed > declared;
    default:
      return declared === true && observed === false;
  }
}
function escalate2(base, critical) {
  return critical && base === "warning" ? "error" : base;
}
var FIELD_NAMES = {
  kind: "kind",
  replicas: "instances",
  critical: "critical path",
  hasReplica: "replica",
  hasBackup: "backups",
  hasDlq: "dead-letter queue",
  ref: "runtime name",
  source: "caller",
  target: "callee",
  timeoutMs: "timeout",
  retries: "retries",
  circuitBreaker: "circuit breaker",
  idempotent: "idempotent consumer"
};
function formatValue(field, value, labelOf = (id) => id) {
  if (value === null)
    return "none";
  if (typeof value === "boolean")
    return value ? "yes" : "no";
  if (field === "timeoutMs" && typeof value === "number")
    return formatMs(value);
  if ((field === "source" || field === "target") && typeof value === "string")
    return labelOf(value);
  return String(value);
}
function formatMs(ms) {
  if (ms < 1e3)
    return `${ms}ms`;
  const seconds = ms / 1e3;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}
function formatRps(rps) {
  if (rps >= 1e3)
    return `${(rps / 1e3).toFixed(rps >= 1e4 ? 0 : 1)}k rps`;
  return `${Number.isInteger(rps) ? rps : rps.toFixed(1)} rps`;
}
function formatAge(ms) {
  const minutes = Math.max(1, Math.round(ms / 6e4));
  if (minutes < 60)
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(ms / 36e5);
  if (hours < 48)
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(ms / 864e5);
  return `${days} days`;
}
var capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// ../shared/dist/tuning.js
function findingKey(finding) {
  return `${finding.ruleId}|${[...finding.nodeIds].sort().join(",")}|${[...finding.edgeIds].sort().join(",")}`;
}
var TUNABLE_CHECKS = [
  ...RULES.map((rule) => ({ id: rule.id, name: rule.name, rationale: rule.rationale, reality: false })),
  ...REALITY_CHECKS.map((check) => ({ ...check, reality: true }))
];
function mutedRuleIds(settings) {
  return Object.entries(settings ?? {}).filter(([, setting]) => setting.muted).map(([id]) => id);
}
var HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1e3;

// ../shared/dist/validate.js
var SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
var SEVERITY_WEIGHT = { error: 3, warning: 1, info: 0 };
function validate(graph, options = {}) {
  const disabled = /* @__PURE__ */ new Set([...options.disabledRuleIds ?? [], ...mutedRuleIds(options.ruleSettings)]);
  const rules = (options.rules ?? RULES).filter((rule) => !disabled.has(rule.id));
  const index = indexGraph(graph);
  const maxAgeMs = options.evidenceMaxAgeMs ?? DEFAULT_EVIDENCE_MAX_AGE_MS;
  const evidence = options.observations && options.observations.length > 0 ? resolveEvidence(graph, options.observations, { now: options.now ?? Date.now(), maxAgeMs }) : null;
  const effective = evidence ? applyEvidence(graph, evidence) : graph;
  const findings = runRules(rules, effective, evidence ? indexGraph(effective) : index);
  if (evidence && effective !== graph) {
    const declaredKeys = new Set(runRules(rules, graph, index).map(findingKey));
    for (const finding of findings) {
      if (!declaredKeys.has(findingKey(finding)))
        finding.observed = true;
    }
  }
  findings.push(...realityFindings({
    declared: graph,
    effective,
    index,
    evidence,
    intent: options.intent ?? {},
    maxAgeMs
  }).filter((finding) => !disabled.has(finding.ruleId)));
  for (const finding of findings) {
    const override = options.ruleSettings?.[finding.ruleId]?.severity;
    if (override)
      finding.severity = override;
  }
  if (evidence)
    weighByTraffic(findings, graph, evidence);
  const dismissed = [];
  const kept = [];
  for (const finding of findings) {
    const label = options.labels?.[findingKey(finding)];
    if (label?.verdict === "noise")
      dismissed.push(finding);
    else {
      if (label?.verdict === "real")
        finding.verdict = "real";
      kept.push(finding);
    }
  }
  kept.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0)
      return bySeverity;
    const byTraffic = compareTraffic(a.trafficRps, b.trafficRps);
    if (byTraffic !== 0)
      return byTraffic;
    return a.ruleId.localeCompare(b.ruleId) || a.title.localeCompare(b.title);
  });
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of kept)
    counts[finding.severity] += 1;
  return {
    findings: kept,
    counts,
    score: score(graph, kept),
    fingerprint: graphFingerprint(graph),
    ...evidence ? { evidence } : {},
    dismissed
  };
}
function runRules(rules, graph, index) {
  const findings = [];
  for (const rule of rules) {
    try {
      findings.push(...rule.run(graph, index));
    } catch (error) {
      findings.push({
        ruleId: rule.id,
        severity: "info",
        title: `Rule "${rule.name}" could not run`,
        detail: error instanceof Error ? error.message : String(error),
        nodeIds: [],
        edgeIds: []
      });
    }
  }
  return findings;
}
var SEVERITY_DOWN = { error: "warning", warning: "info", info: "info" };
function weighByTraffic(findings, graph, evidence) {
  const declaredCritical = new Set(graph.nodes.filter((n) => n.critical).map((n) => n.id));
  for (const finding of findings) {
    const samples = [...finding.nodeIds, ...finding.edgeIds].map((id) => evidence.traffic[id]).filter((rps) => rps !== void 0);
    if (samples.length === 0)
      continue;
    const peak = Math.max(finding.trafficRps ?? 0, ...samples);
    finding.trafficRps = peak;
    if (peak === 0 && finding.severity !== "info" && !finding.nodeIds.some((id) => declaredCritical.has(id))) {
      finding.severity = SEVERITY_DOWN[finding.severity];
      finding.detail += " Downgraded because no traffic was observed here.";
    }
  }
}
function compareTraffic(a, b) {
  const tier = (rps) => rps === void 0 ? 1 : rps > 0 ? 0 : 2;
  const byTier = tier(a) - tier(b);
  if (byTier !== 0)
    return byTier;
  return (b ?? 0) - (a ?? 0);
}
function score(graph, findings) {
  const size = graph.nodes.length + graph.edges.length;
  if (size === 0)
    return 100;
  const penalty = findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const normalised = penalty / size;
  return Math.max(0, Math.min(100, Math.round(100 - normalised * 100)));
}

// ../shared/dist/factory.js
var DEFAULT_NODE_SIZE = { w: 184, h: 84 };

// ../shared/dist/review.js
var NODE_KIND_SET = new Set(NODE_KINDS);
var EDGE_KIND_SET = new Set(EDGE_KINDS);

// ../shared/dist/incident.js
var EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;

// ../shared/dist/diagram-file.js
var DIAGRAM_FORMAT = "keel-diagram";
var DIAGRAM_VERSION = 1;
var MAX_IMPORT_NODES = 500;
var MAX_IMPORT_EDGES = 1500;
var MAX_REPORTED_ERRORS = 5;
function parseDiagram(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["The file is not valid JSON."] };
  }
  const errors = [];
  const fail = (message) => {
    if (errors.length < MAX_REPORTED_ERRORS)
      errors.push(message);
  };
  if (!isRecord(raw))
    return { ok: false, errors: ['Expected a JSON object with "nodes" and "edges".'] };
  if (raw["format"] !== void 0 && raw["format"] !== DIAGRAM_FORMAT) {
    return { ok: false, errors: [`Unknown format ${JSON.stringify(raw["format"])}. Expected "${DIAGRAM_FORMAT}".`] };
  }
  if (typeof raw["version"] === "number" && raw["version"] > DIAGRAM_VERSION) {
    return {
      ok: false,
      errors: [`This file is format version ${raw["version"]}; this version of Keel reads up to ${DIAGRAM_VERSION}.`]
    };
  }
  if (!Array.isArray(raw["nodes"]) || !Array.isArray(raw["edges"])) {
    return { ok: false, errors: ['Expected "nodes" and "edges" arrays.'] };
  }
  if (raw["nodes"].length > MAX_IMPORT_NODES)
    fail(`Too many components (${raw["nodes"].length}; the limit is ${MAX_IMPORT_NODES}).`);
  if (raw["edges"].length > MAX_IMPORT_EDGES)
    fail(`Too many dependencies (${raw["edges"].length}; the limit is ${MAX_IMPORT_EDGES}).`);
  if (errors.length > 0)
    return { ok: false, errors };
  const nodes = [];
  const ids = /* @__PURE__ */ new Set();
  raw["nodes"].forEach((value, i) => {
    const node = readNode(value, `Component ${i + 1}`, fail);
    if (!node)
      return;
    if (ids.has(node.id))
      fail(`Component ${i + 1} reuses the id "${node.id}".`);
    ids.add(node.id);
    nodes.push(node);
  });
  const nodeIds = new Set(raw["nodes"].flatMap((n) => isRecord(n) && typeof n["id"] === "string" ? [n["id"]] : []));
  const edges = [];
  raw["edges"].forEach((value, i) => {
    const edge = readEdge(value, `Dependency ${i + 1}`, fail);
    if (!edge)
      return;
    if (ids.has(edge.id))
      fail(`Dependency ${i + 1} reuses the id "${edge.id}".`);
    ids.add(edge.id);
    for (const end of [edge.source, edge.target]) {
      if (!nodeIds.has(end))
        fail(`Dependency ${i + 1} points at "${end}", which is not a component in the file.`);
    }
    edges.push(edge);
  });
  const intent = raw["intent"] === void 0 ? {} : readIntent(raw["intent"], fail);
  if (errors.length > 0)
    return { ok: false, errors };
  return { ok: true, graph: { nodes, edges }, intent };
}
function readNode(value, where, fail) {
  if (!isRecord(value)) {
    fail(`${where} is not an object.`);
    return null;
  }
  const id = value["id"];
  const kind = value["kind"];
  if (!isId(id)) {
    fail(`${where} needs a string "id" of 1 to 64 characters.`);
    return null;
  }
  if (typeof kind !== "string" || !NODE_KINDS.includes(kind)) {
    fail(`${where} ("${id}") has kind ${JSON.stringify(kind) ?? "undefined"}; expected one of ${NODE_KINDS.join(", ")}.`);
    return null;
  }
  const numberOr = (key, fallback) => {
    const field = value[key];
    if (field === void 0)
      return fallback;
    if (typeof field !== "number" || !Number.isFinite(field)) {
      fail(`${where} ("${id}") has a non-numeric "${key}".`);
      return fallback;
    }
    return field;
  };
  const replicas = numberOr("replicas", 1);
  if (!Number.isInteger(replicas) || replicas < 0)
    fail(`${where} ("${id}") needs a whole, non-negative "replicas".`);
  const node = {
    id,
    kind,
    label: typeof value["label"] === "string" ? value["label"] : "Untitled",
    x: numberOr("x", 0),
    y: numberOr("y", 0),
    w: positive(numberOr("w", DEFAULT_NODE_SIZE.w), DEFAULT_NODE_SIZE.w),
    h: positive(numberOr("h", DEFAULT_NODE_SIZE.h), DEFAULT_NODE_SIZE.h),
    replicas
  };
  for (const key of ["tech", "notes", "ref"]) {
    const field = optional(value, key, "string", where, id, fail);
    if (field !== void 0)
      node[key] = field;
  }
  for (const key of ["critical", "hasReplica", "hasBackup", "hasDlq"]) {
    const field = optional(value, key, "boolean", where, id, fail);
    if (field !== void 0)
      node[key] = field;
  }
  return node;
}
function readEdge(value, where, fail) {
  if (!isRecord(value)) {
    fail(`${where} is not an object.`);
    return null;
  }
  const { id, source, target, kind } = value;
  if (!isId(id)) {
    fail(`${where} needs a string "id" of 1 to 64 characters.`);
    return null;
  }
  if (typeof source !== "string" || typeof target !== "string") {
    fail(`${where} ("${id}") needs string "source" and "target" ids.`);
    return null;
  }
  if (typeof kind !== "string" || !EDGE_KINDS.includes(kind)) {
    fail(`${where} ("${id}") has kind ${JSON.stringify(kind) ?? "undefined"}; expected one of ${EDGE_KINDS.join(", ")}.`);
    return null;
  }
  const edge = { id, source, target, kind };
  const label = optional(value, "label", "string", where, id, fail);
  if (label !== void 0)
    edge.label = label;
  for (const key of ["timeoutMs", "retries"]) {
    const field = optional(value, key, "number", where, id, fail);
    if (field === void 0)
      continue;
    if (!Number.isFinite(field) || field < 0)
      fail(`${where} ("${id}") needs a non-negative "${key}".`);
    else
      edge[key] = field;
  }
  for (const key of ["circuitBreaker", "idempotent"]) {
    const field = optional(value, key, "boolean", where, id, fail);
    if (field !== void 0)
      edge[key] = field;
  }
  return edge;
}
function readIntent(value, fail) {
  if (!isRecord(value)) {
    fail('"intent" is not an object.');
    return {};
  }
  const intent = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isRecord(entry) || entry["kind"] !== "node" && entry["kind"] !== "edge" || !isRecord(entry["fields"])) {
      fail(`The approval for "${id}" is malformed.`);
      continue;
    }
    const kind = entry["kind"];
    const allowed = kind === "node" ? NODE_INTENT_FIELDS : EDGE_INTENT_FIELDS;
    const fields = {};
    for (const [field, approved] of Object.entries(entry["fields"])) {
      if (!allowed.includes(field))
        continue;
      if (!isRecord(approved) || !isFieldValue(approved["value"]) || typeof approved["by"] !== "string" || typeof approved["at"] !== "string") {
        fail(`The approval for "${id}" has a malformed "${field}".`);
        continue;
      }
      fields[field] = {
        value: approved["value"],
        ...isFieldValue(approved["previous"]) ? { previous: approved["previous"] } : {},
        by: approved["by"],
        at: approved["at"]
      };
    }
    const element = {
      kind,
      label: typeof entry["label"] === "string" ? entry["label"] : id,
      fields
    };
    const layout = readLayout(entry["layout"]);
    if (layout)
      element.layout = layout;
    intent[id] = element;
  }
  return intent;
}
function optional(record, key, type, where, id, fail) {
  const field = record[key];
  if (field === void 0 || field === null)
    return void 0;
  if (typeof field !== type) {
    fail(`${where} ("${id}") has a "${key}" that is not a ${type}.`);
    return void 0;
  }
  return field;
}
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isId = (value) => typeof value === "string" && value.length > 0 && value.length <= 64;
var isFieldValue = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);
var positive = (value, fallback) => value > 0 ? value : fallback;

// ../shared/dist/doc-schema.js
var NODE_KIND_SET2 = new Set(NODE_KINDS);
var EDGE_KIND_SET2 = new Set(EDGE_KINDS);

// src/check.ts
var SEVERITY_RANK = { error: 0, warning: 1, info: 2 };
function findingKey2(finding) {
  return [finding.ruleId, [...finding.nodeIds].sort().join(","), [...finding.edgeIds].sort().join(",")].join("|");
}
function checkDiagrams(inputs, options) {
  const diagrams = inputs.map((input) => checkOne(input, options));
  const blocking = [];
  for (const diagram of diagrams) {
    if (options.failOn === "never") break;
    const threshold = SEVERITY_RANK[options.failOn];
    const pool = options.failScope === "new" && diagram.compared ? diagram.introduced : diagram.findings;
    for (const finding of pool) {
      if (SEVERITY_RANK[finding.severity] <= threshold) blocking.push({ path: diagram.path, finding });
    }
  }
  const unreadable = diagrams.some((d) => d.errors);
  return { diagrams, blocking, failed: unreadable || blocking.length > 0 };
}
function checkOne(input, options) {
  const head = parseDiagram(input.head);
  if (!head.ok) {
    return {
      path: input.path,
      errors: head.errors,
      nodes: 0,
      edges: 0,
      score: 0,
      findings: [],
      introduced: [],
      resolved: [],
      compared: false
    };
  }
  const disabled = options.disabledRuleIds ?? [];
  const report = validate(head.graph, { intent: head.intent, disabledRuleIds: disabled });
  const findings = report.findings.map((finding) => locate(finding, head.graph, input.head));
  let baseFindings = null;
  if (input.base === null) baseFindings = [];
  else if (input.base !== void 0) {
    const base = parseDiagram(input.base);
    baseFindings = base.ok ? validate(base.graph, { intent: base.intent, disabledRuleIds: disabled }).findings : [];
  }
  const compared = baseFindings !== null;
  const baseKeys = new Set((baseFindings ?? []).map(findingKey2));
  const headKeys = new Set(findings.map(findingKey2));
  return {
    path: input.path,
    nodes: head.graph.nodes.length,
    edges: head.graph.edges.length,
    score: report.score,
    findings,
    introduced: compared ? findings.filter((f) => !baseKeys.has(findingKey2(f))) : [],
    resolved: (baseFindings ?? []).filter((f) => !headKeys.has(findingKey2(f))),
    compared
  };
}
function locate(finding, graph, text) {
  const id = finding.edgeIds[0] ?? finding.nodeIds[0];
  if (id === void 0) return finding;
  const exists = graph.nodes.some((n) => n.id === id) || graph.edges.some((e) => e.id === id);
  if (!exists) return finding;
  const pattern = new RegExp(`"id"\\s*:\\s*${escapeRegExp(JSON.stringify(id))}`);
  const lines = text.split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  return index === -1 ? finding : { ...finding, line: index + 1 };
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/markdown.ts
var COMMENT_MARKER = "<!-- keel-architecture-check -->";
var ICON = { error: "\u{1F534}", warning: "\u{1F7E0}", info: "\u{1F535}" };
var MAX_BODY = 6e4;
function renderReport(report, options) {
  const lines = [COMMENT_MARKER, "## Keel architecture check", ""];
  lines.push(headline(report, options), "");
  for (const diagram of report.diagrams) lines.push(...renderDiagram(diagram), "");
  lines.push(
    `<sub>${policy(options)} \xB7 Findings come from Keel's deterministic rules, the same ones the canvas runs.</sub>`
  );
  const body = lines.join("\n");
  return body.length <= MAX_BODY ? body : `${body.slice(0, MAX_BODY)}

\u2026report truncated. See the job summary.`;
}
function headline(report, options) {
  if (report.diagrams.length === 0) return "No diagram files matched.";
  const unreadable = report.diagrams.filter((d) => d.errors).length;
  if (unreadable > 0) return `**${unreadable} diagram file${unreadable === 1 ? "" : "s"} could not be read.**`;
  const introduced = report.diagrams.reduce((n, d) => n + d.introduced.length, 0);
  const resolved = report.diagrams.reduce((n, d) => n + d.resolved.length, 0);
  const compared = report.diagrams.some((d) => d.compared);
  const parts = [];
  if (report.failed) parts.push(`**Blocking: ${report.blocking.length} ${plural(report.blocking.length, "finding")}**`);
  if (compared) {
    parts.push(
      introduced === 0 ? "This change introduces no new findings." : `This change introduces ${introduced} ${plural(introduced, "finding")}.`
    );
    if (resolved > 0) parts.push(`It resolves ${resolved}.`);
  } else {
    const total = report.diagrams.reduce((n, d) => n + d.findings.length, 0);
    parts.push(`${total} ${plural(total, "finding")} (no base revision to compare against).`);
  }
  if (!report.failed && options.failOn !== "never" && introduced + resolved === 0 && compared) parts.push("\u2705");
  return parts.join(" ");
}
function renderDiagram(diagram) {
  const lines = [`### \`${diagram.path}\``];
  if (diagram.errors) {
    lines.push("", ...diagram.errors.map((e) => `- ${e}`));
    return lines;
  }
  lines.push(
    "",
    `${diagram.nodes} ${plural(diagram.nodes, "component")}, ${diagram.edges} ${plural(diagram.edges, "dependency", "dependencies")} \xB7 score ${diagram.score}/100`
  );
  if (diagram.compared) {
    if (diagram.introduced.length > 0) lines.push("", "**New in this change**", "", ...table(diagram.introduced));
    if (diagram.resolved.length > 0) {
      lines.push("", "**Resolved**", "", ...diagram.resolved.map((f) => `- ~~${escape(f.title)}~~`));
    }
    const existing = diagram.findings.length - diagram.introduced.length;
    if (existing > 0) {
      const carried = diagram.findings.filter((f) => !diagram.introduced.includes(f));
      lines.push("", `<details><summary>${existing} existing ${plural(existing, "finding")}</summary>`, "", ...table(carried), "", "</details>");
    }
    if (diagram.findings.length === 0) lines.push("", "No findings.");
  } else if (diagram.findings.length > 0) {
    lines.push("", ...table(diagram.findings));
  } else {
    lines.push("", "No findings.");
  }
  return lines;
}
function table(findings) {
  return [
    "| | Finding | Rule |",
    "|---|---|---|",
    ...findings.map((f) => `| ${ICON[f.severity]} | **${escape(f.title)}**<br>${escape(f.detail)} | \`${f.ruleId}\` |`)
  ];
}
function policy(options) {
  if (options.failOn === "never") return "Reporting only (fail-on: never)";
  const scope = options.failScope === "new" ? "new" : "any";
  return `Fails on ${scope} ${options.failOn === "info" ? "finding" : `${options.failOn}-or-worse finding`}`;
}
function plural(n, one, many = `${one}s`) {
  return n === 1 ? one : many;
}
function escape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// src/github.ts
async function upsertComment(context, body) {
  const call = context.fetch ?? fetch;
  const base = `${context.apiUrl}/repos/${context.owner}/${context.repo}/issues/${context.issueNumber}/comments`;
  const headers = {
    authorization: `Bearer ${context.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json"
  };
  const existing = await findOwnComment(call, base, headers);
  const response = existing ? await call(`${context.apiUrl}/repos/${context.owner}/${context.repo}/issues/comments/${existing.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ body })
  }) : await call(base, { method: "POST", headers, body: JSON.stringify({ body }) });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return existing ? "updated" : "created";
}
async function findOwnComment(call, base, headers) {
  for (let page = 1; page <= 10; page += 1) {
    const response = await call(`${base}?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    const comments = await response.json();
    const mine = comments.find((c) => c.body?.startsWith(COMMENT_MARKER));
    if (mine) return mine;
    if (comments.length < 100) return null;
  }
  return null;
}

// src/run.ts
async function run(deps) {
  const { env, log } = deps;
  const input = (name, fallback = "") => (env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim() || fallback;
  const options = {
    failOn: parseChoice(input("fail-on", "never"), ["error", "warning", "info", "never"], "fail-on"),
    failScope: parseChoice(input("fail-scope", "new"), ["new", "all"], "fail-scope"),
    disabledRuleIds: splitList(input("disabled-rules"))
  };
  const workspace2 = env["GITHUB_WORKSPACE"] ?? process.cwd();
  const patterns = splitList(input("diagrams", "**/*.keel.json"));
  const files = [
    ...new Set(
      patterns.flatMap(
        (pattern) => (0, import_node_fs.globSync)(pattern, { cwd: workspace2, exclude: (name) => name === "node_modules" || name === ".git" })
      )
    )
  ].sort();
  const event = readEvent(env["GITHUB_EVENT_PATH"]);
  const baseSha = event?.pull_request?.base?.sha;
  const inputs = files.map((file) => ({
    path: file.split(import_node_path.default.sep).join("/"),
    head: (0, import_node_fs.readFileSync)(import_node_path.default.join(workspace2, file), "utf8"),
    ...baseSha ? { base: deps.readAtRevision(baseSha, file) } : {}
  }));
  const report = checkDiagrams(inputs, options);
  const markdown = renderReport(report, options);
  for (const diagram of report.diagrams) {
    for (const error of diagram.errors ?? []) log(annotation("error", diagram.path, void 0, "Keel: unreadable diagram", error));
    const pool = diagram.compared ? diagram.introduced : diagram.findings;
    for (const finding of pool) {
      log(annotation(finding.severity === "info" ? "notice" : finding.severity, diagram.path, finding.line, `Keel: ${finding.title}`, finding.detail));
    }
  }
  if (env["GITHUB_STEP_SUMMARY"]) (0, import_node_fs.appendFileSync)(env["GITHUB_STEP_SUMMARY"], `${markdown}
`);
  if (env["GITHUB_OUTPUT"]) {
    const count = (predicate) => report.diagrams.reduce((n, d) => n + predicate(d), 0);
    (0, import_node_fs.appendFileSync)(
      env["GITHUB_OUTPUT"],
      [
        `findings=${count((d) => d.findings.length)}`,
        `introduced=${count((d) => d.introduced.length)}`,
        `resolved=${count((d) => d.resolved.length)}`,
        `blocking=${report.blocking.length}`,
        ""
      ].join("\n")
    );
  }
  const prNumber = event?.pull_request?.number;
  const wantsComment = input("comment", "true") !== "false";
  const token = input("github-token");
  const repository = env["GITHUB_REPOSITORY"];
  if (wantsComment && prNumber && token && repository && files.length > 0) {
    const [owner = "", repo = ""] = repository.split("/");
    const context = {
      apiUrl: env["GITHUB_API_URL"] ?? "https://api.github.com",
      token,
      owner,
      repo,
      issueNumber: prNumber,
      ...deps.fetch ? { fetch: deps.fetch } : {}
    };
    try {
      log(`Keel report comment ${await upsertComment(context, markdown)}.`);
    } catch (error) {
      log(`::warning::Could not post the report comment (${error instanceof Error ? error.message : String(error)}). Grant "pull-requests: write" to enable it.`);
    }
  }
  if (files.length === 0) log(`::warning::No diagram files matched ${patterns.join(", ")}.`);
  return { report, exitCode: report.failed ? 1 : 0 };
}
function gitReadAtRevision(cwd) {
  const git = (args) => (0, import_node_child_process.execFileSync)("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  const known = /* @__PURE__ */ new Map();
  return (revision, file) => {
    if (!known.has(revision)) {
      let present = tryGit(() => git(["cat-file", "-e", `${revision}^{commit}`])) !== void 0;
      if (!present) present = tryGit(() => git(["fetch", "--no-tags", "--depth=1", "origin", revision])) !== void 0;
      known.set(revision, present);
    }
    if (!known.get(revision)) return void 0;
    return tryGit(() => git(["show", `${revision}:${file.split(import_node_path.default.sep).join("/")}`])) ?? null;
  };
}
function tryGit(fn) {
  try {
    return fn();
  } catch {
    return void 0;
  }
}
function readEvent(eventPath) {
  if (!eventPath) return null;
  try {
    return JSON.parse((0, import_node_fs.readFileSync)(eventPath, "utf8"));
  } catch {
    return null;
  }
}
function parseChoice(value, choices, name) {
  if (!choices.includes(value)) throw new Error(`Input "${name}" must be one of ${choices.join(", ")}; got "${value}".`);
  return value;
}
function splitList(value) {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}
function annotation(level, file, line, title, message) {
  const prop = (v) => v.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
  const data = (v) => v.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const props = [`file=${prop(file)}`, ...line ? [`line=${line}`] : [], `title=${prop(title)}`].join(",");
  return `::${level} ${props}::${data(message)}`;
}

// src/main.ts
var workspace = process.env["GITHUB_WORKSPACE"] ?? process.cwd();
run({ env: process.env, readAtRevision: gitReadAtRevision(workspace), log: (line) => console.log(line) }).then(({ exitCode }) => {
  process.exitCode = exitCode;
}).catch((error) => {
  console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
