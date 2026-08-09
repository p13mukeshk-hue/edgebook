#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
const schema = await readFile(new URL('../postgres/staging-schema.sql', import.meta.url), 'utf8');
const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('edgebook:migration-staging-schema'))");
  await client.query("SET statement_timeout = '2min'");
  await client.query(schema);
  process.stdout.write('Migration staging schema is ready.\n');
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('edgebook:migration-staging-schema'))").catch(() => {});
  await client.end();
}
