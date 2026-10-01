import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { validate } from '@keel/shared';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AnthropicReviewProvider } from './ai/anthropic-provider.ts';
import { GeminiReviewProvider } from './ai/gemini-provider.ts';
import type { ReviewProvider } from './ai/provider.ts';
import { ArchitectureReviewer } from './ai/review.ts';
import { CLOSE_DELETED, CLOSE_FORBIDDEN, CLOSE_NOT_FOUND, roomAccess } from './access/policy.ts';
import { registerAccessRoutes } from './access/routes.ts';
import { MemoryAccessStore, type AccessStore } from './access/store.ts';
import { createSender, type Send } from './alerts/notifiers.ts';
import { registerAlertRoutes } from './alerts/routes.ts';
import { MemoryAlertStore, type AlertStore } from './alerts/store.ts';
import { AlertWorker } from './alerts/worker.ts';
import { registerAuth } from './auth/routes.ts';
import { registerBillingRoutes } from './billing/routes.ts';
import { BillingService } from './billing/service.ts';
import { overLimit } from './billing/plans.ts';
import { MemoryBillingStore, type BillingStore } from './billing/store.ts';
import { StripeRestApi, type StripeApi } from './billing/stripe.ts';
import { TokenBucket } from './collab/rate-limit.ts';
import { RoomManager } from './collab/room-manager.ts';
import { recordObservations } from './collab/room-reader.ts';
import type { Room, Socket } from './collab/room.ts';
import type { Config } from './config.ts';
import type { DocStore } from './store/store.ts';

/**
 * Room ids appear in URLs and are used as storage keys, so they are constrained
 * rather than accepted as free text. This is the boundary where a path traversal
 * or an oversized key would otherwise get in.
 */
const RoomIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'room id may contain only letters, numbers, hyphens and underscores');

/**
 * Element ids match the intent baseline's key bound, so anything that can be
 * validated can also be approved.
 */
const ElementIdSchema = z.string().min(1).max(64);
const Coordinate = z.number().finite().min(-1e6).max(1e6);
const Extent = z.number().finite().nonnegative().max(1e5);

const ArchNodeSchema = z.object({
  id: ElementIdSchema,
  kind: z.enum(['service', 'datastore', 'queue', 'cache', 'gateway', 'job', 'external']),
  label: z.string().max(200),
  x: Coordinate,
  y: Coordinate,
  w: Extent,
  h: Extent,
  replicas: z.number().int().nonnegative().max(100_000),
  tech: z.string().max(200).optional(),
  notes: z.string().max(4000).optional(),
  critical: z.boolean().optional(),
  hasReplica: z.boolean().optional(),
  hasBackup: z.boolean().optional(),
  hasDlq: z.boolean().optional(),
  ref: z.string().max(200).optional(),
});

const ArchEdgeSchema = z.object({
  id: ElementIdSchema,
  source: ElementIdSchema,
  target: ElementIdSchema,
  kind: z.enum(['sync', 'async', 'stream']),
  label: z.string().max(200).optional(),
  timeoutMs: z.number().finite().nonnegative().max(86_400_000).optional(),
  retries: z.number().int().nonnegative().max(100).optional(),
  circuitBreaker: z.boolean().optional(),
  idempotent: z.boolean().optional(),
});

/**
 * Bounded on purpose. The review endpoint forwards this to a paid API, so an
 * unbounded graph is an unbounded bill as well as an unbounded prompt.
 */
const ArchGraphSchema = z.object({
  nodes: z.array(ArchNodeSchema).max(500),
  edges: z.array(ArchEdgeSchema).max(1500),
});

const RefSchema = z.string().min(1).max(200);
const Rate = z.number().nonnegative().finite();

/**
 * What a running system reports about itself.
 *
 * Bounded the same way as the graph: this is written into a shared document
 * that every collaborator downloads, so an unbounded payload is an unbounded
 * room.
 */
