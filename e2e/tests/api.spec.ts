import { expect, test } from '@playwright/test';

test('health reports the process is up with review and OAuth disabled', async ({ request }) => {
  const response = await request.get('/health');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    status: 'ok',
    review: 'disabled',
    oauth: { github: 'disabled', google: 'disabled' },
  });
});

test('validate runs the shared rule engine over HTTP', async ({ request }) => {
  const response = await request.post('/api/validate', {
    data: {
      nodes: [{ id: 'a', kind: 'service', label: 'A', x: 0, y: 0, w: 160, h: 72, replicas: 1 }],
      edges: [],
    },
  });
  expect(response.ok()).toBe(true);
  const report = (await response.json()) as { findings: { ruleId: string }[] };
  expect(report.findings.map((f) => f.ruleId)).toContain('orphan-node');
});

test('validate rejects a malformed graph', async ({ request }) => {
  const response = await request.post('/api/validate', { data: { nodes: 'nope' } });
  expect(response.status()).toBe(400);
});

test('the SPA fallback serves client routes but 404s missing assets and API paths', async ({ request }) => {
  const room = await request.get('/apiteam');
  expect(room.status()).toBe(200);
  expect(await room.text()).toContain('<app-root');

  expect((await request.get('/missing-chunk.js')).status()).toBe(404);
  expect((await request.get('/api/nope')).status()).toBe(404);
});

test('signed-out sessions report no user', async ({ request }) => {
  const response = await request.get('/api/auth/me');
  expect(await response.json()).toEqual({ user: null });
});
