#!/usr/bin/env node
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  findForbiddenCredentialPaths,
  parseArgs,
  readNdjson,
  resolveContainedRegularFile,
  sha256File,
} from '../lib/bundle.mjs';

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));
if (!args.bundle || args.bundle === true || !isAbsolute(args.bundle)) {
  process.stderr.write('Usage: node scripts/validate-bundle.mjs --bundle /absolute/export-directory\n');
  process.exit(2);
}

const bundle = await realpath(resolve(args.bundle));
const manifest = JSON.parse(await readFile(await resolveContainedRegularFile(bundle, 'manifest.json'), 'utf8'));
if (manifest.formatVersion !== 1) fail(`unsupported formatVersion ${manifest.formatVersion}`);

const requiredManifestFiles = ['auth-users.ndjson', 'firestore.ndjson', 'storage.ndjson'];
const manifestFileNames = Object.keys(manifest.files || {}).sort();
if (JSON.stringify(manifestFileNames) !== JSON.stringify([...requiredManifestFiles].sort())) {
  fail(`manifest files must be exactly: ${requiredManifestFiles.join(', ')}`);
}
const bundleFiles = new Map();
for (const name of requiredManifestFiles) {
  const filePath = await resolveContainedRegularFile(bundle, name);
  bundleFiles.set(name, filePath);
  const expected = manifest.files?.[name];
  if (!/^[a-f0-9]{64}$/.test(expected || '')) {
    fail(`manifest checksum is missing/invalid for ${name}`);
    continue;
  }
  const actual = await sha256File(filePath);
  if (actual !== expected) fail(`checksum mismatch for ${name}`);
}

let authUsers = 0;
const authUids = new Set();
for await (const { lineNumber, value } of readNdjson(bundleFiles.get('auth-users.ndjson'))) {
  authUsers += 1;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.uid) {
    fail(`auth-users.ndjson:${lineNumber}: invalid identity envelope`);
    continue;
  }
  if (authUids.has(value.uid)) fail(`duplicate Auth uid ${value.uid}`);
  authUids.add(value.uid);
  const googleSub = value.providers?.find((provider) => provider.providerId === 'google.com')?.uid;
  if (!value.email || value.emailVerified !== true || !googleSub) {
    fail(`auth-users.ndjson:${lineNumber}: a verified email and immutable google.com provider uid are required`);
  }
  const forbidden = findForbiddenCredentialPaths(value);
  if (forbidden.length) fail(`auth-users.ndjson:${lineNumber}: credentials present at ${forbidden.join(', ')}`);
}

let firestoreDocuments = 0;
const documentPaths = new Set();
for await (const { lineNumber, value } of readNdjson(bundleFiles.get('firestore.ndjson'))) {
  firestoreDocuments += 1;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.path || !/^users\/[^/]+(?:\/[^/]+\/[^/]+)*$/.test(value.path) ||
      !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) {
    fail(`firestore.ndjson:${lineNumber}: invalid document envelope`);
    continue;
  }
  if (documentPaths.has(value.path)) fail(`duplicate Firestore path ${value.path}`);
  documentPaths.add(value.path);
  if (/(^|\/)pendingAuth(?:\/|$)/.test(value.path)) fail(`pendingAuth must not be exported: ${value.path}`);
  const forbidden = findForbiddenCredentialPaths(value.data);
  if (forbidden.length) fail(`${value.path}: credentials present at ${forbidden.join(', ')}`);
}

let storageObjects = 0;
const storageNames = new Set();
const storagePaths = new Set();
for await (const { lineNumber, value } of readNdjson(bundleFiles.get('storage.ndjson'))) {
  storageObjects += 1;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.name || !/^users\/[^/]+\/screenshots\/.+/.test(value.name) ||
      value.localPath !== `storage/${value.name}` || !/^[a-f0-9]{64}$/.test(value.sha256 || '') ||
      !Number.isSafeInteger(value.size) || value.size < 0) {
    fail(`storage.ndjson:${lineNumber}: invalid storage envelope`);
    continue;
  }
  const forbidden = findForbiddenCredentialPaths(value);
  if (forbidden.length) fail(`storage.ndjson:${lineNumber}: credentials present at ${forbidden.join(', ')}`);
  if (storageNames.has(value.name)) fail(`duplicate Storage object name ${value.name}`);
  if (storagePaths.has(value.localPath)) fail(`duplicate Storage localPath ${value.localPath}`);
  storageNames.add(value.name);
  storagePaths.add(value.localPath);
  try {
    const objectPath = await resolveContainedRegularFile(bundle, value.localPath);
    const actual = await sha256File(objectPath);
    if (actual !== value.sha256) fail(`storage object checksum mismatch: ${value.name}`);
    const info = await stat(objectPath);
    if (info.size !== value.size) fail(`storage object size mismatch: ${value.name}`);
  } catch (error) {
    fail(`storage object missing/unreadable ${value.name}: ${error.message}`);
  }
}

const expected = manifest.counts || {};
if (expected.authUsers !== authUsers) fail(`Auth count mismatch: manifest=${expected.authUsers}, actual=${authUsers}`);
if (expected.firestoreDocuments !== firestoreDocuments) {
  fail(`Firestore count mismatch: manifest=${expected.firestoreDocuments}, actual=${firestoreDocuments}`);
}
if (expected.storageObjects !== storageObjects) {
  fail(`Storage count mismatch: manifest=${expected.storageObjects}, actual=${storageObjects}`);
}
if (!manifest.includesStorageObjects && storageObjects !== 0) {
  fail('manifest says Storage objects were not included but storage.ndjson is non-empty');
}
for (const path of documentPaths) {
  const uid = path.split('/')[1];
  if (!authUids.has(uid)) fail(`Firestore user ${uid} has no Auth identity`);
}

if (!process.exitCode) {
  process.stdout.write(`${JSON.stringify({ valid: true, authUsers, firestoreDocuments, storageObjects }, null, 2)}\n`);
}
