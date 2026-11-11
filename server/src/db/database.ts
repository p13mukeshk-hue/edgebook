import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { DatabaseConfig } from "../config.js";

const { Pool } = pg;

export interface Database {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

export function createDatabase(config: DatabaseConfig): Database {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    application_name: "edgebook-api",
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on("error", (error) => {
    // A checked-out client surfaces errors to its caller. This handler prevents
    // an idle-client error from terminating the process without a useful log.
    console.error("Unexpected PostgreSQL pool error", error);
  });

  return pool;
}

export async function withTransaction<T>(database: Database, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
