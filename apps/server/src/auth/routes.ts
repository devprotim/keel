import fastifyCookie from '@fastify/cookie';
import { fastifyOauth2 } from '@fastify/oauth2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { fetchGithubUser, fetchGoogleUser } from './providers.ts';
import { createSessionManager } from './session.ts';

export interface AuthStatus {
  github: boolean;
  google: boolean;
}

interface OAuth2Namespace {
  generateAuthorizationUri(request: FastifyRequest, reply: FastifyReply): Promise<string>;
  getAccessTokenFromAuthorizationCodeFlow(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ token: { access_token: string } }>;
}

/** Room ids are the only thing a post-login redirect is allowed to target. */
const RETURN_TO_PATTERN = /^\/[a-zA-Z0-9_-]*$/;
const RETURN_TO_COOKIE = 'keel_return_to';

/**
 * Registers `/api/auth/*`. Each provider is wired up only when both of its
 * env vars are set; with neither configured, only `/api/auth/me` exists and it
 * always reports an anonymous user. This mirrors `/api/review`'s "absent
 * credentials disable the feature, never the boot" precedent - the canvas and
 * presence both work fully with zero OAuth configured.
 *
 * Auth here is identity-only: it never gates a room. A successful login just
 * replaces the client's random guest name with the provider's real one.
 */
export async function registerAuth(app: FastifyInstance, config: Config): Promise<AuthStatus> {
  const github =
    config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET
      ? { id: config.GITHUB_CLIENT_ID, secret: config.GITHUB_CLIENT_SECRET }
      : null;
  const google =
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
      ? { id: config.GOOGLE_CLIENT_ID, secret: config.GOOGLE_CLIENT_SECRET }
      : null;

  if (!github && !google) {
    app.get('/api/auth/me', async () => ({ user: null }));
    return { github: false, google: false };
  }

  const sessionSecret = config.SESSION_SECRET;
  if (!sessionSecret) {
    // Config validation guarantees this once a provider is configured; this
    // only guards the type-level gap between the two modules.
    throw new Error('SESSION_SECRET is required once a login provider is configured');
  }

  const secureCookie = config.NODE_ENV === 'production';
  await app.register(fastifyCookie);
  const session = createSessionManager(sessionSecret, secureCookie);

  if (github) {
    await app.register(fastifyOauth2, {
      name: 'githubOAuth2',
      scope: ['read:user'],
      credentials: { client: github, auth: fastifyOauth2.GITHUB_CONFIGURATION },
      callbackUri: `${config.PUBLIC_URL}/api/auth/github/callback`,
    });

    registerProviderRoutes(app, config, 'github', 'githubOAuth2', fetchGithubUser, session, secureCookie);
  }

  if (google) {
    await app.register(fastifyOauth2, {
      name: 'googleOAuth2',
      scope: ['openid', 'profile'],
      credentials: { client: google, auth: fastifyOauth2.GOOGLE_CONFIGURATION },
      callbackUri: `${config.PUBLIC_URL}/api/auth/google/callback`,
    });

    registerProviderRoutes(app, config, 'google', 'googleOAuth2', fetchGoogleUser, session, secureCookie);
  }

  app.get('/api/auth/me', async (request) => ({ user: await session.read(request) }));

  app.post('/api/auth/logout', async (_request, reply) => {
    session.clear(reply);
    return { ok: true };
  });

  return { github: Boolean(github), google: Boolean(google) };
}

function registerProviderRoutes(
  app: FastifyInstance,
  config: Config,
  path: 'github' | 'google',
  decoratorName: 'githubOAuth2' | 'googleOAuth2',
  fetchUser: (accessToken: string) => Promise<import('./session.ts').SessionUser>,
  session: ReturnType<typeof createSessionManager>,
  secureCookie: boolean,
): void {
  // Independent of the plugin's own CSRF-state cookie: `returnTo` is which
  // room to bounce back to, not part of the security check, so it travels in
  // its own short-lived cookie rather than being smuggled into `state`.
  //
  // The redirect target has to be an absolute URL, not just a path: the API
  // (this server) and the client can be different origins in dev (:8787 vs
  // Angular's :4200), so `reply.redirect('/roomId')` from the callback would
  // resolve against the API's own origin and 404. The client origin itself
  // isn't known at callback time - the request there is a top-level
  // navigation from the provider, with no Referer pointing back at the app -
  // so it's captured now, from the Referer of the page that had the login
  // button, and carried through the cookie alongside the path.
  app.get(`/api/auth/${path}`, async (request, reply) => {
    const oauth = app.getDecorator<OAuth2Namespace>(decoratorName);
    const returnToPath = safeReturnToPath((request.query as Record<string, unknown> | undefined)?.['returnTo']);
    const clientOrigin = resolveClientOrigin(request, config);
    reply.setCookie(RETURN_TO_COOKIE, `${clientOrigin}${returnToPath}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie,
      path: '/',
      maxAge: 300,
    });
    const uri = await oauth.generateAuthorizationUri(request, reply);
    return reply.redirect(uri);
  });

  app.get(`/api/auth/${path}/callback`, async (request, reply) => {
    const oauth = app.getDecorator<OAuth2Namespace>(decoratorName);
    const returnTo = safeReturnToUrl(request.cookies[RETURN_TO_COOKIE], config);
    reply.clearCookie(RETURN_TO_COOKIE, { path: '/' });

    try {
      const { token } = await oauth.getAccessTokenFromAuthorizationCodeFlow(request, reply);
      const user = await fetchUser(token.access_token);
      await session.write(reply, user);
    } catch (error) {
      request.log.error({ err: error }, `${path} login failed`);
    }
    return reply.redirect(returnTo);
  });
}

function safeReturnToPath(raw: unknown): string {
  return typeof raw === 'string' && RETURN_TO_PATTERN.test(raw) ? raw : '/';
}

/** Only an origin already trusted for browser access to the API can be redirected to. */
function resolveClientOrigin(request: FastifyRequest, config: Config): string {
  const referer = request.headers.referer;
  if (typeof referer === 'string') {
    try {
      const refererOrigin = new URL(referer).origin;
      if (config.corsOrigins.includes(refererOrigin)) return refererOrigin;
    } catch {
      // Malformed Referer; fall through to the same-origin default below.
    }
  }
  // No Referer, or it's untrusted: same-origin deploys (production) always
  // land here correctly, since the client's origin equals the API's own.
  return new URL(config.PUBLIC_URL).origin;
}

function safeReturnToUrl(raw: unknown, config: Config): string {
  const fallback = `${new URL(config.PUBLIC_URL).origin}/`;
  if (typeof raw !== 'string') return fallback;
  try {
    const url = new URL(raw);
    if (!RETURN_TO_PATTERN.test(url.pathname)) return fallback;
    if (url.origin !== new URL(config.PUBLIC_URL).origin && !config.corsOrigins.includes(url.origin)) return fallback;
    return `${url.origin}${url.pathname}`;
  } catch {
    return fallback;
  }
}
