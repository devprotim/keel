import type { EdgeKind, Health, NodeKind, Severity } from '@keel/shared';
import type { Role } from '../access/access.service';

/**
 * Display names for the domain's identifiers.
 *
 * The keys are stored values (in the room doc, on the server, in CSS classes)
 * and never change with the language; only what a person reads does. In
 * English each label is the identifier itself, so English output is unchanged.
 */

export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  service: $localize`:Component kind:service`,
  datastore: $localize`:Component kind:datastore`,
  queue: $localize`:Component kind:queue`,
  cache: $localize`:Component kind:cache`,
  gateway: $localize`:Component kind:gateway`,
  job: $localize`:Component kind:job`,
  external: $localize`:Component kind:external`,
};

export const EDGE_KIND_LABELS: Record<EdgeKind, string> = {
  sync: $localize`:Call style:sync`,
  async: $localize`:Call style:async`,
  stream: $localize`:Call style:stream`,
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  error: $localize`:Finding severity:error`,
  warning: $localize`:Finding severity:warning`,
  info: $localize`:Finding severity:info`,
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: $localize`:Workspace role:owner`,
  editor: $localize`:Workspace role:editor`,
  viewer: $localize`:Workspace role:viewer`,
};

export const HEALTH_LABELS: Record<Health, string> = {
  down: $localize`:Health state of a component or call:down`,
  degraded: $localize`:Health state of a component or call:degraded`,
  healthy: $localize`:Health state of a component or call:healthy`,
  unknown: $localize`:Health state of a component or call:unknown`,
};
