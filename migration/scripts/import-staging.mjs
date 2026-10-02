#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import pg from 'pg';
import {
  canonicalJson,
  findForbiddenCredentialPaths,
  parseArgs,
  readNdjson,
  resolveContainedRegularFile,
  sha256File,
  sha256Text,
} from '../lib/bundle.mjs';

function usage(message) {
  if (message) process.stderr.write(`ERROR: ${message}\n\n`);
  process.stderr.write(`Usage:
  Dry-run: node scripts/import-staging.mjs --bundle /absolute/export
  Apply:   EDGEBOOK_WRITES_FROZEN=true MIGRATION_DATABASE_URL=... \\
           node scripts/import-staging.mjs --bundle /absolute/export \\
             --apply --acknowledge SINGLE_WRITER_FROZEN [--batch-id UUID]

Apply writes only to the edgebook_migration staging schema. It never promotes,
updates, or deletes application records.
`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
if (!args.bundle || args.bundle === true || !isAbsolute(args.bundle)) usage('--bundle must be absolute');
const bundle = await realpath(resolve(args.bundle));
const manifest = JSON.parse(await readFile(await resolveContainedRegularFile(bundle, 'manifest.json'), 'utf8'));

if (manifest.formatVersion !== 1) throw new Error(`unsupported bundle formatVersion ${manifest.formatVersion}`);
const requiredManifestFiles = ['auth-users.ndjson', 'firestore.ndjson', 'storage.ndjson'];
if (canonicalJson(Object.keys(manifest.files || {}).sort()) !== canonicalJson([...requiredManifestFiles].sort())) {
  throw new Error(`manifest files must be exactly: ${requiredManifestFiles.join(', ')}`);
}
const bundleFiles = new Map();
for (const name of requiredManifestFiles) {
  const expected = manifest.files[name];
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error(`invalid manifest checksum for ${name}`);
  const file = await resolveContainedRegularFile(bundle, name);
  bundleFiles.set(name, file);
  const actual = await sha256File(file);
  if (actual !== expected) throw new Error(`checksum mismatch for ${name}`);
}

const documents = [];
const identities = [];
const objects = [];
const documentPaths = new Set();
const identityUids = new Set();
const objectNames = new Set();
const objectPaths = new Set();
for await (const { value } of readNdjson(bundleFiles.get('firestore.ndjson'))) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.path || documentPaths.has(value.path) || !/^users\/[^/]+(?:\/[^/]+\/[^/]+)*$/.test(value.path) ||
      !value.data || typeof value.data !== 'object' || Array.isArray(value.data) || /(^|\/)pendingAuth(?:\/|$)/.test(value.path)) {
    throw new Error(`invalid, duplicate, or forbidden Firestore document: ${value.path || '<missing>'}`);
  }
  documentPaths.add(value.path);
  const forbidden = findForbiddenCredentialPaths(value.data);
  if (forbidden.length) throw new Error(`${value.path} contains forbidden credentials: ${forbidden.join(', ')}`);
  documents.push(value);
}
for await (const { value } of readNdjson(bundleFiles.get('auth-users.ndjson'))) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.uid || identityUids.has(value.uid)) {
    throw new Error(`invalid, duplicate or missing Auth uid: ${value?.uid || '<missing>'}`);
  }
  identityUids.add(value.uid);
  const forbidden = findForbiddenCredentialPaths(value);
  if (forbidden.length) throw new Error(`Auth identity ${value.uid || '<missing>'} contains forbidden credentials: ${forbidden.join(', ')}`);
  const googleSub = value.providers?.find((provider) => provider.providerId === 'google.com')?.uid;
  if (!value.email || value.emailVerified !== true || !googleSub) {
    throw new Error(`Auth identity ${value.uid} must have a verified email and immutable google.com provider uid`);
  }
  identities.push(value);
}
for await (const { value } of readNdjson(bundleFiles.get('storage.ndjson'))) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.name || objectNames.has(value.name) || objectPaths.has(value.localPath) ||
      !/^users\/[^/]+\/screenshots\/.+/.test(value.name) || value.localPath !== `storage/${value.name}` ||
      !/^[a-f0-9]{64}$/.test(value.sha256 || '') || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error(`invalid or duplicate Storage record: ${value.name || '<missing>'}`);
  }
  const forbidden = findForbiddenCredentialPaths(value);
  if (forbidden.length) throw new Error(`Storage object ${value.name} contains forbidden credentials: ${forbidden.join(', ')}`);
  objectNames.add(value.name); objectPaths.add(value.localPath);
  const objectPath = await resolveContainedRegularFile(bundle, value.localPath);
  if (await sha256File(objectPath) !== value.sha256 || (await stat(objectPath)).size !== value.size) {
    throw new Error(`Storage object content mismatch: ${value.name}`);
  }
  objects.push(value);
}
for (const path of documentPaths) {
  const uid = path.split('/')[1];
  if (!identityUids.has(uid)) throw new Error(`Firestore user ${uid} has no Auth identity`);
}

