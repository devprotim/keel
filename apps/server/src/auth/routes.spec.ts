import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.ts';
import { registerAuth } from './routes.ts';

function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 's'.repeat(32),
    PUBLIC_URL: 'http://localhost:8787',
    ...overrides,
  });
}

describe('registerAuth', () => {
  it('exposes only /api/auth/me, reporting anonymous, when no provider is configured', async () => {
    const app = Fastify();
    const status = await registerAuth(app, testConfig());
    await app.ready();

    expect(status).toEqual({ github: false, google: false });
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).json()).toEqual({ user: null });
    expect((await app.inject({ method: 'GET', url: '/api/auth/github' })).statusCode).toBe(404);

    await app.close();
  });

  it('redirects to GitHub for authorization once GitHub is configured', async () => {
    const app = Fastify();
    const status = await registerAuth(app, testConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }));
    await app.ready();

    expect(status).toEqual({ github: true, google: false });

    const start = await app.inject({ method: 'GET', url: '/api/auth/github?returnTo=/room-42' });
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toContain('github.com');

    // Google was never configured, so it must not have been wired up alongside GitHub.
    expect((await app.inject({ method: 'GET', url: '/api/auth/google' })).statusCode).toBe(404);

    await app.close();
  });

  it('redirects to Google for authorization once Google is configured', async () => {
    const app = Fastify();
    const status = await registerAuth(app, testConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }));
    await app.ready();

    expect(status).toEqual({ github: false, google: true });

    const start = await app.inject({ method: 'GET', url: '/api/auth/google' });
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toContain('accounts.google.com');

    await app.close();
  });

  it('rejects a returnTo outside the room-id charset, falling back to the API origin', async () => {
    const app = Fastify();
    await registerAuth(app, testConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }));
    await app.ready();

    // An open-redirect attempt must not survive into the cookie read back at callback time.
    const start = await app.inject({ method: 'GET', url: '/api/auth/github?returnTo=https://evil.example' });
    expect(start.statusCode).toBe(302);
    expect(start.cookies.find((c) => c.name === 'keel_return_to')?.value).toBe('http://localhost:8787/');

    await app.close();
  });

  it('carries a valid returnTo through to the return-to cookie, defaulting to the API origin with no Referer', async () => {
    const app = Fastify();
    await registerAuth(app, testConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }));
    await app.ready();

    const start = await app.inject({ method: 'GET', url: '/api/auth/github?returnTo=/room-42' });
    expect(start.cookies.find((c) => c.name === 'keel_return_to')?.value).toBe('http://localhost:8787/room-42');

    await app.close();
  });

  it('carries the return-to path to the client origin when the login page came from a different, trusted origin', async () => {
    // Regression: dev has the Angular app on :4200 and this API on :8787. A
    // bare-path redirect from the callback would resolve against the API's
    // own origin and 404 - this is exactly that scenario.
    const app = Fastify();
    await registerAuth(app, testConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }));
    await app.ready();

    const start = await app.inject({
      method: 'GET',
      url: '/api/auth/github?returnTo=/room-42',
      headers: { referer: 'http://localhost:4200/room-42' },
    });
    expect(start.cookies.find((c) => c.name === 'keel_return_to')?.value).toBe('http://localhost:4200/room-42');

    await app.close();
  });

  it('ignores a Referer whose origin is not in CORS_ORIGINS', async () => {
    const app = Fastify();
    await registerAuth(app, testConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }));
    await app.ready();

    const start = await app.inject({
      method: 'GET',
      url: '/api/auth/github?returnTo=/room-42',
      headers: { referer: 'https://evil.example/room-42' },
    });
    expect(start.cookies.find((c) => c.name === 'keel_return_to')?.value).toBe('http://localhost:8787/room-42');

    await app.close();
  });

  it('redirects to the return-to URL carried in the cookie once the callback runs, even if the token exchange fails', async () => {
    const app = Fastify();
    await registerAuth(app, testConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }));
    await app.ready();

    const callback = await app.inject({
      method: 'GET',
      url: '/api/auth/github/callback?code=fake&state=fake',
      cookies: { keel_return_to: 'http://localhost:4200/room-42' },
    });

    // The fake code can never exchange for a real token, so login fails, but
    // the user still lands back where they started rather than on an error page.
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('http://localhost:4200/room-42');

    await app.close();
  });

  it('falls back to the API origin when the return-to cookie is missing or tampered with', async () => {
    const app = Fastify();
    await registerAuth(app, testConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }));
    await app.ready();

    const callback = await app.inject({
      method: 'GET',
      url: '/api/auth/github/callback?code=fake&state=fake',
      cookies: { keel_return_to: 'https://evil.example/room-42' },
    });

    expect(callback.headers.location).toBe('http://localhost:8787/');

    await app.close();
  });

  it('has no logout route when no provider is configured, since no one could be signed in', async () => {
    const app = Fastify();
    await registerAuth(app, testConfig());
    await app.ready();

    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(404);

    await app.close();
  });

  it('logout clears the session cookie once a provider is configured', async () => {
    const app = Fastify();
    await registerAuth(app, testConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }));
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.json()).toEqual({ ok: true });
    expect(res.cookies.find((c) => c.name === 'keel_session')?.value).toBe('');

    await app.close();
  });
});
