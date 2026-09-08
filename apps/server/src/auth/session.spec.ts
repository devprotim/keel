import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionManager, type SessionUser } from './session.ts';

const user: SessionUser = { id: 'github:1', provider: 'github', name: 'Ada Lovelace', avatarUrl: 'https://example.com/a.png' };

async function appWithCookies() {
  const app = Fastify();
  await app.register(fastifyCookie);
  return app;
}

describe('createSessionManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips a user through the cookie it sets', async () => {
    const app = await appWithCookies();
    const session = createSessionManager('s'.repeat(32), false);

    app.get('/set', async (_request, reply) => {
      await session.write(reply, user);
      return { ok: true };
    });
    app.get('/read', async (request) => ({ user: await session.read(request) }));

    const setRes = await app.inject({ method: 'GET', url: '/set' });
    const cookie = setRes.cookies.find((c) => c.name === 'keel_session');
    expect(cookie).toBeDefined();

    const readRes = await app.inject({ method: 'GET', url: '/read', cookies: { keel_session: cookie!.value } });
    expect(readRes.json()).toEqual({ user });

    await app.close();
  });

  it('rejects a token signed with a different secret', async () => {
    const app = await appWithCookies();
    const session = createSessionManager('correct-secret'.padEnd(32, '0'), false);

    const forged = await new SignJWT({ ...user })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('wrong-secret'.padEnd(32, '0')));

    app.get('/read', async (request) => ({ user: await session.read(request) }));
    const res = await app.inject({ method: 'GET', url: '/read', cookies: { keel_session: forged } });

    expect(res.json()).toEqual({ user: null });
    await app.close();
  });

  it('rejects an expired token', async () => {
    const app = await appWithCookies();
    const secret = 's'.repeat(32);
    const session = createSessionManager(secret, false);

    const expired = await new SignJWT({ ...user })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(secret));

    app.get('/read', async (request) => ({ user: await session.read(request) }));
    const res = await app.inject({ method: 'GET', url: '/read', cookies: { keel_session: expired } });

    expect(res.json()).toEqual({ user: null });
    await app.close();
  });

  it('returns null with no cookie at all', async () => {
    const app = await appWithCookies();
    const session = createSessionManager('s'.repeat(32), false);

    app.get('/read', async (request) => ({ user: await session.read(request) }));
    const res = await app.inject({ method: 'GET', url: '/read' });

    expect(res.json()).toEqual({ user: null });
    await app.close();
  });

  it('clear() expires the cookie', async () => {
    const app = await appWithCookies();
    const session = createSessionManager('s'.repeat(32), false);

    app.get('/logout', async (_request, reply) => {
      session.clear(reply);
      return { ok: true };
    });

    const res = await app.inject({ method: 'GET', url: '/logout' });
    const cookie = res.cookies.find((c) => c.name === 'keel_session');
    expect(cookie?.value).toBe('');

    await app.close();
  });
});
