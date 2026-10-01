import { inject } from '@angular/core';
import { type ActivatedRouteSnapshot, Router, type ViewTransitionInfo } from '@angular/router';

/**
 * Decides, per navigation, whether the route cross-fade (styles/_motion.scss)
 * runs. It is skipped when:
 *
 * - the user prefers reduced motion (skipped outright rather than shortened);
 * - the navigation is back/forward: Safari and mobile browsers already animate
 *   the swipe, and ours would play on top of theirs;
 * - only query params or the fragment change (`?pitch=` on the landing page):
 *   the page is the same one, so there is nothing to fade between.
 */
export function onViewTransitionCreated({ transition, from, to }: ViewTransitionInfo): void {
  const router = inject(Router);
  const popstate = router.currentNavigation()?.trigger === 'popstate';
  if (prefersReducedMotion() || popstate || pathOf(from) === pathOf(to)) {
    transition.skipTransition();
  }
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The URL path a root snapshot resolves to, without query params or fragment. */
export function pathOf(root: ActivatedRouteSnapshot): string {
  let leaf = root;
  while (leaf.firstChild) leaf = leaf.firstChild;
  return leaf.pathFromRoot
    .flatMap((r) => r.url)
    .map((segment) => segment.path)
    .join('/');
}
