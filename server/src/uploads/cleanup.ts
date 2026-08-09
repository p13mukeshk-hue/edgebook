import { loadStorageCleanupConfig } from "../config.js";
import { createDatabase } from "../db/database.js";
import { LocalScreenshotStorage } from "./storage.js";

type QueueRow = { id: string; storage_key: string; attempts: number };

async function cleanup(): Promise<void> {
  const config = loadStorageCleanupConfig();
  const database = createDatabase(config);
  const storage = new LocalScreenshotStorage(config);
  await storage.ensureRoot();
  let cleaned = 0;

  try {
    for (;;) {
      const claimed = await database.query<QueueRow>(
        `UPDATE file_deletion_queue q SET
           attempts=q.attempts+1,
           not_before=now()+interval '5 minutes'
         WHERE q.id IN (
           SELECT id FROM file_deletion_queue
           WHERE completed_at IS NULL AND not_before <= now()
           ORDER BY id ASC FOR UPDATE SKIP LOCKED LIMIT 100
         )
         RETURNING id,storage_key,attempts`,
      );
      if (claimed.rows.length === 0) break;
      for (const row of claimed.rows) {
        try {
          await storage.remove(row.storage_key);
          await database.query(
            "UPDATE file_deletion_queue SET completed_at=now(),last_error=NULL WHERE id=$1",
            [row.id],
          );
          cleaned += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 2_000) : "Unknown cleanup error";
          const delayMinutes = Math.min(24 * 60, 2 ** Math.min(row.attempts, 10));
          await database.query(
            `UPDATE file_deletion_queue SET last_error=$2,
               not_before=now()+($3::int * interval '1 minute')
             WHERE id=$1`,
            [row.id, message, delayMinutes],
          );
        }
      }
    }
  } finally {
    await database.end();
  }
  console.info(`Screenshot cleanup complete: ${cleaned} file(s) removed`);
}

cleanup().catch((error: unknown) => {
  console.error("Screenshot cleanup failed", error);
  process.exitCode = 1;
});
