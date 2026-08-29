import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadDatabaseConfig } from "../config.js";
import { createDatabase } from "./database.js";

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

async function migrate(): Promise<void> {
  const config = loadDatabaseConfig();
  const database = createDatabase(config);
  const client = await database.connect();

  try {
    await client.query("SELECT pg_advisory_lock(hashtext('edgebook:migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right));

    const appliedResult = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(appliedResult.rows.map((row) => row.name));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8");
      console.info(`Applying migration ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('edgebook:migrations'))").catch(() => undefined);
    client.release();
    await database.end();
  }
}

migrate().catch((error: unknown) => {
  console.error("Database migration failed", error);
  process.exitCode = 1;
});
