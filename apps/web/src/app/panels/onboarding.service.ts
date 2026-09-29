import { Injectable, signal } from '@angular/core';

type Milestone = 'read-finding' | 'shared';

interface Stored {
  dismissed: boolean;
  seen: Milestone[];
}

/**
 * First-run progress for things the room itself cannot show: whether this
 * person has opened the review dock or shared the room. Everything else the
 * checklist reads from the room (nodes, edges, a baseline, live data).
 *
 * Per browser, in localStorage: it is a convenience, and losing it just shows
 * the checklist again.
 */
@Injectable({ providedIn: 'root' })
export class OnboardingService {
  readonly #state = signal<Stored>(load());
  readonly dismissed = () => this.#state().dismissed;

  has(milestone: Milestone): boolean {
    return this.#state().seen.includes(milestone);
  }

  mark(milestone: Milestone): void {
    if (this.has(milestone)) return;
    this.#update({ ...this.#state(), seen: [...this.#state().seen, milestone] });
  }

  dismiss(): void {
    this.#update({ ...this.#state(), dismissed: true });
  }

  #update(next: Stored): void {
    this.#state.set(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable: progress lasts for this visit only.
    }
  }
}

const KEY = 'keel:onboarding';

function load(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Stored> | null;
    return {
      dismissed: raw?.dismissed === true,
      seen: Array.isArray(raw?.seen) ? raw.seen.filter((m): m is Milestone => m === 'read-finding' || m === 'shared') : [],
    };
  } catch {
    return { dismissed: false, seen: [] };
  }
}
