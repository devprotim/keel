import {
  DOC_MAPS,
  diffObservationSets,
  eventsToDrop,
  readEdge,
  readElementIntent,
  readFindingLabel,
  readNode,
  readObservationSet,
  readRuleSetting,
  type ArchEdge,
  type ArchGraph,
  type ArchNode,
  type DesignIntent,
  type FindingLabels,
  type ObservationSet,
  type RuleSettings,
} from '@keel/shared';
import * as Y from 'yjs';

export interface RoomContents {
  graph: ArchGraph;
  observations: ObservationSet[];
  intent: DesignIntent;
  /** The room's tuning, so alerts respect the same mutes and dismissals the canvas does. */
  ruleSettings: RuleSettings;
  labels: FindingLabels;
}

/**
 * A room document as domain values, read exactly as the client reads it (the
 * readers are shared), so the server validating a room nobody has open sees
 * the same diagram the canvas would.
 */
export function readRoom(doc: Y.Doc): RoomContents {
  const nodes: ArchNode[] = [];
  for (const value of doc.getMap(DOC_MAPS.nodes).values()) {
    const node = readNode(value);
    if (node) nodes.push(node);
  }
  const edges: ArchEdge[] = [];
  for (const value of doc.getMap(DOC_MAPS.edges).values()) {
    const edge = readEdge(value);
    if (edge) edges.push(edge);
  }
  const observations: ObservationSet[] = [];
  for (const value of doc.getMap(DOC_MAPS.observations).values()) {
    const set = readObservationSet(value);
    if (set) observations.push(set);
  }
  const intent: DesignIntent = {};
  for (const [id, value] of doc.getMap(DOC_MAPS.intent).entries()) {
    const element = value instanceof Y.Map ? readElementIntent(value) : null;
    if (element) intent[id] = element;
  }

  const ruleSettings: RuleSettings = {};
  for (const [id, value] of doc.getMap(DOC_MAPS.ruleSettings).entries()) {
    const setting = readRuleSetting(value);
    if (setting) ruleSettings[id] = setting;
  }
  const labels: FindingLabels = {};
  for (const [key, value] of doc.getMap(DOC_MAPS.labels).entries()) {
    const label = readFindingLabel(value);
    if (label) labels[key] = label;
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));
  observations.sort((a, b) => a.source.localeCompare(b.source));
  return { graph: { nodes, edges }, observations, intent, ruleSettings, labels };
}

/**
 * Replace one source's observations, and log what the push changed.
 *
 * A set is replaced wholesale, so without the log the previous state would be
 * gone, and with it the answer to the first question in an incident: what
 * changed? One transaction, so peers see the new set and its events together.
 */
export function recordObservations(doc: Y.Doc, set: ObservationSet, now = Date.now()): void {
  doc.transact(() => {
    const sets = doc.getMap(DOC_MAPS.observations);
    const events = diffObservationSets(readObservationSet(sets.get(set.source)), set);
    sets.set(set.source, set);

    const log = doc.getArray<unknown>(DOC_MAPS.events);
    if (events.length > 0) log.push(events);
    const drop = eventsToDrop(log.toArray(), now);
    if (drop > 0) log.delete(0, drop);
  });
}
