import { TestBed } from '@angular/core/testing';
import { type ActivatedRouteSnapshot, Router, type ViewTransitionInfo } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onViewTransitionCreated, pathOf } from './view-transitions';

/** A root snapshot whose single leaf matched `path` ('' for the landing page). */
function snapshot(path: string): ActivatedRouteSnapshot {
  const root = { url: [], firstChild: null, pathFromRoot: [] } as unknown as ActivatedRouteSnapshot;
  const leaf = {
    url: path ? path.split('/').map((p) => ({ path: p })) : [],
    firstChild: null,
    pathFromRoot: [root],
  } as unknown as ActivatedRouteSnapshot;
  Object.assign(root, { firstChild: leaf, pathFromRoot: [root] });
  (leaf.pathFromRoot as ActivatedRouteSnapshot[]).push(leaf);
  return root;
}

function run(from: string, to: string, trigger: 'imperative' | 'popstate' = 'imperative') {
  const skipTransition = vi.fn();
  TestBed.configureTestingModule({
    providers: [{ provide: Router, useValue: { currentNavigation: () => ({ trigger }) } }],
  });
  const info = { transition: { skipTransition }, from: snapshot(from), to: snapshot(to) } as unknown as ViewTransitionInfo;
  TestBed.runInInjectionContext(() => onViewTransitionCreated(info));
  return skipTransition;
}

function preferReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce') }));
}

describe('route view transitions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('reads the path a snapshot resolves to', () => {
    expect(pathOf(snapshot(''))).toBe('');
    expect(pathOf(snapshot('invite/abc'))).toBe('invite/abc');
  });

  it('cross-fades between different pages', () => {
    preferReducedMotion(false);
    expect(run('', 'r7kq2m9x')).not.toHaveBeenCalled();
  });

  it('skips for reduced motion', () => {
    preferReducedMotion(true);
    expect(run('', 'r7kq2m9x')).toHaveBeenCalledOnce();
  });

  it('skips back and forward navigations, which the browser animates itself', () => {
    preferReducedMotion(false);
    expect(run('r7kq2m9x', '', 'popstate')).toHaveBeenCalledOnce();
  });

  it('skips when only query params or the fragment change', () => {
    preferReducedMotion(false);
    expect(run('', '')).toHaveBeenCalledOnce();
  });
});
