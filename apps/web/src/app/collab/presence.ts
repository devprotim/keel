/** Identity a peer publishes over awareness. */
export interface PeerState {
  name: string;
  /** World-space pointer position, or null when the pointer left the canvas. */
  cursor: { x: number; y: number } | null;
  selection: string[];
}

export interface Peer extends PeerState {
  clientId: number;
}

const STORAGE_KEY = 'keel:display-name';

const ADJECTIVES = ['Swift', 'Quiet', 'Bright', 'Steady', 'Clever', 'Bold', 'Calm', 'Keen'];
const ANIMALS = ['Heron', 'Otter', 'Falcon', 'Marten', 'Ibis', 'Lynx', 'Grebe', 'Shrike'];

/**
 * A stable display name for this browser.
 *
 * Persisted so a reload does not turn you into a different person mid-session,
 * which is disorienting for everyone else in the room. Anonymous by design:
 * there are no accounts, and inventing one to show a name would be a much larger
 * feature than the presence layer needs.
 */
export function loadDisplayName(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;

    const generated = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
    localStorage.setItem(STORAGE_KEY, generated);
    return generated;
  } catch {
    // Private browsing, or storage disabled entirely. A name that does not
    // survive reload is much better than a canvas that fails to load.
    return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  }
}

export function saveDisplayName(name: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Nothing to do; the name simply will not persist.
  }
}

function pick(values: readonly string[]): string {
  return values[Math.floor(Math.random() * values.length)]!;
}

/** Narrow an untrusted awareness payload from a peer. */
export function readPeerState(clientId: number, raw: unknown): Peer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;

  const name = typeof value['name'] === 'string' ? value['name'] : null;
  if (name === null) return null;

  const rawCursor = value['cursor'];
  let cursor: { x: number; y: number } | null = null;
  if (typeof rawCursor === 'object' && rawCursor !== null) {
    const point = rawCursor as Record<string, unknown>;
    if (typeof point['x'] === 'number' && typeof point['y'] === 'number') {
      cursor = { x: point['x'], y: point['y'] };
    }
  }

  const rawSelection = value['selection'];
  const selection = Array.isArray(rawSelection)
    ? rawSelection.filter((id): id is string => typeof id === 'string')
    : [];

  return { clientId, name, cursor, selection };
}
