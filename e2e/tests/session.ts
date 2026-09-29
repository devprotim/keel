import { createHmac } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { E2E_SESSION_SECRET } from '../playwright.config.ts';

/**
 * Sign a browser in without GitHub: a session cookie exactly as the OAuth
 * callback sets one (an HS256 JWT, apps/server/src/auth/session.ts), signed
 * with the secret the e2e server runs with.
 */
export async function signIn(context: BrowserContext, baseURL: string, id: string, name: string): Promise<void> {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'HS256' })}.${encode({ id: `github:${id}`, provider: 'github', name, avatarUrl: null, iat: now, exp: now + 3600 })}`;
  const signature = createHmac('sha256', E2E_SESSION_SECRET).update(body).digest('base64url');
  await context.addCookies([{ name: 'keel_session', value: `${body}.${signature}`, url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
}
