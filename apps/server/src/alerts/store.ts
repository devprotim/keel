import type { SqlDatabase } from '../store/sql.ts';
import type { AlertConfig } from './config.ts';

export type Channel = 'slack' | 'pagerduty';

/** One open alert: a finding that fired and has not yet been resolved. */
export interface AlertState {
  ruleId: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  nodeIds: string[];
  edgeIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  /** Channels that have been told about it, so a retry never notifies twice. */
  delivered: Channel[];
}

/** Keyed by alert key (rule plus cited ids). */
export type RoomAlertState = Record<string, AlertState>;

export interface AlertStore {
  getConfig(roomId: string): Promise<AlertConfig | null>;
  putConfig(roomId: string, config: AlertConfig): Promise<void>;
  /** Also forgets open alerts, so re-enabling later starts clean. */
  deleteConfig(roomId: string): Promise<void>;
  listConfiguredRooms(): Promise<string[]>;
  getState(roomId: string): Promise<RoomAlertState>;
  /** Replace the room's open alerts wholesale. */
  saveState(roomId: string, state: RoomAlertState): Promise<void>;
}

export class MemoryAlertStore implements AlertStore {
  readonly #configs = new Map<string, AlertConfig>();
  readonly #states = new Map<string, RoomAlertState>();

  async getConfig(roomId: string): Promise<AlertConfig | null> {
    return structuredClone(this.#configs.get(roomId) ?? null);
  }
  async putConfig(roomId: string, config: AlertConfig): Promise<void> {
    this.#configs.set(roomId, structuredClone(config));
  }
  async deleteConfig(roomId: string): Promise<void> {
    this.#configs.delete(roomId);
    this.#states.delete(roomId);
  }
  async listConfiguredRooms(): Promise<string[]> {
    return [...this.#configs.keys()].sort();
  }
  async getState(roomId: string): Promise<RoomAlertState> {
    return structuredClone(this.#states.get(roomId) ?? {});
  }
  async saveState(roomId: string, state: RoomAlertState): Promise<void> {
    this.#states.set(roomId, structuredClone(state));
  }
}

/**
 * Alert configuration and open alerts in Postgres (migration 2).
 *
 * Open alerts are persisted, not just held in memory, because a restart that
 * forgot them would re-page on-call for every finding that is still true.
 */
export class PostgresAlertStore implements AlertStore {
  readonly #db: SqlDatabase;

  /** Shares the doc store's database; migrations have already run. */
  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  async getConfig(roomId: string): Promise<AlertConfig | null> {
    const { rows } = await this.#db.query<{ config: AlertConfig | string }>(
      'SELECT config FROM room_alert_configs WHERE room_id = $1',
      [roomId],
    );
    const raw = rows[0]?.config;
    if (raw === undefined) return null;
    return typeof raw === 'string' ? (JSON.parse(raw) as AlertConfig) : raw;
  }

  async putConfig(roomId: string, config: AlertConfig): Promise<void> {
    await this.#db.transaction(async (tx) => {
      // The config hangs off the room row, so deleting a room deletes its alerting.
      await tx.query('INSERT INTO rooms (room_id) VALUES ($1) ON CONFLICT (room_id) DO NOTHING', [roomId]);
      await tx.query(
        `INSERT INTO room_alert_configs (room_id, config) VALUES ($1, $2)
         ON CONFLICT (room_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
        [roomId, JSON.stringify(config)],
      );
    });
  }

  async deleteConfig(roomId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.query('DELETE FROM room_alert_configs WHERE room_id = $1', [roomId]);
      await tx.query('DELETE FROM room_alert_state WHERE room_id = $1', [roomId]);
    });
  }

  async listConfiguredRooms(): Promise<string[]> {
    const { rows } = await this.#db.query<{ room_id: string }>('SELECT room_id FROM room_alert_configs ORDER BY room_id');
    return rows.map((row) => row.room_id);
  }

  async getState(roomId: string): Promise<RoomAlertState> {
    const { rows } = await this.#db.query<{ state: RoomAlertState | string }>(
      'SELECT state FROM room_alert_state WHERE room_id = $1',
      [roomId],
    );
    const raw = rows[0]?.state;
    if (raw === undefined) return {};
    return typeof raw === 'string' ? (JSON.parse(raw) as RoomAlertState) : raw;
  }

  async saveState(roomId: string, state: RoomAlertState): Promise<void> {
    await this.#db.query(
      `INSERT INTO room_alert_state (room_id, state) VALUES ($1, $2)
       ON CONFLICT (room_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [roomId, JSON.stringify(state)],
    );
  }
}
