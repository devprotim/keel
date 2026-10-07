import { afterNextRender, inject, Injector, provideEnvironmentInitializer } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';

/**
 * Moves focus to the new page after an in-app navigation. Without it, focus
 * stays on the link or button that navigated (or falls to `<body>` when that
 * element is gone), and a screen reader announces nothing, because no page
 * load happened.
 *
 * Skipped on the first load, where the browser already starts at the top, and
 * when only query params or the fragment change (`?pitch=`), since the page is
 * the same one.
 */
export function provideRouteFocus() {
  return provideEnvironmentInitializer(() => {
    const router = inject(Router);
    const injector = inject(Injector);
    let previousPath: string | null = null;
    router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      const path = event.urlAfterRedirects.split(/[?#]/)[0];
      const skip = previousPath === null || path === previousPath;
      previousPath = path;
      if (!skip) afterNextRender(() => focusPageStart(document), { injector });
    });
  });
}

/**
 * Focuses where a page starts: an element marked `data-route-focus` (the
 * board's canvas, which has no heading), else the page's `h1`, else `<main>`.
 * A heading or `<main>` is made focusable with `tabindex="-1"`, which keeps it
 * out of the Tab order.
 */
export function focusPageStart(root: ParentNode): void {
  const target =
    root.querySelector<HTMLElement>('[data-route-focus]') ??
    root.querySelector<HTMLElement>('h1') ??
    root.querySelector<HTMLElement>('main');
  if (!target) return;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}
