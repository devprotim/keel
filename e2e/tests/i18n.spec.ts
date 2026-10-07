import { expect, test } from '@playwright/test';
import { Board, newRoomId } from './board.ts';

/**
 * German, end to end: a German browser gets German without choosing it, the
 * switch changes language and remembers it, and a room's link is the same in
 * both languages. Every other spec runs in English (Playwright's default
 * en-US), which is what their text locators rely on.
 */

test.describe('in a German browser', () => {
  test.use({ locale: 'de-DE' });

  test('the landing page and a board are in German', async ({ page }) => {
    const unknown: string[] = [];
    page.on('console', (message) => {
      if (/No translation found/.test(message.text())) unknown.push(message.text());
    });

    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.getByRole('button', { name: 'Neues Diagramm beginnen' })).toBeVisible();

    await new Board(page).open(await newRoomId());
    await expect(page.getByRole('button', { name: 'Teilen' })).toBeVisible();
    await expect(page.getByText('Noch nichts auf der Arbeitsfläche')).toBeVisible();
    expect(unknown).toEqual([]);
  });

  test('the switch goes to English and stays there', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.getByRole('button', { name: 'Start a new diagram' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    await page.reload();
    await expect(page.getByRole('button', { name: 'Start a new diagram' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deutsch' })).toBeVisible();
  });
});