const ObservationSetSchema = z.object({
  source: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_.:-]+$/, 'source may contain only letters, numbers and _ . : -'),
  observedAt: z.iso.datetime({ offset: true }),
  nodes: z
    .array(
      z.object({
        ref: RefSchema,
        replicas: z.number().int().nonnegative().max(100_000).optional(),
        hasReplica: z.boolean().optional(),
        hasBackup: z.boolean().optional(),
        hasDlq: z.boolean().optional(),
        rps: Rate.optional(),
        errorRate: z.number().min(0).max(1).optional(),
      }),
    )
    .max(500)
    .optional(),
  edges: z
    .array(
      z.object({
        source: RefSchema,
        target: RefSchema,
        timeoutMs: z.number().nonnegative().finite().max(86_400_000).nullable().optional(),
        retries: z.number().int().nonnegative().max(100).optional(),
        circuitBreaker: z.boolean().optional(),
        p99Ms: z.number().nonnegative().finite().optional(),
        rps: Rate.optional(),
        errorRate: z.number().min(0).max(1).optional(),
      }),
    )
    .max(1500)
    .optional(),
});

const FieldValueSchema = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]);

const IntentSchema = z
  .record(
    z.string().max(64),
    z.object({
      kind: z.enum(['node', 'edge']),
      label: z.string().max(200),
      fields: z.record(
        z.string().max(32),
        z.object({
          value: FieldValueSchema,
          previous: FieldValueSchema.optional(),
          by: z.string().max(200),
          at: z.string().max(64),
        }),
      ),
    }),
  )
  .refine((intent) => Object.keys(intent).length <= 2000, 'too many approved elements');

/**
 * A plain graph, optionally with evidence and a baseline. A bare graph is
 * still valid, so existing callers of /api/validate keep working.
 */
const ValidateRequestSchema = ArchGraphSchema.extend({
  observations: z.array(ObservationSetSchema).max(20).optional(),
  intent: IntentSchema.optional(),
});

export interface AppDeps {
  config: Config;
  store: DocStore;
  /** Overrides the provider chosen from config. Tests pass a stub; null disables review. */
  reviewProvider?: ReviewProvider | null;
  /** Alert configuration and open alerts. Defaults to memory, like the doc store. */
  alertStore?: AlertStore;
  /** Delivers alert events. Tests pass a recorder instead of calling Slack and PagerDuty. */
  alertSend?: Send;
  /** Workspaces, membership and tokens. Defaults to memory. */
  accessStore?: AccessStore;
  /** Which plan each workspace is on. Defaults to memory. */
  billingStore?: BillingStore;
  /** Overrides the Stripe client built from config. Tests pass a fake. */
  stripeApi?: StripeApi;
}

