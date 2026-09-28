import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';
import { AlertConfigSchema, maskedConfig, type AlertConfig } from './config.ts';
import type { Send } from './notifiers.ts';
import type { AlertStore, Channel } from './store.ts';
import type { AlertWorker } from './worker.ts';

export interface AlertRouteDeps {
  store: AlertStore;
  worker: AlertWorker;
  send: Send;
  parseRoomId: (raw: unknown) => string | null;
  roomUrl: (roomId: string) => string;
  limit: RouteShorthandOptions;
}

/**
 * A PUT body: any subset of the config. A channel given without its secret
 * keeps the stored one, because GET only ever returns it masked and the client
 * cannot send back what it never received. `null` removes a channel.
 */
const PatchSchema = z.object({
  slack: z.object({ webhookUrl: z.string().optional(), minSeverity: z.string().optional() }).nullable().optional(),
  pagerduty: z.object({ routingKey: z.string().optional(), minSeverity: z.string().optional() }).nullable().optional(),
  checks: z.array(z.string()).optional(),
  resolveAfterMinutes: z.number().optional(),
});

/**
 * `/api/rooms/:roomId/alerts`. Same access model as the rest of the room: the
 * room id is the capability. Anyone who can edit the diagram can change where
 * its alerts go, and can never read back the credentials already stored.
 */
export function registerAlertRoutes(app: FastifyInstance, deps: AlertRouteDeps): void {
  const { store, worker } = deps;

  const room = (params: unknown) => deps.parseRoomId((params as { roomId?: unknown }).roomId);

  app.get('/api/rooms/:roomId/alerts', deps.limit, async (request, reply) => {
    const roomId = room(request.params);
    if (!roomId) return reply.status(400).send({ error: 'invalid room id' });
    const config = await store.getConfig(roomId);
    const state = config ? await store.getState(roomId) : {};
    return {
      config: config ? maskedConfig(config) : null,
      open: Object.values(state).map((alert) => ({
        ruleId: alert.ruleId,
        severity: alert.severity,
        title: alert.title,
        since: alert.firstSeenAt,
        delivered: alert.delivered,
      })),
    };
  });

  app.put('/api/rooms/:roomId/alerts', deps.limit, async (request, reply) => {
    const roomId = room(request.params);
    if (!roomId) return reply.status(400).send({ error: 'invalid room id' });

    const patch = PatchSchema.safeParse(request.body);
    if (!patch.success) return reply.status(400).send({ error: 'invalid alert config', issues: patch.error.issues });

    const existing = await store.getConfig(roomId);
    const merged = merge(existing, patch.data);
    const parsed = AlertConfigSchema.safeParse(merged);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid alert config', issues: parsed.error.issues });

    await store.putConfig(roomId, parsed.data);
    // Evaluate straight away, so what is already wrong is announced now rather
    // than at the next push or sweep.
    worker.notify(roomId);
    return { config: maskedConfig(parsed.data) };
  });

  app.delete('/api/rooms/:roomId/alerts', deps.limit, async (request, reply) => {
    const roomId = room(request.params);
    if (!roomId) return reply.status(400).send({ error: 'invalid room id' });
    await store.deleteConfig(roomId);
    return reply.status(204).send();
  });

  /**
   * Send a test notification to each configured channel. For PagerDuty that
   * is a trigger followed at once by its resolve; depending on the service's
   * rules it may still page briefly, which is the point of testing it.
   */
  app.post('/api/rooms/:roomId/alerts/test', deps.limit, async (request, reply) => {
    const roomId = room(request.params);
    if (!roomId) return reply.status(400).send({ error: 'invalid room id' });
    const config = await store.getConfig(roomId);
    if (!config) return reply.status(404).send({ error: 'no alerting configured for this room' });

    const now = new Date().toISOString();
    const alert = {
      ruleId: 'test',
      severity: 'info' as const,
      title: 'Test alert from Keel',
      detail: 'Alerting for this diagram is connected. No action needed.',
      nodeIds: [],
      edgeIds: [],
      firstSeenAt: now,
      lastSeenAt: now,
      delivered: [],
    };
    const event = { dedupKey: `keel-test-${Date.now()}`, alert, roomUrl: deps.roomUrl(roomId) };

    const results: Partial<Record<Channel, { ok: boolean; error?: string }>> = {};
    for (const channel of ['slack', 'pagerduty'] as const) {
      if (!config[channel]) continue;
      try {
        await deps.send(channel, config, { ...event, action: 'trigger' });
        if (channel === 'pagerduty') await deps.send(channel, config, { ...event, action: 'resolve' });
        results[channel] = { ok: true };
      } catch (error) {
        results[channel] = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { results };
  });
}

function merge(existing: AlertConfig | null, patch: z.infer<typeof PatchSchema>): unknown {
  const channel = <K extends 'slack' | 'pagerduty'>(key: K) => {
    const incoming = patch[key];
    if (incoming === null) return undefined;
    if (incoming === undefined) return existing?.[key];
    return { ...existing?.[key], ...stripUndefined(incoming) };
  };
  return {
    ...existing,
    ...stripUndefined({ checks: patch.checks, resolveAfterMinutes: patch.resolveAfterMinutes }),
    slack: channel('slack'),
    pagerduty: channel('pagerduty'),
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
