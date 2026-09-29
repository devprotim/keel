// A stand-in for api.stripe.com, for billing.spec.ts only. It answers the
// three calls Keel makes (apps/server/src/billing/stripe.ts) with hosted-page
// URLs on itself, serves those pages, and records every request so a test can
// see exactly what Keel sent.
import { createServer } from 'node:http';

const port = Number(process.env.FAKE_STRIPE_PORT ?? 8791);
const requests = [];
const base = `http://127.0.0.1:${port}`;

createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    const url = new URL(request.url ?? '/', base);
    const json = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };

    if (request.method === 'GET' && url.pathname === '/health') return json(200, { ok: true });
    if (request.method === 'GET' && url.pathname === '/requests') return json(200, requests);
    if (request.method === 'GET' && (url.pathname === '/checkout' || url.pathname === '/portal')) {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(`<!doctype html><title>Fake Stripe</title><h1>Fake Stripe ${url.pathname.slice(1)}</h1>`);
    }

    if (request.method !== 'POST') return json(404, { error: { message: 'not found' } });
    if (request.headers.authorization !== 'Bearer sk_test_e2e') return json(401, { error: { message: 'bad key' } });
    const params = Object.fromEntries(new URLSearchParams(body));
    requests.push({ path: url.pathname, params });

    if (url.pathname === '/v1/checkout/sessions') return json(200, { id: 'cs_e2e', url: `${base}/checkout` });
    if (url.pathname === '/v1/billing_portal/sessions') return json(200, { id: 'bps_e2e', url: `${base}/portal` });
    if (url.pathname.startsWith('/v1/subscription_items/')) return json(200, { id: url.pathname.split('/').pop() });
    return json(404, { error: { message: 'not found' } });
  });
}).listen(port, '127.0.0.1');
