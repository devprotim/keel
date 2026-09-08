import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SessionUser {
  /** `<provider>:<provider-user-id>`, e.g. `github:123`. */
  id: string;
  provider: 'github' | 'google';
  name: string;
  avatarUrl: string | null;
}

export interface SessionManager {
  read(request: FastifyRequest): Promise<SessionUser | null>;
  write(reply: FastifyReply, user: SessionUser): Promise<void>;
  clear(reply: FastifyReply): void;
}

const COOKIE_NAME = 'keel_session';
const SESSION_TTL = '30d';

/**
 * Stateless session: the cookie carries a signed JWT, so there is nothing to
 * store server-side and nothing new added to `DocStore`. This is deliberately
 * lighter than a session store, since auth here is identity-only — losing a
 * session just means signing in again, not losing access to anything.
 */
export function createSessionManager(secret: string, secureCookie: boolean): SessionManager {
  const key = new TextEncoder().encode(secret);
  const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, secure: secureCookie, path: '/' };

  return {
    async read(request) {
      const token = request.cookies[COOKIE_NAME];
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, key);
        return parseSessionPayload(payload);
      } catch {
        return null;
      }
    },

    async write(reply, user) {
      const token = await new SignJWT({ ...user })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(SESSION_TTL)
        .sign(key);
      reply.setCookie(COOKIE_NAME, token, cookieOpts);
    },

    clear(reply) {
      reply.clearCookie(COOKIE_NAME, { path: '/' });
    },
  };
}

function parseSessionPayload(payload: JWTPayload): SessionUser | null {
  const { id, provider, name, avatarUrl } = payload;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  if (provider !== 'github' && provider !== 'google') return null;
  return { id, provider, name, avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : null };
}
