import { validate } from '@keel/shared';
import type { FastifyBaseLogger } from 'fastify';
import { readRoom } from '../collab/room-reader.ts';
import type { RoomManager } from '../collab/room-manager.ts';
import { evaluateAlerts, type EvaluateResult } from './evaluate.ts';
import type { Send } from './notifiers.ts';
import type { AlertStore } from './store.ts';

export interface AlertWorkerOptions {
  store: AlertStore;
  rooms: RoomManager;
  send: Send;
  log: FastifyBaseLogger;
  /** Builds the link in each notification. */
  roomUrl: (roomId: string) => string;
  /** Short log tag for a room; raw ids are capabilities and stay out of logs. */
  roomTag: (roomId: string) => string;
  /** Evaluate every configured room this often, which is what catches evidence going stale. */
  sweepIntervalMs: number;
  /** Coalesce bursts of pushes to one room into one evaluation. */
  debounceMs: number;
  now?: () => number;
}

/**
 * The background half of alerting, in-process.
 *
 * Two triggers: an observations push to a room (debounced, so a collector
 * pushing two sources at once is one evaluation), and a periodic sweep over
 * every configured room. The sweep matters because the most important drift of
 * all, a collector going silent, produces no push to react to; only time
 * passing turns its evidence stale.
 *
 * Evaluations of one room are serialised, so two can never interleave their
 * read-modify-write of that room's alert state.
 */
export class AlertWorker {
  readonly #options: AlertWorkerOptions;
  readonly #now: () => number;
  readonly #pending = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #chains = new Map<string, Promise<unknown>>();
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;

  constructor(options: AlertWorkerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  start(): void {
    this.#sweepTimer = setInterval(() => void this.sweep(), this.#options.sweepIntervalMs);
    this.#sweepTimer.unref?.();
  }

  /** A room's evidence changed. Evaluate it soon, once. */
  notify(roomId: string): void {
    if (this.#stopped) return;
    const existing = this.#pending.get(roomId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#pending.delete(roomId);
      void this.evaluate(roomId).catch(() => undefined);
    }, this.#options.debounceMs);
    timer.unref?.();
    this.#pending.set(roomId, timer);
  }

  async sweep(): Promise<void> {
    if (this.#stopped) return;
    const roomIds = await this.#options.store.listConfiguredRooms();
    // Sequential: a sweep over many rooms must not open them all at once.
    for (const roomId of roomIds) {
      if (this.#stopped) return;
      await this.evaluate(roomId).catch(() => undefined);
    }
  }

  /** Evaluate one room now. Resolves with what was delivered, or null if the room has no alerting. */
  evaluate(roomId: string): Promise<EvaluateResult | null> {
    const previous = this.#chains.get(roomId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.#evaluate(roomId));
    const settled = run.catch(() => undefined);
    this.#chains.set(roomId, settled);
    void settled.then(() => {
      if (this.#chains.get(roomId) === settled) this.#chains.delete(roomId);
    });
    return run;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    for (const timer of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
    await Promise.allSettled([...this.#chains.values()]);
  }

  async #evaluate(roomId: string): Promise<EvaluateResult | null> {
    const { store, rooms, send, log } = this.#options;
    const config = await store.getConfig(roomId);
    if (!config) return null;

    const now = this.#now();
    const { graph, observations, intent, ruleSettings, labels } = await rooms.read(roomId, readRoom);
    // Tuned like the canvas: a muted rule or a finding labelled noise never pages.
    const report = validate(graph, { observations, intent, now, ruleSettings, labels });

    const result = await evaluateAlerts({
      roomId,
      roomUrl: this.#options.roomUrl(roomId),
      config,
      findings: report.findings,
      state: await store.getState(roomId),
      now,
      send,
    });
    await store.saveState(roomId, result.state);

    const room = this.#options.roomTag(roomId);
    for (const delivery of result.sent) log.info({ room, ...delivery }, 'alert delivered');
    for (const failure of result.failed) log.warn({ room, ...failure }, 'alert delivery failed; will retry');
    return result;
  }
}
