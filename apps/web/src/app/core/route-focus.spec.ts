import { afterEach, describe, expect, it } from 'vitest';
import { focusPageStart } from './route-focus';

describe('focusPageStart', () => {
  afterEach(() => document.body.replaceChildren());

  function page(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.append(root);
    return root;
  }

  it('prefers an element marked data-route-focus over a heading', () => {
    const root = page('<h1>Title</h1><div data-route-focus tabindex="0" id="canvas"></div>');
    focusPageStart(root);
    expect(document.activeElement?.id).toBe('canvas');
  });

  it('focuses the h1 without adding it to the Tab order', () => {
    const root = page('<main><h1 id="title">Title</h1></main>');
    focusPageStart(root);
    expect(document.activeElement?.id).toBe('title');
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
  });

  it('falls back to main, and leaves focus alone when there is nothing to focus', () => {
    focusPageStart(page('<main id="main"><p>Loading</p></main>'));
    expect(document.activeElement?.id).toBe('main');

    document.body.replaceChildren();
    focusPageStart(page('<p>Nothing</p>'));
    expect(document.activeElement).toBe(document.body);
  });
});