export async function buildApp({
  config,
  store,
  reviewProvider,
  alertStore,
  alertSend,
  accessStore,
  billingStore,
  stripeApi,
}: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // Behind a proxy, request.ip is the proxy unless this is on, and every
    // client would share one rate-limit bucket.
    trustProxy: config.TRUST_PROXY,
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: 'info',
            // Room ids are bearer capabilities: anyone holding one can edit the
            // room. They stay out of logs, which outlive the rooms and are read
            // by more people than the rooms are.
            serializers: {
              req: (request: { method: string; url: string; ip?: string }) => ({
                method: request.method,
                url: redactRoomIds(request.url),
                remoteAddress: request.ip,
              }),
            },
          },
  });

  const rooms = new RoomManager(store, {
    persistDebounceMs: config.PERSIST_DEBOUNCE_MS,
    compactAfterUpdates: config.COMPACT_AFTER_UPDATES,
    maxBytes: config.ROOM_MAX_BYTES,
    idleMs: config.ROOM_IDLE_MS,
  });

  // Absent keys disable review rather than failing at boot. The canvas is the
  // product; the reviewer is an enhancement and must not gate startup.
  const provider = reviewProvider === undefined ? selectProvider(config) : reviewProvider;
  const reviewer = provider ? new ArchitectureReviewer({ provider }) : null;

  // credentials: true so the session cookie rides cross-origin in dev, where
  // the Angular dev server (:4200) and this API (:8787) are different origins.
  await app.register(cors, { origin: [...config.corsOrigins], credentials: true });
  await app.register(websocket, { options: { maxPayload: config.WS_MAX_MESSAGE_BYTES } });
  // Opt-in per route, keyed on client address. Static assets and the socket
  // upgrade are not limited here; the socket has its own per-message budget.
  await app.register(rateLimit, { global: false });
  const perMinute = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  // CSP is scoped to this app's actual external dependencies: Google Fonts +
  // Fontshare for the type system (DESIGN.md), and GitHub/Google's avatar CDNs
  // for signed-in identity (auth/providers.ts). Angular's emulated view
  // encapsulation injects <style> tags per component, and the client's
  // [style.x] bindings set inline style attributes, so styleSrc needs
  // 'unsafe-inline' - there is no nonce wired through Angular's build here.
  //
  // scriptSrcAttr must allow inline handlers: `ng build` runs Critters, which
  // inlines critical CSS and defers the main stylesheet as
  // `media="print" onload="this.media='all'"`. Blocking that attribute leaves
  // the stylesheet print-only forever, so the production app renders with
  // browser-default styling while every file still loads and parses fine.
  // scriptSrc itself stays 'self', so this permits handler attributes only,
  // not inline <script>.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'api.fontshare.com'],
        fontSrc: ["'self'", 'fonts.gstatic.com', 'cdn.fontshare.com'],
        imgSrc: ["'self'", 'data:', 'avatars.githubusercontent.com', 'lh3.googleusercontent.com'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        frameAncestors: ["'none'"],
      },
    },
  });

  const access = accessStore ?? new MemoryAccessStore();
  // Remembered so member lists can name people who are not online. At most
  // once per user per ten minutes per process: /api/auth/me runs on every load.
  const recorded = new Map<string, number>();
  const auth = await registerAuth(app, config, {
    onSeen: async (user) => {
      const last = recorded.get(user.id);
      if (last !== undefined && Date.now() - last < 10 * 60_000) return;
      recorded.set(user.id, Date.now());
      await access.upsertUser({ id: user.id, name: user.name, avatarUrl: user.avatarUrl });
    },
  });
  const parseRoomId = (raw: unknown): string | null => {
    const parsed = RoomIdSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  };
  /** What the caller may do in a room, from their session. */
  const accessFor = async (request: FastifyRequest, roomId: string) =>
    roomAccess(access, roomId, (await auth.readUser(request))?.id ?? null);
  /** A room that was never made through `POST /api/rooms`, so a typed URL opens nothing. */
  const isMissing = async (roomId: string) => !(await store.exists(roomId));

  const billing = new BillingService({
    store: billingStore ?? new MemoryBillingStore(),
    access,
    stripe: stripeApi ?? (config.STRIPE_SECRET_KEY ? new StripeRestApi(config.STRIPE_SECRET_KEY, fetch, config.STRIPE_API_URL) : null),
    config: {
      prices: {
        ...(config.STRIPE_PRICE_TEAM ? { team: config.STRIPE_PRICE_TEAM } : {}),
        ...(config.STRIPE_PRICE_BUSINESS ? { business: config.STRIPE_PRICE_BUSINESS } : {}),
      },
      perSeat: config.BILLING_PER_SEAT,
    },
  });
  registerBillingRoutes(app, {
    billing,
    access,
    readUser: (request) => auth.readUser(request),
    webhookSecret: config.STRIPE_WEBHOOK_SECRET ?? null,
    publicUrl: config.PUBLIC_URL,
    limit: perMinute(config.RATE_LIMIT_ACCESS_PER_MIN),
    log: app.log,
  });

  registerAccessRoutes(app, {
    store: access,
    limits: (workspaceId) => billing.limitsFor(workspaceId),
    onMembersChanged: (workspaceId) => {
      billing.syncSeats(workspaceId).catch((error: unknown) => app.log.warn({ err: error }, 'seat sync failed'));
    },
    readUser: (request) => auth.readUser(request),
    parseRoomId,
    disconnect: async (roomIds, code, reason) => {
      await Promise.all(roomIds.map((roomId) => rooms.disconnect(roomId, code, reason)));
    },
    deleteRoom: async (roomId) => {
      await rooms.purge(roomId, CLOSE_DELETED, 'deleted');
      // Cascades in Postgres; the memory stores need telling.
      await store.delete(roomId);
      await alerts.deleteConfig(roomId);
      await access.releaseRoom(roomId);
    },
    isDeleted: (roomId) => store.isDeleted(roomId),
    isMissing,
    publicUrl: config.PUBLIC_URL,
    inviteTtlMs: config.INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
    limit: perMinute(config.RATE_LIMIT_ACCESS_PER_MIN),
    readLimit: perMinute(config.RATE_LIMIT_ACCESS_READ_PER_MIN),
  });

  const alerts = alertStore ?? new MemoryAlertStore();
  const send = alertSend ?? createSender();
  const roomUrl = (roomId: string) => `${new URL(config.PUBLIC_URL).origin}/${roomId}`;
  const alertWorker = new AlertWorker({
    store: alerts,
    rooms,
    send,
    log: app.log,
    roomUrl,
    roomTag,
    sweepIntervalMs: config.ALERT_SWEEP_SECONDS * 1000,
    debounceMs: config.ALERT_DEBOUNCE_MS,
  });
  alertWorker.start();
  registerAlertRoutes(app, {
    store: alerts,
    worker: alertWorker,
    send,
    roomUrl,
    parseRoomId,
    authorize: async (request, roomId, need) => {
      if (await isMissing(roomId)) return false;
      const granted = await accessFor(request, roomId);
      return need === 'edit' ? granted.canEdit : granted.canView;
    },
    pagerDutyAllowed: async (roomId) => {
      const { plan, limits } = await billing.limitsForRoom(roomId);
      return limits.pagerDuty ? null : overLimit(plan, 'pagerDuty');
    },
    limit: perMinute(config.RATE_LIMIT_ALERTS_PER_MIN),
  });

  app.get('/health', async () => ({
    status: 'ok',
    rooms: rooms.residentCount,
    store: store.kind,
    review: reviewer ? 'enabled' : 'disabled',
    reviewProvider: reviewer?.providerName ?? null,
    oauth: { github: auth.github ? 'enabled' : 'disabled', google: auth.google ? 'enabled' : 'disabled' },
  }));

  // Disabled: leaked every room id with no auth check, defeating the
  // "room id is the shared secret" access model. Unused by the client.
  // app.get('/api/diagrams', async () => ({ diagrams: await store.list() }));

  /**
   * Deterministic validation over HTTP.
   *
   * The client runs the identical rule engine locally for instant feedback, so
   * this endpoint exists for callers that are not the canvas: CI checks, scripts,
   * and anything that wants a trustworthy answer rather than a convenient one.
   */
  app.post('/api/validate', perMinute(config.RATE_LIMIT_VALIDATE_PER_MIN), async (request, reply) => {
    const parsed = ValidateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid graph', issues: parsed.error.issues });
    }
    const { observations, intent, ...graph } = parsed.data;
    return validate(graph, {
      ...(observations ? { observations } : {}),
      ...(intent ? { intent } : {}),
    });
  });

  /**
   * Make a new room. The server picks the id, so every room id is random and
   * nobody can create (or land in) `/foo` by typing it. Registered at once,
   * so the room opens before anyone has drawn in it.
   */
  app.post('/api/rooms', perMinute(config.RATE_LIMIT_ACCESS_PER_MIN), async (_request, reply) => {
    // 48 random bits, the same shape the client used to mint (docs/security-audit.md).
    const roomId = randomUUID().replace(/-/g, '').slice(0, 12);
    await store.create(roomId);
    return reply.status(201).send({ roomId });
  });

  /**
   * Push what the running system reports into a room.
   *
   * This is what keeps a diagram honest after the day it was drawn: a CI job, a
   * cron, or a cluster controller posts one set per source, and every open
   * canvas re-validates against it live. Each push replaces that source's
   * previous set rather than accumulating, so a source that stops reporting a
   * component stops vouching for it.
   *
   * Same access model as the socket: the room id is the capability. Anyone who
   * can open the room can already edit every number in it by hand.
   */
  app.post('/api/rooms/:roomId/observations', perMinute(config.RATE_LIMIT_OBSERVATIONS_PER_MIN), async (request, reply) => {
    const roomId = RoomIdSchema.safeParse((request.params as { roomId?: string }).roomId);
    if (!roomId.success) return reply.status(400).send({ error: 'invalid room id' });

    if (await store.isDeleted(roomId.data)) return reply.status(410).send({ error: 'this room was deleted' });
    if (await isMissing(roomId.data)) return reply.status(404).send({ error: 'no such room' });

    // A private room takes observations only from a token issued for it (a
    // collector), or from a member who could edit the numbers by hand anyway.
    const placed = await accessFor(request, roomId.data);
    if (placed.visibility === 'workspace' && !placed.canEdit) {
      const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
      if (!bearer) return reply.status(401).send({ error: 'this room is private: send an ingest token as a Bearer token' });
      if (!(await access.useIngestToken(roomId.data, bearer))) return reply.status(403).send({ error: 'invalid ingest token' });
    }

    const parsed = ObservationSetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid observations', issues: parsed.error.issues });
    }

    await rooms.mutate(roomId.data, (doc) => recordObservations(doc, parsed.data));
    alertWorker.notify(roomId.data);

    return reply.status(202).send({
      accepted: {
        source: parsed.data.source,
        observedAt: parsed.data.observedAt,
        nodes: parsed.data.nodes?.length ?? 0,
        edges: parsed.data.edges?.length ?? 0,
      },
    });
  });

  /** Models the configured provider can serve, for the client's picker. */
  app.get('/api/review/models', async (_request, reply) => {
    if (!reviewer) return reply.status(503).send({ error: 'review is not configured' });

    return {
      provider: reviewer.providerName,
      defaultModel: reviewer.defaultModel,
      models: await allowedModels(reviewer, config),
    };
  });

  app.post('/api/review', perMinute(config.RATE_LIMIT_REVIEW_PER_MIN), async (request, reply) => {
    if (!reviewer) {
      return reply.status(503).send({
        error: 'review is not configured',
        detail: 'Set ANTHROPIC_API_KEY or GEMINI_API_KEY to enable architecture review.',
      });
    }

    const parsed = ArchGraphSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid graph', issues: parsed.error.issues });
    }

    const graph = parsed.data;
    if (graph.nodes.length === 0) {
      return reply.status(400).send({ error: 'nothing to review', detail: 'The diagram is empty.' });
    }

    // Model comes from the query string so the body stays a plain graph, which
    // keeps this endpoint usable by anything that already has one.
    const requested = (request.query as { model?: string }).model;
    const model = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : undefined;

    // The picker offers only allowed models, but the query string is not the
    // picker. Unchecked, anyone could route reviews to the most expensive
    // model the key can reach.
    if (model !== undefined && !(await isAllowedModel(reviewer, config, model))) {
      return reply.status(400).send({ error: 'model not allowed', detail: 'Choose one of the listed models.' });
    }

    try {
      const result = await reviewer.review(graph, model);
      return {
        findings: result.findings,
        fingerprint: result.fingerprint,
        cached: result.cached,
        usage: result.usage,
        provider: result.provider,
        model: result.model,
      };
    } catch (error) {
      request.log.error({ err: error }, 'architecture review failed');
      return reply.status(502).send({ error: 'review failed', detail: describeUpstream(error) });
    }
  });

  /**
   * The collaboration socket. One connection per open diagram.
   *
   * Everything on this socket is binary Yjs framing; there is no JSON envelope
   * and no application-level message type of our own.
   */
  app.get('/ws/:roomId', { websocket: true }, (connection, request) => {
    const parsed = RoomIdSchema.safeParse((request.params as { roomId?: string }).roomId);
    if (!parsed.success) {
      connection.close(1008, 'invalid room id');
      return;
    }
    const roomId = parsed.data;

    // Browsers attach Origin to every socket upgrade and cannot forge it, so a
    // foreign page can be told apart from this app. Non-browser clients send
    // none. The room id is still the real capability; this stops a page that
    // has learned one from driving the room from a visitor's browser.
    if (!isAllowedSocketOrigin(request.headers.origin, request.headers.host, config)) {
      connection.close(1008, 'origin not allowed');
      return;
    }

    const budget = new TokenBucket(config.WS_MESSAGES_PER_SECOND);

    const socket: Socket = {
      send: (data) => connection.send(data),
      close: (code, reason) => connection.close(code, reason),
      get open() {
        return connection.readyState === connection.OPEN;
      },
    };

    // Frames can arrive before the room finishes loading from storage. Buffering
    // them is what prevents a fast client's first edit from being dropped on a
    // cold room.
    const buffered: Uint8Array[] = [];
    let joined: Room | null = null;

    // One listener for both phases, so the budget is checked before a frame
    // can reach the document, buffered or not.
    connection.on('message', (data: Buffer) => {
      if (!budget.take()) {
        connection.close(1008, 'rate limit exceeded');
        return;
      }
      const frame = new Uint8Array(data);
      if (joined) joined.handleMessage(socket, frame);
      else buffered.push(frame);
    });

    // Who may open the room is decided once, on upgrade. A change to that
    // closes every socket on the room (CLOSE_ACCESS_CHANGED), so nobody keeps
    // a grant that has since been taken away.
    void store
      .isDeleted(roomId)
      .then(async (deleted) => {
        if (deleted) {
          connection.close(CLOSE_DELETED, 'deleted');
          return null;
        }
        if (await isMissing(roomId)) {
          connection.close(CLOSE_NOT_FOUND, 'not found');
          return null;
        }
        return accessFor(request, roomId);
      })
      .then((granted) => {
        if (!granted) return null;
        if (!granted.canView) {
          connection.close(CLOSE_FORBIDDEN, 'private room');
          return null;
        }
        return rooms.join(roomId, socket, { readOnly: !granted.canEdit });
      })
      .then((room) => {
        if (!room) return;
        joined = room;
        for (const frame of buffered) room.handleMessage(socket, frame);
        buffered.length = 0;
      })
      .catch((error: unknown) => {
        request.log.error({ err: error, room: roomTag(roomId) }, 'failed to join room');
        connection.close(1011, 'could not open room');
      });

    connection.on('close', () => {
      void rooms.leave(roomId, socket).catch((error: unknown) => {
        request.log.error({ err: error, room: roomTag(roomId) }, 'failed to leave room cleanly');
      });
    });
  });

  /**
   * Serve the built Angular app from the same origin as the API and socket.
   *
   * app-config.ts assumes exactly this in production: it points the client at
   * `location.origin` rather than a configured URL. Gated on NODE_ENV rather
   * than "does the build directory happen to exist", so a production boot with
   * a missing or empty build fails loudly instead of quietly 404ing every UI
   * request while /health still reports ok. Dev and test never take this path,
   * since apps/web isn't built there.
   */
  if (config.NODE_ENV === 'production') {
    const webDist = fileURLToPath(new URL('../../web/dist/web/browser', import.meta.url));
    if (!existsSync(webDist)) {
      throw new Error(`Expected the built web app at ${webDist}; refusing to boot without it.`);
    }
    await app.register(staticPlugin, { root: webDist });

    // Angular's router owns any path that isn't ours, so unmatched GETs get
    // index.html and the client-side router takes it from there. Room ids live
    // at the URL root (see app.routes.ts) and are unconstrained beyond
    // [a-zA-Z0-9_-], so a prefix check without a slash boundary would wrongly
    // claim room ids like "apiteam" or "wsdesign" as API/WS space.
    app.setNotFoundHandler((request, reply) => {
      const isApiRoute = request.url === '/api' || request.url.startsWith('/api/');
      const isWsRoute = request.url === '/ws' || request.url.startsWith('/ws/');
      if (request.method !== 'GET' || isApiRoute || isWsRoute) {
        return reply.status(404).send({ error: 'not found' });
      }

      // A dotted last segment (e.g. a hashed JS chunk or an image) is a missing
      // static asset, not a client route - room ids never contain a dot - so it
      // should be a real 404 instead of a masked 200 of index.html.
      const path = request.url.split('?')[0] ?? '';
      const lastSegment = path.slice(path.lastIndexOf('/') + 1);
      if (lastSegment.includes('.')) {
        return reply.status(404).send({ error: 'not found' });
      }

      return reply.sendFile('index.html');
    });
  }

  // Rooms hold unflushed edits, so shutdown must wait for them rather than
  // letting the process exit with work still in memory.
  app.addHook('onClose', async () => {
    // First, so no evaluation reopens a room that is being torn down.
    await alertWorker.stop();
    await rooms.closeAll();
    await store.close();
  });

  return app;
}

