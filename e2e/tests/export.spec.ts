import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { Board, newRoomId } from './board.js';

async function download(page: Page, item: string): Promise<{ name: string; body: Buffer }> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: new RegExp(`^${item}`) }).click(),
  ]);
  const path = await file.path();
  return { name: file.suggestedFilename(), body: await readFile(path) };
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test.describe('export', () => {
  let board: Board;
  let roomId: string;

  test.beforeEach(async ({ page }) => {
    board = new Board(page);
    roomId = newRoomId();
    await board.open(roomId);
  });

  test('is unavailable until there is something to export', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
  });

  test('PNG is a real image of the whole diagram at 2x', async ({ page }) => {
    await board.loadExample();
    const { name, body } = await download(page, 'PNG image');

    expect(name).toMatch(new RegExp(`^keel-${roomId}-\\d{4}-\\d{2}-\\d{2}\\.png$`));
    // The example spans roughly 1500 x 540 world units; 2x plus padding.
    const { width, height } = pngSize(body);
    expect(width).toBeGreaterThan(3000);
    expect(height).toBeGreaterThan(1000);
  });

  test('SVG is vector, with the diagram text as real text', async ({ page }) => {
    await board.loadExample();
    const { name, body } = await download(page, 'SVG image');
    const svg = body.toString('utf8');

    expect(name).toMatch(/\.svg$/);
    expect(svg).toMatch(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('>Checkout<');
    expect(svg).toContain('>Pricing engine<');
    expect(svg).not.toContain('<image');
  });

  test('JSON round-trips through /api/validate unchanged', async ({ page, request }) => {
    await board.loadExample();
    const { name, body } = await download(page, 'JSON');
    const exported = JSON.parse(body.toString('utf8')) as { format: string; nodes: unknown[]; edges: unknown[] };

    expect(name).toMatch(/\.json$/);
    expect(exported.format).toBe('keel-diagram');
    expect(exported.nodes).toHaveLength(11);
    expect(exported.edges).toHaveLength(12);

    const response = await request.post('/api/validate', { data: exported });
    expect(response.ok()).toBe(true);
    const report = (await response.json()) as { findings: { ruleId: string }[] };
    expect(report.findings.map((f) => f.ruleId)).toContain('spof-single-instance');
  });

  test('the menu works from the keyboard and Escape returns focus', async ({ page }) => {
    await board.loadExample();
    const trigger = page.getByRole('button', { name: 'Export', exact: true });
    await trigger.click();

    const menu = page.getByRole('menu', { name: 'Export' });
    await expect(menu.getByRole('menuitem', { name: /^PNG image/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: /^SVG image/ })).toBeFocused();

    const findings = menu.getByRole('menuitemcheckbox', { name: 'Show findings on images' });
    await expect(findings).toHaveAttribute('aria-checked', 'false');
    await findings.click();
    await expect(findings).toHaveAttribute('aria-checked', 'true');

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

test.describe('import', () => {
  test('a JSON export opens from the landing page as a new room, baseline included', async ({ page }) => {
    const board = new Board(page);
    const source = newRoomId();
    await board.open(source);
    await board.loadExample();
    await board.reviewPill.click();
    await page.locator('keel-findings .reality').getByRole('button', { name: 'Approve design' }).click();
    const { body } = await download(page, 'JSON');

    await page.goto('/');
    await page.locator('input[type=file]').setInputFiles({ name: 'diagram.json', mimeType: 'application/json', buffer: body });

    await expect(page).not.toHaveURL(new RegExp(`/${source}$`));
    await expect(page).toHaveURL(/\/[0-9a-f]{12}$/);
    await board.expectLive();
    await board.expectCounts(11, 12);
    await board.reviewPill.click();
    await expect(page.locator('keel-findings .reality')).toContainText('Matches the approved design.');

    // One undo takes the whole import back.
    await page.getByRole('button', { name: '↶' }).click();
    await board.expectCounts(0, 0);
  });

  test('a JSON file imports into an empty board', async ({ page }) => {
    const board = new Board(page);
    await board.open(newRoomId());
    const file = {
      nodes: [
        { id: 'api', kind: 'service', label: 'API', x: 0, y: 0, w: 184, h: 84, replicas: 2 },
        { id: 'db', kind: 'datastore', label: 'DB', x: 320, y: 0, w: 184, h: 84, replicas: 1 },
      ],
      edges: [{ id: 'e1', source: 'api', target: 'db', kind: 'sync', timeoutMs: 500 }],
    };
    await page.locator('.empty input[type=file]').setInputFiles({
      name: 'bare.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(file)),
    });

    await board.expectCounts(2, 1);
    await expect(board.nodeList.filter({ hasText: 'DB, datastore, 1 instance' })).toHaveCount(1);
  });

  test('a broken file is refused with the reason, and nothing is imported', async ({ page }) => {
    const board = new Board(page);
    await board.open(newRoomId());
    await page.locator('.empty input[type=file]').setInputFiles({
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ nodes: [{ id: 'a', kind: 'lambda' }], edges: [] })),
    });

    await expect(page.locator('.empty .import-errors')).toContainText('Component 1 ("a") has kind "lambda"');
    await board.expectCounts(0, 0);
  });
});
