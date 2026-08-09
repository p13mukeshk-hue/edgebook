import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PoolClient, QueryResultRow } from "pg";
import { loadConfig, type AppConfig } from "../config.js";
import { createDatabase, type Database } from "../db/database.js";
import { PostgresEventBus } from "../events/event-bus.js";
import { OfficialCTraderGateway } from "./client.js";
import { AesGcmTokenCipher } from "./crypto.js";
import { OfficialCTraderOAuthClient } from "./oauth.js";
import { CTraderSyncEngine, CTraderSyncError } from "./sync.js";

type QueuedRun = QueryResultRow & {
  id: string;
  broker_connection_id: string;
  attempt_count: number;
};

type Logger = Pick<Console, "info" | "warn" | "error">;

const GLOBAL_LOCK_SQL = "SELECT pg_try_advisory_lock(hashtext('edgebook:ctrader:worker')) AS acquired";
const GLOBAL_UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('edgebook:ctrader:worker'))";

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", aborted);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const aborted = () => {
      clearTimeout(timer);
      finish();
    };
    signal.addEventListener("abort", aborted, { once: true });
    timer.unref();
  });
}

function safeError(error: unknown): { code: string; message: string; retryable: boolean; requiresReauth: boolean } {
  if (error instanceof CTraderSyncError) {
    return {
      code: error.code.slice(0, 200),
      message: error.message.slice(0, 2_000),
      retryable: error.retryable,
      requiresReauth: error.requiresReauth,
    };
  }
  return {
    code: "CTRADER_WORKER_FAILED",
    message: (error instanceof Error ? error.message : "The cTrader worker failed").slice(0, 2_000),
    retryable: false,
    requiresReauth: false,
  };
}

