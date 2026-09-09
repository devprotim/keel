import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { validate } from '@keel/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AnthropicReviewProvider } from './ai/anthropic-provider.ts';
import { GeminiReviewProvider } from './ai/gemini-provider.ts';
import type { ReviewProvider } from './ai/provider.ts';
import { ArchitectureReviewer } from './ai/review.ts';
import { registerAuth } from './auth/routes.ts';
import { RoomManager } from './collab/room-manager.ts';
import type { Socket } from './collab/room.ts';
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

const ArchNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(['service', 'datastore', 'queue', 'cache', 'gateway', 'job', 'external']),
  label: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  replicas: z.number().int().nonnegative(),
  tech: z.string().optional(),
  notes: z.string().optional(),
  critical: z.boolean().optional(),
  hasReplica: z.boolean().optional(),
  hasBackup: z.boolean().optional(),
  hasDlq: z.boolean().optional(),
});

const ArchEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: z.enum(['sync', 'async', 'stream']),
  label: z.string().optional(),
  timeoutMs: z.number().optional(),
  retries: z.number().int().optional(),
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

export interface AppDeps {
  config: Config;
  store: DocStore;
}

export async function buildApp({ config, store }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: 'info' },
  });

  const rooms = new RoomManager(store, {
    persistDebounceMs: config.PERSIST_DEBOUNCE_MS,
    compactAfterUpdates: config.COMPACT_AFTER_UPDATES,
    idleMs: config.ROOM_IDLE_MS,
  });

  // Absent keys disable review rather than failing at boot. The canvas is the
  // product; the reviewer is an enhancement and must not gate startup.
  const provider = selectProvider(config);
  const reviewer = provider ? new ArchitectureReviewer({ provider }) : null;

  // credentials: true so the session cookie rides cross-origin in dev, where
  // the Angular dev server (:4200) and this API (:8787) are different origins.
  await app.register(cors, { origin: [...config.corsOrigins], credentials: true });
  await app.register(websocket);

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

  const auth = await registerAuth(app, config);

  app.get('/health', async () => ({
    status: 'ok',
    rooms: rooms.residentCount,
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
  app.post('/api/validate', async (request, reply) => {
    const parsed = ArchGraphSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid graph', issues: parsed.error.issues });
    }
    return validate(parsed.data);
  });

  /** Models the configured provider can serve, for the client's picker. */
  app.get('/api/review/models', async (_request, reply) => {
    if (!reviewer) return reply.status(503).send({ error: 'review is not configured' });

    return {
      provider: reviewer.providerName,
      defaultModel: reviewer.defaultModel,
      models: await reviewer.listModels(),
    };
  });

  app.post('/api/review', async (request, reply) => {
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

    const socket: Socket = {
      send: (data) => connection.send(data),
      close: () => connection.close(),
      get open() {
        return connection.readyState === connection.OPEN;
      },
    };

    // Frames can arrive before the room finishes loading from storage. Buffering
    // them is what prevents a fast client's first edit from being dropped on a
    // cold room.
    const buffered: Uint8Array[] = [];
    let joined = false;

    void rooms
      .join(roomId, socket)
      .then((room) => {
        joined = true;
        for (const frame of buffered) room.handleMessage(socket, frame);
        buffered.length = 0;

        connection.on('message', (data: Buffer) => {
          room.handleMessage(socket, new Uint8Array(data));
        });
      })
      .catch((error: unknown) => {
        request.log.error({ err: error, roomId }, 'failed to join room');
        connection.close(1011, 'could not open room');
      });

    connection.on('message', (data: Buffer) => {
      if (!joined) buffered.push(new Uint8Array(data));
    });

    connection.on('close', () => {
      void rooms.leave(roomId, socket).catch((error: unknown) => {
        request.log.error({ err: error, roomId }, 'failed to leave room cleanly');
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
    await rooms.closeAll();
    await store.close();
  });

  return app;
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
