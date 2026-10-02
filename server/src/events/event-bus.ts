import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";
import type { Database } from "../db/database.js";

export type UserEvent = {
  id: number;
  userId: string;
  type: string;
  payload: unknown;
  occurredAt: string;
};

export interface EventBus {
  start(): Promise<void>;
  stop(): Promise<void>;
  publish(userId: string, type: string, payload: unknown): Promise<UserEvent>;
  replay(userId: string, afterId: number, limit?: number): Promise<UserEvent[]>;
  subscribe(userId: string, listener: (event: UserEvent) => void): () => void;
}

type EventRow = {
  id: string;
  user_id: string;
  event_type: string;
  payload: unknown;
  occurred_at: Date | string;
};

function mapEvent(row: EventRow): UserEvent {
  return {
    id: Number(row.id),
    userId: row.user_id,
    type: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : new Date(row.occurred_at).toISOString(),
  };
}

export class PostgresEventBus implements EventBus {
  readonly #emitter = new EventEmitter();
  #listenerClient: PoolClient | null = null;
  #stopping = false;
  #reconnectTimer: NodeJS.Timeout | null = null;

  public constructor(private readonly database: Database) {
    this.#emitter.setMaxListeners(0);
  }

  public async start(): Promise<void> {
    this.#stopping = false;
    await this.#connectListener();
  }

  async #connectListener(): Promise<void> {
    if (this.#stopping || this.#listenerClient) return;
    try {
      const client = await this.database.connect();
      this.#listenerClient = client;
      client.on("notification", (message) => {
        if (message.channel !== "edgebook_events" || !message.payload) return;
        const id = Number(message.payload);
        if (!Number.isSafeInteger(id)) return;
        void this.#fetchAndEmit(id);
      });
      client.on("error", () => this.#scheduleReconnect(client));
      client.on("end", () => this.#scheduleReconnect(client));
      await client.query("LISTEN edgebook_events");
    } catch {
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(client?: PoolClient): void {
    if (client && this.#listenerClient !== client) return;
    if (this.#listenerClient) {
      this.#listenerClient.release(true);
      this.#listenerClient = null;
    }
    if (this.#stopping || this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connectListener();
    }, 1_000);
    this.#reconnectTimer.unref();
  }

  async #fetchAndEmit(id: number): Promise<void> {
    const result = await this.database.query<EventRow>(
      `SELECT id, user_id, event_type, payload, occurred_at
       FROM user_events WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row) this.#emitter.emit(row.user_id, mapEvent(row));
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    if (this.#listenerClient) {
      const client = this.#listenerClient;
      this.#listenerClient = null;
      await client.query("UNLISTEN edgebook_events").catch(() => undefined);
      client.release();
    }
    this.#emitter.removeAllListeners();
  }

  public async publish(userId: string, type: string, payload: unknown): Promise<UserEvent> {
    const result = await this.database.query<EventRow>(
      `WITH inserted AS (
         INSERT INTO user_events (user_id, event_type, payload)
         VALUES ($1, $2, $3::jsonb)
         RETURNING id, user_id, event_type, payload, occurred_at
       )
       SELECT inserted.*, pg_notify('edgebook_events', inserted.id::text)
       FROM inserted`,
      [userId, type, JSON.stringify(payload)],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to persist user event");
    return mapEvent(row);
  }

  public async replay(userId: string, afterId: number, limit = 500): Promise<UserEvent[]> {
    const result = await this.database.query<EventRow>(
      `SELECT id, user_id, event_type, payload, occurred_at
       FROM user_events
       WHERE user_id = $1 AND id > $2
       ORDER BY id ASC
       LIMIT $3`,
      [userId, afterId, Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map(mapEvent);
  }

  public subscribe(userId: string, listener: (event: UserEvent) => void): () => void {
    this.#emitter.on(userId, listener);
    return () => this.#emitter.off(userId, listener);
  }
}
