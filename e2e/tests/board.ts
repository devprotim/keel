import { expect, type Locator, type Page } from '@playwright/test';

/** Fresh random room id in the same 12-hex-char shape as core/room-id.ts. */
export function newRoomId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/**
 * The board, as a user reaches it.
 *
 * The diagram itself is a <canvas>, which Playwright cannot read, so
 * assertions go through what the app already exposes for assistive tech: the
 * canvas's aria-label carries node/edge counts, and a visually hidden list
 * mirrors every node as "label, kind, N instances". Testing through that
 * surface means these tests also keep the accessible mirror honest.
 */
export class Board {
  readonly canvas: Locator;
  readonly nodeList: Locator;
  readonly inspector: Locator;
  readonly reviewPill: Locator;

  constructor(readonly page: Page) {
    this.canvas = page.getByRole('application', { name: /Architecture canvas/ });
    this.nodeList = this.canvas.getByRole('listitem');
    this.inspector = page.locator('keel-inspector');
    this.reviewPill = page.getByRole('button', { name: /^Review: \d+ out of 100/ });
  }

  async open(roomId: string): Promise<void> {
    await this.page.goto(`/${roomId}`);
    await this.expectLive();
  }

  async expectLive(): Promise<void> {
    await expect(this.page.locator('.presence .status')).toHaveText('Live');
  }

  async expectCounts(nodes: number, edges: number): Promise<void> {
    await expect(this.canvas).toHaveAttribute(
      'aria-label',
      new RegExp(`with ${nodes} components and ${edges} dependencies`),
    );
  }

  async loadExample(): Promise<void> {
    await this.page.getByRole('button', { name: 'Load example' }).click();
    await this.expectCounts(11, 12);
  }

  /** Arm a kind on the rail, then click the canvas at a point relative to it. */
  async placeNode(kind: string, at: { x: number; y: number }): Promise<void> {
    await this.page.getByRole('toolbar', { name: 'Add a component' }).getByRole('button', { name: kind, exact: true }).click();
    await this.canvas.click({ position: at });
  }

  /** Absolute page coordinates of a point given relative to the canvas. */
  async pagePoint(at: { x: number; y: number }): Promise<{ x: number; y: number }> {
    const box = await this.canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    return { x: box.x + at.x, y: box.y + at.y };
  }

  /**
   * An inspector field by the start of its accessible name. The inspector wraps
   * each control in its <label> together with any hint text, so e.g. the
   * Instances input is named "Instances One instance is a single point of
   * failure." and an exact match would miss it.
   */
  field(label: string): Locator {
    const name = new RegExp(`^${label}\\b`);
    const byRole = (role: 'textbox' | 'combobox' | 'spinbutton') => this.inspector.getByRole(role, { name });
    return byRole('textbox').or(byRole('combobox')).or(byRole('spinbutton'));
  }
}