if (manifest.counts?.firestoreDocuments !== documents.length ||
    manifest.counts?.authUsers !== identities.length || manifest.counts?.storageObjects !== objects.length) {
  throw new Error('bundle manifest counts do not match staged records');
}
if (!manifest.includesStorageObjects && objects.length !== 0) {
  throw new Error('manifest says Storage objects were not included but storage.ndjson is non-empty');
}

const summary = {
  mode: args.apply ? 'apply' : 'dry-run',
  documents: documents.length,
  identities: identities.length,
  objects: objects.length,
};

if (!args.apply) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write('Dry-run only. No database connection was opened.\n');
  process.exit(0);
}

if (args.acknowledge !== 'SINGLE_WRITER_FROZEN') usage('missing single-writer acknowledgement');
if (process.env.EDGEBOOK_WRITES_FROZEN !== 'true') {
  throw new Error('EDGEBOOK_WRITES_FROZEN must equal true after Firebase and VPS writers are stopped');
}
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required for --apply');
if (manifest.projectId !== 'edgebook-2dce2') throw new Error(`refusing apply from unexpected Firebase project ${manifest.projectId || '<missing>'}`);

const batchId = args['batch-id'] || randomUUID();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batchId)) {
  throw new Error('batch-id must be a UUID');
}

const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '15min'");
  const schema = await client.query("SELECT to_regclass('edgebook_migration.batches') AS table_name");
  if (!schema.rows[0]?.table_name) throw new Error('run migration/postgres/staging-schema.sql first');

  await client.query(
    `INSERT INTO edgebook_migration.batches
       (batch_id, source_project, source_scope, source_manifest, status)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, 'loading')`,
    [batchId, manifest.projectId, JSON.stringify(manifest.scope), JSON.stringify(manifest)],
  );

  for (const doc of documents) {
    await client.query(
      `INSERT INTO edgebook_migration.documents
         (batch_id, source_path, payload, source_create_time, source_update_time,
          payload_sha256, redacted_fields)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb)`,
      [
        batchId,
        doc.path,
        JSON.stringify(doc.data),
        doc.createTime,
        doc.updateTime,
        sha256Text(canonicalJson(doc.data)),
        JSON.stringify(doc.redactedFields || []),
      ],
    );
  }

  for (const identity of identities) {
    await client.query(
      `INSERT INTO edgebook_migration.auth_identities
         (batch_id, firebase_uid, email, payload, payload_sha256)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [batchId, identity.uid, identity.email, JSON.stringify(identity), sha256Text(canonicalJson(identity))],
    );
  }

  for (const object of objects) {
    await client.query(
      `INSERT INTO edgebook_migration.objects
         (batch_id, source_name, local_path, size_bytes, sha256, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [batchId, object.name, object.localPath, Number(object.size || 0), object.sha256, JSON.stringify(object)],
    );
  }

  await client.query(
    `UPDATE edgebook_migration.batches SET status = 'staged', staged_at = now()
      WHERE batch_id = $1`,
    [batchId],
  );
  await client.query('COMMIT');
  process.stdout.write(`${JSON.stringify({ ...summary, batchId }, null, 2)}\n`);
  process.stdout.write('Staging completed. Promotion requires separate review and reconciliation.\n');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