export class CTraderWorker {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly engine: CTraderSyncEngine,
    private readonly logger: Logger = console,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let lockClient: PoolClient | null = null;
      try {
        lockClient = await this.database.connect();
        const lock = await lockClient.query<{ acquired: boolean }>(GLOBAL_LOCK_SQL);
        if (!lock.rows[0]?.acquired) {
          lockClient.release();
          lockClient = null;
          await delay(15_000, signal);
          continue;
        }
        this.logger.info("cTrader worker acquired the single-writer lock");
        await this.activeLoop(lockClient, signal);
      } catch (error) {
        const safe = safeError(error);
        this.logger.error(`cTrader worker loop error [${safe.code}]: ${safe.message}`);
        await delay(5_000, signal);
      } finally {
        if (lockClient) {
          await lockClient.query(GLOBAL_UNLOCK_SQL).catch(() => undefined);
          lockClient.release();
        }
      }
    }
  }

  private async activeLoop(lockClient: PoolClient, signal: AbortSignal): Promise<void> {
    let lastMaintenance = 0;
    while (!signal.aborted) {
      const now = Date.now();
      if (now - lastMaintenance >= 15_000) {
        // A session advisory lock disappears with its PostgreSQL connection.
        // Ping the lock-owning session before each maintenance cycle so a lost
        // connection cannot leave this process acting as a second writer.
        await lockClient.query("SELECT 1");
        await this.recoverStaleRuns();
        if (this.config.cTrader.schedulerEnabled) await this.enqueueScheduledRuns();
        lastMaintenance = now;
      }
      const run = await this.claimNextRun();
      if (!run) {
        await delay(2_000, signal);
        continue;
      }
      const connectionLock = await lockClient.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [run.broker_connection_id],
      );
      if (!connectionLock.rows[0]?.acquired) {
        await this.requeueLockContention(run.id);
        continue;
      }
      try {
        await this.executeRun(run, lockClient);
      } finally {
        await lockClient.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [run.broker_connection_id],
        ).catch(() => undefined);
      }
    }
  }

  private async enqueueScheduledRuns(): Promise<void> {
    const due = await this.database.query<{ id: string }>(
      `SELECT c.id
       FROM broker_connections c
       WHERE c.provider='ctrader' AND c.oauth_scope='accounts'
         AND c.provider_environment IS NOT NULL AND c.connected=true
         AND c.access_token_ciphertext IS NOT NULL
         AND c.refresh_token_ciphertext IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM sync_runs active
           WHERE active.broker_connection_id=c.id
             AND active.status IN ('queued','running')
         )
         AND COALESCE(c.last_sync_at, c.connected_at, c.created_at)
             <= now() - ($1::int * interval '1 second')
       ORDER BY COALESCE(c.last_sync_at, c.connected_at, c.created_at) ASC
       LIMIT 100`,
      [this.config.cTrader.syncIntervalSeconds],
    );
    const bucket = Math.floor(Date.now() / (this.config.cTrader.syncIntervalSeconds * 1_000));
    for (const connection of due.rows) {
      await this.database.query(
        `INSERT INTO sync_runs (
           id, broker_connection_id, job_key, sync_type, status, counters
         ) VALUES ($1,$2,$3,'automatic','queued','{}'::jsonb)
         ON CONFLICT DO NOTHING`,
        [randomUUID(), connection.id, `automatic:${bucket}`],
      );
    }
  }

  private async claimNextRun(): Promise<QueuedRun | null> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const queued = await client.query<QueuedRun>(
        `SELECT sr.id, sr.broker_connection_id, sr.attempt_count
         FROM sync_runs sr
         JOIN broker_connections c ON c.id=sr.broker_connection_id
         WHERE sr.status='queued' AND sr.not_before <= now()
           AND c.provider='ctrader' AND c.oauth_scope='accounts'
           AND c.provider_environment IS NOT NULL AND c.connected=true
         ORDER BY sr.started_at ASC, sr.id ASC
         FOR UPDATE OF sr SKIP LOCKED
         LIMIT 1`,
      );
      const run = queued.rows[0];
      if (!run) {
        await client.query("COMMIT");
        return null;
      }
      const claimed = await client.query<QueuedRun>(
        `UPDATE sync_runs SET status='running', attempt_count=attempt_count+1,
           claimed_at=now(), heartbeat_at=now(), finished_at=NULL,
           error_code=NULL, error_message=NULL
         WHERE id=$1
         RETURNING id, broker_connection_id, attempt_count`,
        [run.id],
      );
      await client.query("COMMIT");
      return claimed.rows[0] ?? null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async executeRun(run: QueuedRun, lockClient: PoolClient): Promise<void> {
    let heartbeatBusy = false;
    const heartbeat = async (): Promise<void> => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      try {
        // Prove that the session holding both advisory locks is still alive.
        // If it was severed, the next in-band heartbeat aborts the import
        // before another worker can persist concurrently under a new lock.
        await lockClient.query("SELECT 1");
        await this.database.query(
          "UPDATE sync_runs SET heartbeat_at=now() WHERE id=$1 AND status='running'",
          [run.id],
        );
      } finally {
        heartbeatBusy = false;
      }
    };
    const timer = setInterval(() => void heartbeat().catch(() => undefined), 30_000);
    timer.unref();
    try {
      const result = await this.engine.syncConnection(run.broker_connection_id, heartbeat);
      await this.database.query(
        `UPDATE sync_runs SET status='succeeded', cursor_before=$1::jsonb,
           cursor_after=$2::jsonb, counters=$3::jsonb, heartbeat_at=now(),
           finished_at=now(), error_code=NULL, error_message=NULL
         WHERE id=$4 AND status='running'`,
        [JSON.stringify(result.cursorBefore), JSON.stringify(result.cursorAfter), JSON.stringify(result.counters), run.id],
      );
      this.logger.info(`cTrader sync ${run.id} succeeded for connection ${run.broker_connection_id}`);
    } catch (error) {
      const safe = safeError(error);
      if (safe.requiresReauth) await this.markReauthRequired(run.broker_connection_id, safe);
      if (safe.retryable && run.attempt_count < 3) {
        const retrySeconds = Math.min(300, 15 * 2 ** Math.max(0, run.attempt_count - 1));
        await this.database.query(
          `UPDATE sync_runs SET status='queued', not_before=now()+($1::int*interval '1 second'),
             claimed_at=NULL, heartbeat_at=NULL, error_code=$2, error_message=$3
           WHERE id=$4 AND status='running'`,
          [retrySeconds, safe.code, safe.message, run.id],
        );
        this.logger.warn(`cTrader sync ${run.id} will retry after ${safe.code}`);
      } else {
        await this.database.query(
          `UPDATE sync_runs SET status='failed', heartbeat_at=now(), finished_at=now(),
             error_code=$1, error_message=$2
           WHERE id=$3 AND status='running'`,
          [safe.code, safe.message, run.id],
        );
        await this.database.query(
          `UPDATE broker_connections SET
             provider_metadata=(provider_metadata - 'lastErrorCode' - 'lastErrorMessage')
               || jsonb_build_object('lastErrorCode',$1::text,'lastErrorMessage',$2::text)
           WHERE id=$3`,
          [safe.code, safe.message, run.broker_connection_id],
        );
        this.logger.error(`cTrader sync ${run.id} failed [${safe.code}]: ${safe.message}`);
      }
    } finally {
      clearInterval(timer);
    }
  }

  private async markReauthRequired(
    connectionId: string,
    error: { code: string; message: string },
  ): Promise<void> {
    await this.database.query(
      `UPDATE broker_connections SET
         connected=false,
         access_token_ciphertext=NULL,
         refresh_token_ciphertext=NULL,
         encryption_key_version=NULL,
         token_expires_at=NULL,
         token_generation=token_generation+1,
         disconnected_at=now(),
         disconnect_reason='authorization',
         provider_metadata=(provider_metadata - 'lastErrorCode' - 'lastErrorMessage')
           || jsonb_build_object(
             'reauthRequired',true,
             'lastErrorCode',$1::text,
             'lastErrorMessage',$2::text
           )
       WHERE id=$3`,
      [error.code, error.message, connectionId],
    );
  }

  private async requeueLockContention(runId: string): Promise<void> {
    await this.database.query(
      `UPDATE sync_runs SET status='queued', claimed_at=NULL, heartbeat_at=NULL,
         not_before=now()+interval '5 seconds',
         error_code='CONNECTION_BUSY', error_message='Another worker is syncing this connection'
       WHERE id=$1 AND status='running'`,
      [runId],
    );
  }

  private async recoverStaleRuns(): Promise<void> {
    await this.database.query(
      `UPDATE ctrader_oauth_grants SET
         access_token_ciphertext='', refresh_token_ciphertext='', consumed_at=COALESCE(consumed_at, now())
       WHERE expires_at <= now()
         AND (access_token_ciphertext <> '' OR refresh_token_ciphertext <> '')`,
    );
    await this.database.query(
      `DELETE FROM oauth_transactions
       WHERE provider='ctrader' AND expires_at < now()-interval '1 day'`,
    );
    const recovered = await this.database.query<{ id: string }>(
      `UPDATE sync_runs SET
         status=CASE WHEN attempt_count < 3 THEN 'queued' ELSE 'failed' END,
         not_before=now()+interval '5 seconds',
         claimed_at=NULL,
         heartbeat_at=NULL,
         finished_at=CASE WHEN attempt_count < 3 THEN NULL ELSE now() END,
         error_code='STALE_WORKER_RECOVERED',
         error_message=CASE WHEN attempt_count < 3
           THEN 'The previous worker stopped; the sync was safely requeued'
           ELSE 'The sync worker stopped repeatedly; manual attention is required'
         END
       WHERE status='running'
         AND COALESCE(heartbeat_at, claimed_at, started_at)
           < now()-($1::int*interval '1 second')
       RETURNING id`,
      [this.config.cTrader.staleAfterSeconds],
    );
    if (recovered.rows.length > 0) {
      this.logger.warn(`Recovered ${recovered.rows.length} stale cTrader sync run(s)`);
    }
    await this.database.query(
      `UPDATE sync_runs sr SET status='cancelled', finished_at=now(),
         error_code='DISCONNECTED', error_message='The cTrader connection is disconnected'
       FROM broker_connections c
       WHERE sr.broker_connection_id=c.id AND sr.status='queued'
         AND c.provider='ctrader' AND c.connected=false`,
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.cTrader.enabled) throw new Error("The cTrader worker requires a complete cTrader configuration");
  const database = createDatabase(config);
  const events = new PostgresEventBus(database);
  const oauth = new OfficialCTraderOAuthClient(config.cTrader);
  const gateway = new OfficialCTraderGateway(config.cTrader);
  const cipher = AesGcmTokenCipher.fromConfig(config.cTrader);
  const engine = new CTraderSyncEngine(database, config, oauth, gateway, cipher, events);
  const worker = new CTraderWorker(database, config, engine);
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  try {
    await worker.run(controller.signal);
  } finally {
    await events.stop().catch(() => undefined);
    await database.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    console.error("cTrader worker stopped", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });
}