/**
 * Room ids in a URL, replaced by a short one-way tag. Logs keep enough to
 * correlate requests for one room without keeping the capability itself.
 */
export function redactRoomIds(url: string): string {
  return url.replace(/^\/(ws|api\/rooms)\/([^/?#]+)/, (_match, prefix: string, id: string) => `/${prefix}/${roomTag(id)}`);
}

function roomTag(roomId: string): string {
  return `room#${createHash('sha256').update(roomId).digest('hex').slice(0, 10)}`;
}

/** No Origin (not a browser), this app's own origin, or a configured one. */
export function isAllowedSocketOrigin(origin: string | undefined, host: string | undefined, config: Config): boolean {
  if (origin === undefined) return true;
  if (config.corsOrigins.includes(origin)) return true;
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function allowedModels(reviewer: ArchitectureReviewer, config: Config): Promise<string[]> {
  const listed = await reviewer.listModels();
  const allowList = config.reviewAllowedModels;
  return allowList ? listed.filter((model) => allowList.includes(model)) : listed;
}

async function isAllowedModel(reviewer: ArchitectureReviewer, config: Config, model: string): Promise<boolean> {
  if (model === reviewer.defaultModel) return true;
  return (await allowedModels(reviewer, config)).includes(model);
}

/**
 * Pick the review provider from whichever credential is present.
 *
 * Anthropic wins when both are set, so a deployment that has been given both
 * behaves predictably rather than depending on evaluation order.
 */
function selectProvider(config: Config): ReviewProvider | null {
  const model = config.REVIEW_MODEL;

  if (config.ANTHROPIC_API_KEY) {
    return new AnthropicReviewProvider({
      apiKey: config.ANTHROPIC_API_KEY,
      ...(model ? { model } : {}),
    });
  }

  if (config.GEMINI_API_KEY) {
    return new GeminiReviewProvider({
      apiKey: config.GEMINI_API_KEY,
      ...(model ? { model } : {}),
    });
  }

  return null;
}

/**
 * Turn an upstream failure into something the user can act on.
 *
 * "The reviewer is unavailable" is true but useless: a model that no longer
 * exists and a model that is merely busy need different responses from the
 * person reading it. Only the provider's own status and message are forwarded,
 * never the error object, so credentials and request internals stay server-side.
 */
function describeUpstream(error: unknown): string {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;

  if (status === 404) return 'That model is not available to this API key. Choose another.';
  if (status === 503) return 'The model is busy right now. Try again, or choose another.';
  if (status === 429) return 'Rate limited by the provider. Wait a moment and try again.';
  if (status === 401 || status === 403) return 'The provider rejected the API key.';

  return 'The reviewer is unavailable.';
}
