#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  chmod,
  chown,
  lstat,
  readFile,
  realpath,
  rename,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import pg from 'pg';
import { processMigrationImage } from '../lib/image.mjs';
import { mergeSettings, settingsAccounts } from '../lib/settings.mjs';
import {
  canonicalJson,
  decodeTaggedScalar,
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
  Dry-run: node scripts/promote.mjs --bundle /absolute/export [--browser-local file.json]
  Apply: EDGEBOOK_WRITES_FROZEN=true MIGRATION_DATABASE_URL=... \\
    node scripts/promote.mjs --bundle /absolute/export --batch-id UUID \\
      --upload-root /srv/edgebook-data/uploads --apply \\
      --acknowledge SINGLE_WRITER_FROZEN [--browser-local file.json]

Optional policy overrides (defaults match deploy/vps/env/edgebook.env.example):
  --max-upload-bytes N --max-image-pixels N
  --user-storage-quota-bytes N --total-storage-quota-bytes N
  --min-disk-free-bytes N (cannot be lower than 10 GiB)
  --upload-uid N --upload-gid N (default fixed container identity 12001:12001)

Apply requires a staged batch, promotes transactionally, and materializes every
resolvable screenshot. Unknown/external screenshot URLs block promotion.
`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
if (!args.bundle || !isAbsolute(args.bundle)) usage('--bundle must be absolute');
if (args['browser-local'] && !isAbsolute(args['browser-local'])) usage('--browser-local must be absolute');
if (args.apply && (!args['upload-root'] || !isAbsolute(args['upload-root']))) usage('--upload-root must be absolute for apply');
if (args.apply && !args['browser-local']) usage('--browser-local is required for a cutover apply');
if (args.apply && !/^[0-9a-f-]{36}$/i.test(String(args['batch-id'] || ''))) usage('--batch-id UUID is required for apply');

function integerOption(name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = args[name] ?? fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    usage(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}
const maxUploadBytes = integerOption('max-upload-bytes', 5 * 1024 * 1024, 64 * 1024, 50 * 1024 * 1024);
const maxImagePixels = integerOption('max-image-pixels', 40_000_000, 1_000_000, 100_000_000);
const userStorageQuotaBytes = integerOption('user-storage-quota-bytes', 500 * 1024 * 1024, 1024 * 1024);
const totalStorageQuotaBytes = integerOption('total-storage-quota-bytes', 10 * 1024 * 1024 * 1024, 1024 * 1024);
const minDiskFreeBytes = integerOption('min-disk-free-bytes', 10 * 1024 * 1024 * 1024, 10 * 1024 * 1024 * 1024);
const uploadUid = integerOption('upload-uid', 12001, 1, 2_147_483_647);
const uploadGid = integerOption('upload-gid', 12001, 1, 2_147_483_647);
if (userStorageQuotaBytes > totalStorageQuotaBytes) usage('--user-storage-quota-bytes must not exceed --total-storage-quota-bytes');

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
  if (await sha256File(file) !== expected) throw new Error(`checksum mismatch for ${name}`);
}

function deterministicUuid(key) {
  const bytes = createHash('sha256').update(`edgebook-migration-v1\0${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function scalar(value) {
  return decodeTaggedScalar(value);
}
function text(value) {
  const v = scalar(value);
  return v === null || v === undefined || v === '' ? null : String(v);
}
function number(value) {
  const raw = scalar(value);
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function hasValue(value) {
  const raw = scalar(value);
  return raw !== null && raw !== undefined && !(typeof raw === 'string' && raw.trim() === '');
}
function databaseNumber(value) {
  const parsed = number(value);
  return parsed !== null && Math.abs(parsed) < 1e20 ? parsed : null;
}
function bool(value) {
  const v = scalar(value);
  return v === true || v === 'true';
}
function validDate(value) {
  const raw = scalar(value);
  if (raw === null || raw === undefined || raw === '') return null;
  let candidate;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const millis = Math.abs(raw) < 10_000_000_000 ? raw * 1_000 : raw;
    const parsed = new Date(millis);
    candidate = Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
  } else {
    const valueText = String(raw);
    candidate = /^\d{4}-\d{2}-\d{2}$/.test(valueText)
      ? valueText
      : timestamp(valueText)?.slice(0, 10) || null;
  }
  const match = candidate?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? candidate
    : null;
}
function validTime(value) {
  const v = text(value);
  const match = v?.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || '0');
  if (hour > 23 || minute > 59 || second > 59) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}:${String(second).padStart(2, '0')}`;
}
function timestamp(value) {
  const raw = scalar(value);
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const milliseconds = Math.abs(raw) < 10_000_000_000 ? raw * 1_000 : raw;
    const parsed = new Date(milliseconds);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  const v = String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return validDate(v) === v ? `${v}T00:00:00.000Z` : null;
  const iso = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/i);
  if (iso) {
    if (validDate(iso[1]) !== iso[1] || Number(iso[2]) > 23 || Number(iso[3]) > 59 ||
        Number(iso[4] || 0) > 59 || Number(iso[6] || 0) > 23 || Number(iso[7] || 0) > 59) return null;
  } else if (!/^[A-Za-z]{3},\s.+(?:GMT|UTC)$/i.test(v)) {
    return null;
  }
  const parsed = new Date(v);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
const manifestCreatedAt = timestamp(manifest.createdAt);
if (hasValue(manifest.createdAt) && !manifestCreatedAt) throw new Error('manifest has invalid createdAt');
function direction(value) {
  const v = text(value)?.toLowerCase();
  if (v === 'long' || v === 'buy') return 'Long';
  if (v === 'short' || v === 'sell') return 'Short';
  return null;
}
function currency(value, fallback = 'USD') {
  const v = text(value)?.toUpperCase();
  if (v && /^[A-Z]{3}$/.test(v)) return v;
  return ({ '$': 'USD', '₹': 'INR', '€': 'EUR', '£': 'GBP' })[text(value)] || fallback;
}
function safeJson(value, fallback) {
  return value && typeof value === 'object' ? value : fallback;
}
function sourceInfo(data) {
  const rawSource = (text(data.source) || 'manual').toLowerCase();
  const broker = (text(data.broker) || '').toLowerCase();
  const sourceSystem = rawSource === 'csv' && broker ? broker : rawSource;
  const ingestionMethod = text(data.ingestionMethod) ||
    (rawSource === 'manual' ? 'manual' : rawSource === 'csv' ? 'csv' : 'migration');
  return { sourceSystem, ingestionMethod };
}
function assertDeterministicId(row, expectedId, label) {
  if (!row) throw new Error(`${label} was not inserted or resolved`);
  if (row.id !== expectedId) {
    throw new Error(`${label} collides with pre-existing VPS data; expected deterministic id ${expectedId}, found ${row.id}`);
  }
}

const authUsers = new Map();
for await (const { value } of readNdjson(bundleFiles.get('auth-users.ndjson'))) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.uid || authUsers.has(value.uid)) {
    throw new Error(`invalid, duplicate or missing Auth uid: ${value?.uid || '<missing>'}`);
  }
  const forbidden = findForbiddenCredentialPaths(value);
  if (forbidden.length) throw new Error(`Auth identity ${value.uid} contains forbidden credentials: ${forbidden.join(', ')}`);
  authUsers.set(value.uid, value);
}
for (const [uid, identity] of authUsers) {
  if (!identity.email) throw new Error(`Auth identity ${uid} has no email; explicit account-recovery mapping is required`);
  if (identity.emailVerified !== true) throw new Error(`Auth identity ${uid} does not have a verified email`);
  const googleSub = identity.providers?.find((provider) => provider.providerId === 'google.com')?.uid;
  if (!googleSub) throw new Error(`Auth identity ${uid} has no immutable google.com provider uid; reviewed identity mapping is required`);
  if (hasValue(identity.metadata?.creationTime) && !timestamp(identity.metadata.creationTime)) {
    throw new Error(`Auth identity ${uid} has invalid creationTime`);
  }
}
const docs = [];
const documentPaths = new Set();
for await (const { value } of readNdjson(bundleFiles.get('firestore.ndjson'))) {
  if (!value?.path || documentPaths.has(value.path) || !/^users\/[^/]+(?:\/[^/]+\/[^/]+)*$/.test(value.path) ||
      !value.data || typeof value.data !== 'object' || Array.isArray(value.data) || /(^|\/)pendingAuth(?:\/|$)/.test(value.path)) {
    throw new Error(`invalid, duplicate or forbidden Firestore document: ${value?.path || '<missing>'}`);
  }
  const forbidden = findForbiddenCredentialPaths(value.data);
  if (forbidden.length) throw new Error(`${value.path} contains forbidden credentials: ${forbidden.join(', ')}`);
  documentPaths.add(value.path);
  if (hasValue(value.createTime) && !timestamp(value.createTime)) throw new Error(`${value.path} has invalid createTime`);
  if (hasValue(value.updateTime) && !timestamp(value.updateTime)) throw new Error(`${value.path} has invalid updateTime`);
  docs.push(value);
}
const storageIndex = new Map();
for await (const { value } of readNdjson(bundleFiles.get('storage.ndjson'))) {
  if (!value?.name || storageIndex.has(value.name) || !/^users\/[^/]+\/screenshots\/.+/.test(value.name) ||
      value.localPath !== `storage/${value.name}` || !/^[a-f0-9]{64}$/.test(value.sha256 || '') ||
      !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error(`invalid or duplicate Storage object: ${value?.name || '<missing>'}`);
  }
  const forbidden = findForbiddenCredentialPaths(value);
  if (forbidden.length) throw new Error(`Storage object ${value.name} contains forbidden credentials: ${forbidden.join(', ')}`);
  const sourcePath = await resolveContainedRegularFile(bundle, value.localPath);
  const sourceInfo = await lstat(sourcePath);
  if (sourceInfo.size !== value.size || await sha256File(sourcePath) !== value.sha256) {
    throw new Error(`Storage object content mismatch: ${value.name}`);
  }
  storageIndex.set(value.name, value);
}
if (manifest.counts?.authUsers !== authUsers.size || manifest.counts?.firestoreDocuments !== docs.length ||
    manifest.counts?.storageObjects !== storageIndex.size) throw new Error('bundle manifest counts do not match records');
if (!manifest.includesStorageObjects && storageIndex.size !== 0) {
  throw new Error('manifest says Storage objects were not included but storage.ndjson is non-empty');
}
const expectedStagedDocuments = new Map(docs.map((doc) => [doc.path, sha256Text(canonicalJson(doc.data))]));
const expectedStagedIdentities = new Map([...authUsers].map(([uid, identity]) => [uid, sha256Text(canonicalJson(identity))]));
const expectedStagedObjects = new Map([...storageIndex].map(([name, object]) => [name, object.sha256]));

const usersWithDocs = new Set();
for (const doc of docs) {
  const match = doc.path.match(/^users\/([^/]+)(?:\/|$)/);
  if (match) usersWithDocs.add(match[1]);
}
const missingIdentities = [...usersWithDocs].filter((uid) => !authUsers.has(uid));
if (missingIdentities.length) throw new Error(`Firestore users missing Auth identity: ${missingIdentities.join(', ')}`);

let browserLocal = { users: {} };
if (args['browser-local']) browserLocal = JSON.parse(await readFile(args['browser-local'], 'utf8'));
if (!browserLocal.users || typeof browserLocal.users !== 'object' || Array.isArray(browserLocal.users)) {
  throw new Error('browser-local file must contain a users object');
}
const forbiddenBrowserFields = findForbiddenCredentialPaths(browserLocal);
if (forbiddenBrowserFields.length) {
  throw new Error(`browser-local export contains forbidden credentials: ${forbiddenBrowserFields.join(', ')}`);
}
if (args['browser-local']) {
  const missingBrowserUsers = [...authUsers.keys()].filter((uid) => !Object.hasOwn(browserLocal.users, uid));
  if (missingBrowserUsers.length) {
    throw new Error(`browser-local export is missing Auth users: ${missingBrowserUsers.join(', ')}`);
  }
  for (const [uid, local] of Object.entries(browserLocal.users)) {
    if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error(`invalid browser-local record for ${uid}`);
    if (!Object.hasOwn(local, 'settings') || !local.settings || typeof local.settings !== 'object' || Array.isArray(local.settings)) {
      throw new Error(`browser-local settings must be an object for ${uid}`);
    }
    if (!Object.hasOwn(local, 'moods') || !Array.isArray(local.moods)) throw new Error(`browser-local moods must be an array for ${uid}`);
    if (!Object.hasOwn(local, 'dailyJournal') || !local.dailyJournal || typeof local.dailyJournal !== 'object' || Array.isArray(local.dailyJournal)) {
      throw new Error(`browser-local dailyJournal must be an object for ${uid}`);
    }
  }
}

const settingsByUid = new Map();
const userRootDocsByUid = new Map();
const brokerDocs = [];
const tradeDocs = [];
const notificationDocs = [];
const duplicateDocs = [];
const orderDocs = [];
for (const doc of docs) {
  let match;
  if ((match = doc.path.match(/^users\/([^/]+)$/))) userRootDocsByUid.set(match[1], doc);
  else if ((match = doc.path.match(/^users\/([^/]+)\/meta\/settings$/))) settingsByUid.set(match[1], doc);
  else if (/^users\/[^/]+\/brokers\/[^/]+$/.test(doc.path)) brokerDocs.push(doc);
  else if (/^users\/[^/]+\/trades\/[^/]+$/.test(doc.path)) tradeDocs.push(doc);
  else if (/^users\/[^/]+\/notifications\/[^/]+$/.test(doc.path)) notificationDocs.push(doc);
  else if (/^users\/[^/]+\/pendingDuplicates\/[^/]+$/.test(doc.path)) duplicateDocs.push(doc);
  else if (/^users\/[^/]+\/orders\/[^/]+$/.test(doc.path)) orderDocs.push(doc);
}

const mergedSettingsByUid = new Map();
for (const [uid] of authUsers) {
  const remote = settingsByUid.get(uid)?.data;
  const local = browserLocal.users[uid]?.settings;
  mergedSettingsByUid.set(uid, mergeSettings(remote, local));
}

const accountPlans = [];
for (const [uid, auth] of authUsers) {
  const settings = mergedSettingsByUid.get(uid);
  const accounts = settingsAccounts(settings.accounts);
  for (const account of accounts) {
    const legacyId = text(account.id);
    if (!legacyId) throw new Error(`Account without id for Firebase uid ${uid}`);
    const accountSizeInput = account.size ?? account.accountSize;
    const accountSize = databaseNumber(accountSizeInput);
    if (hasValue(accountSizeInput) && accountSize === null) {
      throw new Error(`Account ${uid}/${legacyId} has invalid account size`);
    }
    accountPlans.push({
      id: deterministicUuid(`account:${uid}:${legacyId}`), uid, legacyId,
      name: text(account.name) || legacyId,
      currency: currency(account.currency || settings.prefs?.currency),
      size: accountSize, color: text(account.color), metadata: account,
    });
  }
}

const accountByLegacy = new Map(accountPlans.map((account) => [`${account.uid}:${account.legacyId}`, account]));
const brokerPlans = brokerDocs.map((doc) => {
  const [, uid, legacyDocId] = doc.path.match(/^users\/([^/]+)\/brokers\/([^/]+)$/);
  const forbidden = findForbiddenCredentialPaths(doc.data);
  if (forbidden.length) throw new Error(`staged broker credential leak at ${doc.path}: ${forbidden.join(', ')}`);
  const provider = legacyDocId.startsWith('ctrader') ? 'ctrader' : legacyDocId === 'zerodha' ? 'zerodha' : (text(doc.data.provider) || legacyDocId);
  const mappedLegacy = text(doc.data.mapToEdgebookAccountId) || text(mergedSettingsByUid.get(uid)?.brokerAccountMap?.[legacyDocId]);
  const connectedAt = timestamp(doc.data.connectedAt);
  const lastSyncValue = doc.data.lastSyncTimestamp || doc.data.lastSync;
  const lastSyncAt = timestamp(lastSyncValue);
  if (hasValue(doc.data.connectedAt) && !connectedAt) throw new Error(`${doc.path} has invalid connectedAt`);
  if (hasValue(lastSyncValue) && !lastSyncAt) throw new Error(`${doc.path} has invalid last-sync timestamp`);
  return {
    id: deterministicUuid(`broker:${doc.path}`), uid, legacyDocId, provider,
    externalAccountId: text(doc.data.accountId || doc.data.userId),
    label: text(doc.data.accountLabel || doc.data.userName),
    mappedLegacy, metadata: doc.data, connectedAt, lastSyncAt,
  };
});
const brokerByLegacy = new Map(brokerPlans.map((broker) => [`${broker.uid}:${broker.legacyDocId}`, broker]));
for (const broker of brokerPlans) {
  if (broker.mappedLegacy && !accountByLegacy.has(`${broker.uid}:${broker.mappedLegacy}`)) {
    throw new Error(`Broker ${broker.uid}/${broker.legacyDocId} maps to missing account ${broker.mappedLegacy}`);
  }
}

const invalidTrades = [];
const tradePlans = tradeDocs.map((doc) => {
  const [, uid, legacyDocId] = doc.path.match(/^users\/([^/]+)\/trades\/([^/]+)$/);
  const data = doc.data;
  const entryInput = data.entry ?? data.average_price;
  const quantityInput = data.size ?? data.quantity;
  const required = {
    symbol: text(data.symbol || data.tradingsymbol),
    tradeDate: validDate(data.date || data.fill_timestamp || data.order_timestamp),
    direction: direction(data.direction || data.transaction_type),
    entry: databaseNumber(entryInput),
    quantity: databaseNumber(quantityInput),
  };
  const suppliedEntryTime = text(data.entryTime);
  const suppliedExitTime = text(data.exitTime);
  const suppliedExpiry = text(data.expiry);
  const optionalNumericInputs = { strike:data.strike, exit:data.exit, pnl:data.pnl, sl:data.sl, tp:data.tp };
  const invalidOptionalNumbers = Object.entries(optionalNumericInputs)
    .filter(([, value]) => hasValue(value) && databaseNumber(value) === null)
    .map(([field]) => field);
  const deletedAt = bool(data.deleted)
    ? timestamp(data.deletedAt) || timestamp(doc.updateTime) || manifestCreatedAt
    : null;
  if (!required.symbol || !required.tradeDate || !required.direction || required.entry === null || required.entry <= 0 ||
      required.quantity === null || required.quantity <= 0 ||
      invalidOptionalNumbers.length ||
      (suppliedEntryTime && !validTime(data.entryTime)) ||
      (suppliedExitTime && !validTime(data.exitTime)) ||
      (suppliedExpiry && !validDate(data.expiry)) ||
      (bool(data.deleted) && !deletedAt)) {
    invalidTrades.push({ path: doc.path, required, invalidOptionalNumbers });
  }
  const source = sourceInfo(data);
  const legacyAccountId = text(data.accountId);
  let brokerLegacyId = text(data.brokerDocId);
  if (!brokerLegacyId && source.sourceSystem === 'zerodha') brokerLegacyId = 'zerodha';
  if (!brokerLegacyId && source.sourceSystem === 'ctrader') {
    brokerLegacyId = text(data.ctraderAccountId) ? `ctrader_${text(data.ctraderAccountId)}` : 'ctrader';
  }
  return {
    id: deterministicUuid(`trade:${doc.path}`), uid, legacyDocId, path: doc.path, data,
    ...required, ...source, legacyAccountId, brokerLegacyId,
    createTime: timestamp(doc.createTime), updateTime: timestamp(doc.updateTime), deletedAt,
  };
});
if (invalidTrades.length) throw new Error(`Invalid required trade fields: ${JSON.stringify(invalidTrades.slice(0, 20))}`);
const tradeByLegacy = new Map(tradePlans.map((trade) => [`${trade.uid}:${trade.legacyDocId}`, trade]));

function firebaseObjectName(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/o\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch { return null; }
}
function decodedDataUrl(src) {
  const match = src.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) return null;
  return { contentType: match[1].toLowerCase(), buffer: Buffer.from(match[2].replace(/\s/g, ''), 'base64') };
}
const screenshotPlans = [];
const unresolvedScreenshots = [];
const referencedStorageObjects = new Set();
for (const trade of tradePlans) {
  const screenshots = Array.isArray(trade.data.screenshots) ? trade.data.screenshots : [];
  if (screenshots.length > 5) {
    unresolvedScreenshots.push({ path: trade.path, reason: `has ${screenshots.length} screenshots; server limit is 5` });
    continue;
  }
  for (let index = 0; index < screenshots.length; index += 1) {
    const screenshot = screenshots[index];
    const src = typeof screenshot === 'string' ? screenshot : text(screenshot?.src);
    const requestedName = basename(text(screenshot?.name) || `screenshot-${index + 1}`).slice(0,255);
    const originalName = requestedName && requestedName !== '.' && requestedName !== '..' ? requestedName : `screenshot-${index + 1}`;
    if (!src) { unresolvedScreenshots.push({ path: trade.path, index, reason: 'missing src' }); continue; }
    const embedded = decodedDataUrl(src);
    const objectName = embedded ? null : firebaseObjectName(src);
    const storage = objectName ? storageIndex.get(objectName) : null;
    if (!embedded && !storage) {
      unresolvedScreenshots.push({ path: trade.path, index, reason: 'not embedded or copied Firebase Storage object' });
      continue;
    }
    if (storage && !storage.name.startsWith(`users/${trade.uid}/screenshots/`)) {
      unresolvedScreenshots.push({ path: trade.path, index, reason: 'Storage object belongs to another Firebase user' });
      continue;
    }
    const sourcePath = storage ? await resolveContainedRegularFile(bundle, storage.localPath) : null;
    if (storage) referencedStorageObjects.add(storage.name);
    const sourceBuffer = embedded?.buffer || await readFile(sourcePath);
    const sourceSha256 = createHash('sha256').update(sourceBuffer).digest('hex');
    if (storage && sourceSha256 !== storage.sha256) throw new Error(`Storage checksum changed: ${objectName}`);
    let processed;
    try { processed = await processMigrationImage(sourceBuffer, { maxBytes: maxUploadBytes, maxPixels: maxImagePixels }); }
    catch (error) { unresolvedScreenshots.push({path:trade.path,index,reason:`invalid image: ${error.message}`}); continue; }
    screenshotPlans.push({
      id: deterministicUuid(`file:${trade.path}:${index}:${processed.sha256}`), uid: trade.uid, tradeId: trade.id,
      tradePath: trade.path, index, legacyUrl: src, originalName, contentType: processed.contentType,
      extension: processed.extension, width: processed.width, height: processed.height,
      byteSize: processed.bytes.length, sha256: processed.sha256, sourceSha256,
      sourcePath,
    });
  }
}
if (unresolvedScreenshots.length) {
  throw new Error(`Unresolved screenshots block promotion: ${JSON.stringify(unresolvedScreenshots.slice(0, 20))}`);
}
const unreferencedStorageObjects = [...storageIndex.keys()].filter((name) => !referencedStorageObjects.has(name));
if (unreferencedStorageObjects.length) {
  throw new Error(`Unreferenced Firebase Storage screenshots require reviewed disposition: ${JSON.stringify(unreferencedStorageObjects.slice(0, 50))}`);
}
const screenshotBytesByUid = new Map();
for (const screenshot of screenshotPlans) {
  screenshotBytesByUid.set(screenshot.uid, (screenshotBytesByUid.get(screenshot.uid) || 0) + screenshot.byteSize);
}
for (const [uid, bytes] of screenshotBytesByUid) {
  if (bytes > userStorageQuotaBytes) throw new Error(`screenshot plan exceeds the per-user quota for ${uid}: ${bytes} bytes`);
}
const totalScreenshotBytes = screenshotPlans.reduce((sum, screenshot) => sum + screenshot.byteSize, 0);
if (totalScreenshotBytes > totalStorageQuotaBytes) {
  throw new Error(`screenshot plan exceeds the total storage quota: ${totalScreenshotBytes} bytes`);
}

const moodPlans = [];
const journalPlans = [];
const moodPlanKeys = new Set();
for (const [uid, local] of Object.entries(browserLocal.users)) {
  if (!authUsers.has(uid)) throw new Error(`browser-local uid not in Auth export: ${uid}`);
  if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error(`invalid browser-local record for ${uid}`);
  if (local.moods !== undefined && !Array.isArray(local.moods)) throw new Error(`browser-local moods must be an array for ${uid}`);
  if (local.dailyJournal !== undefined && (!local.dailyJournal || typeof local.dailyJournal !== 'object' || Array.isArray(local.dailyJournal))) {
    throw new Error(`browser-local dailyJournal must be an object for ${uid}`);
  }
  for (const mood of local.moods || []) {
    const date = validDate(mood.date);
    const time = validTime(mood.time);
    const confidence = number(mood.confidence);
    if (!date) throw new Error(`invalid mood date for ${uid}`);
    if (text(mood.time) && !time) throw new Error(`invalid mood time for ${uid}`);
    if (confidence !== null && (!Number.isInteger(confidence) || confidence < 1 || confidence > 10)) {
      throw new Error(`invalid mood confidence for ${uid}`);
    }
    const legacyId = text(mood.id) || sha256Text(canonicalJson(mood)).slice(0, 32);
    const moodKey = `${uid}\0${legacyId}`;
    if (moodPlanKeys.has(moodKey)) throw new Error(`duplicate browser-local mood ${uid}/${legacyId}`);
    moodPlanKeys.add(moodKey);
    moodPlans.push({ uid, mood, date, time, confidence, legacyId, id: deterministicUuid(`mood:${uid}:${legacyId}`) });
  }
  for (const [dateValue, entry] of Object.entries(local.dailyJournal || {})) {
    const date = validDate(dateValue);
    if (!date || date !== dateValue) throw new Error(`invalid journal date for ${uid}: ${dateValue}`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`invalid journal entry for ${uid}: ${dateValue}`);
    journalPlans.push({ uid, date, entry, id: deterministicUuid(`journal:${uid}:${date}`) });
  }
}

const planSummary = {
  users: authUsers.size, rawFirestoreDocuments: docs.length, settings: settingsByUid.size, accounts: accountPlans.length,
  brokersDisconnected: brokerPlans.length, trades: tradePlans.length,
  archivedTrades: tradePlans.filter((trade) => bool(trade.data.deleted)).length,
  screenshots: screenshotPlans.length, notifications: notificationDocs.length,
  pendingDuplicates: duplicateDocs.length, orders: orderDocs.length,
  browserMoods: moodPlans.length, browserJournals: journalPlans.length,
  browserSettings: Object.values(browserLocal.users).filter(value => value?.settings).length,
  screenshotBytes: totalScreenshotBytes,
  screenshotPolicy: { maxUploadBytes, maxImagePixels, userStorageQuotaBytes, totalStorageQuotaBytes, minDiskFreeBytes, uploadUid, uploadGid },
  settingsMergePolicy: 'remote-wins nested preferences; newer account wins; local-only accounts retained; local broker map wins',
};
if (!args.apply) {
  process.stdout.write(`${JSON.stringify({ mode: 'dry-run', planSummary }, null, 2)}\n`);
  process.stdout.write('Dry-run passed. No database connection was opened and no files were written.\n');
  process.exit(0);
}

if (args.acknowledge !== 'SINGLE_WRITER_FROZEN' || process.env.EDGEBOOK_WRITES_FROZEN !== 'true') {
  throw new Error('Apply requires EDGEBOOK_WRITES_FROZEN=true and --acknowledge SINGLE_WRITER_FROZEN');
}
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
if (manifest.projectId !== 'edgebook-2dce2') throw new Error(`refusing apply from unexpected Firebase project ${manifest.projectId || '<missing>'}`);
const uploadRoot = resolve(args['upload-root']);
if (uploadRoot === resolve('/') || relative('/srv/edgebook-data/uploads', uploadRoot).startsWith('..')) {
  throw new Error('upload-root must be /srv/edgebook-data/uploads or a child');
}
const canonicalUploadRoot = await realpath(uploadRoot);
if (canonicalUploadRoot !== uploadRoot) throw new Error('upload-root and its parents must not resolve through a symlink');
const uploadInfo = await lstat(uploadRoot);
if (!uploadInfo.isDirectory()) throw new Error('upload-root must already exist as a directory');
if (uploadInfo.uid !== uploadUid || uploadInfo.gid !== uploadGid) {
  throw new Error(`upload-root must be owned by ${uploadUid}:${uploadGid}; found ${uploadInfo.uid}:${uploadInfo.gid}`);
}
const filesystem = await statfs(uploadRoot, { bigint: true });
const availableBytes = filesystem.bavail * filesystem.bsize;
if (availableBytes - BigInt(totalScreenshotBytes) < BigInt(minDiskFreeBytes)) {
  throw new Error(`screenshot plan would breach the ${minDiskFreeBytes}-byte free-space floor`);
}

const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await client.connect();
const userIds = new Map();
const copiedFiles = [];
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('edgebook:firebase-promotion'))");
  const batch = await client.query('SELECT status, source_manifest FROM edgebook_migration.batches WHERE batch_id=$1 FOR UPDATE', [args['batch-id']]);
  if (batch.rows[0]?.status !== 'staged') throw new Error(`batch is not staged: ${args['batch-id']}`);
  if (sha256Text(canonicalJson(batch.rows[0].source_manifest)) !== sha256Text(canonicalJson(manifest))) {
    throw new Error('staged batch manifest does not match bundle');
  }

  const stagedSets = [
    ['documents','source_path','payload_sha256',expectedStagedDocuments],
    ['auth_identities','firebase_uid','payload_sha256',expectedStagedIdentities],
    ['objects','source_name','sha256',expectedStagedObjects],
  ];
  for (const [table,keyColumn,hashColumn,expected] of stagedSets) {
    const rows = await client.query(`SELECT ${keyColumn} item_key,${hashColumn} item_hash FROM edgebook_migration.${table} WHERE batch_id=$1`,[args['batch-id']]);
    if (rows.rows.length !== expected.size) throw new Error(`staged ${table} count does not match bundle`);
    for (const row of rows.rows) {
      if (expected.get(row.item_key) !== row.item_hash) throw new Error(`staged ${table} hash mismatch for ${row.item_key}`);
    }
  }

  for (const [uid, identity] of authUsers) {
    const googleSub = identity.providers?.find((provider) => provider.providerId === 'google.com')?.uid || null;
    const legacyJson = {
      firebaseAuth: identity,
      firebaseUserDocument: userRootDocsByUid.get(uid)?.data ?? null,
      browserLocalSettings: browserLocal.users[uid]?.settings ?? null,
    };
    const matches = await client.query(
      `SELECT id, legacy_firebase_uid, google_sub, email, email_verified, legacy_json FROM users
       WHERE legacy_firebase_uid=$1 OR ($2::text IS NOT NULL AND google_sub=$2)
          OR lower(email)=lower($3) FOR UPDATE`, [uid, googleSub, identity.email],
    );
    const ids = [...new Set(matches.rows.map((row) => row.id))];
    if (ids.length > 1) throw new Error(`identity collision for Firebase uid ${uid}`);
    const id = ids[0] || deterministicUuid(`user:${uid}`);
    if (ids.length) {
      const row = matches.rows[0];
      if (row.legacy_firebase_uid && row.legacy_firebase_uid !== uid) throw new Error(`legacy uid collision for ${uid}`);
      if (row.google_sub && googleSub && row.google_sub !== googleSub) throw new Error(`Google sub collision for ${uid}`);
      if (!row.legacy_firebase_uid && !row.google_sub && !row.email_verified) {
        throw new Error(`refusing to link Firebase uid ${uid} through an unverified target email`);
      }
      if (canonicalJson(row.legacy_json || {}) !== '{}' && canonicalJson(row.legacy_json) !== canonicalJson(legacyJson)) {
        throw new Error(`existing user legacy metadata conflicts for Firebase uid ${uid}`);
      }
      await client.query(
        `UPDATE users SET legacy_firebase_uid=COALESCE(legacy_firebase_uid,$2),
          google_sub=COALESCE(google_sub,$3), email_verified=email_verified OR $4,
          legacy_json=$5::jsonb, disabled_at=CASE WHEN $6 THEN COALESCE(disabled_at,now()) ELSE disabled_at END
         WHERE id=$1`, [id, uid, googleSub, Boolean(identity.emailVerified), JSON.stringify(legacyJson), Boolean(identity.disabled)],
      );
    } else {
      await client.query(
        `INSERT INTO users (id,legacy_firebase_uid,google_sub,email,email_verified,display_name,avatar_url,legacy_json,created_at,updated_at,disabled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,COALESCE($9::timestamptz,now()),now(),$10)`,
        [id, uid, googleSub, identity.email, Boolean(identity.emailVerified), identity.displayName, identity.photoURL,
          JSON.stringify(legacyJson), timestamp(identity.metadata?.creationTime), identity.disabled ? new Date().toISOString() : null],
      );
    }
    userIds.set(uid, id);
  }

  // A Google login before cutover may create a user/session/audit row. No
  // business data may pre-exist, otherwise a source-vs-target merge needs an
  // explicit operator decision rather than ON CONFLICT silently choosing one.
  const targetUserIds = [...userIds.values()];
  const occupied = await client.query(
    `SELECT entity, row_count FROM (
       SELECT 'accounts' entity,count(*)::bigint row_count FROM accounts WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'broker_connections',count(*) FROM broker_connections WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'trades',count(*) FROM trades WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'trade_executions',count(*) FROM trade_executions WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'broker_orders',count(*) FROM broker_orders WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'mood_checkins',count(*) FROM mood_checkins WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'daily_journal_entries',count(*) FROM daily_journal_entries WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'notifications',count(*) FROM notifications WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'pending_duplicates',count(*) FROM pending_duplicates WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'file_objects',count(*) FROM file_objects WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'user_events',count(*) FROM user_events WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'oauth_transactions',count(*) FROM oauth_transactions WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'ctrader_oauth_grants',count(*) FROM ctrader_oauth_grants WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'legacy_firebase_documents',count(*) FROM legacy_firebase_documents WHERE user_id=ANY($1::uuid[])
       UNION ALL SELECT 'file_deletion_queue',count(*) FROM file_deletion_queue
       UNION ALL SELECT 'ctrader_symbol_specs',count(*) FROM symbol_specs WHERE provider='ctrader'
       UNION ALL SELECT 'nonempty_settings',count(*) FROM user_settings
         WHERE user_id=ANY($1::uuid[]) AND settings <> '{}'::jsonb
     ) inventory WHERE row_count > 0`,
    [targetUserIds],
  );
  if (occupied.rows.length) {
    throw new Error(`target contains pre-existing user data; promotion requires an empty target or reviewed merge: ${JSON.stringify(occupied.rows)}`);
  }

  for (const doc of docs) {
    const match = doc.path.match(/^users\/([^/]+)(?:\/|$)/);
    if (!match) throw new Error(`unsupported exported Firestore path: ${doc.path}`);
    const id = deterministicUuid(`raw-document:${doc.path}`);
    const result = await client.query(
      `INSERT INTO legacy_firebase_documents
       (id,user_id,source_path,payload,payload_sha256,source_create_time,source_update_time)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
       RETURNING id`,
      [id,userIds.get(match[1]),doc.path,JSON.stringify(doc.data),sha256Text(canonicalJson(doc.data)),doc.createTime,doc.updateTime],
    );
    const row = result.rows[0];
    assertDeterministicId(row,id,`raw Firestore document ${doc.path}`);
  }

  const resolvedAccountIds = new Map();
  for (const account of accountPlans) {
    const userId = userIds.get(account.uid);
    await client.query(
      `INSERT INTO accounts (id,user_id,legacy_account_id,name,currency_code,account_size,color,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [account.id,userId,account.legacyId,account.name,account.currency,account.size,account.color,JSON.stringify(account.metadata)],
    );
    const row = (await client.query('SELECT id FROM accounts WHERE user_id=$1 AND legacy_account_id=$2', [userId, account.legacyId])).rows[0];
    assertDeterministicId(row,account.id,`account ${account.uid}/${account.legacyId}`);
    resolvedAccountIds.set(`${account.uid}:${account.legacyId}`, row.id);
  }

  for (const [uid] of authUsers) {
    const doc = settingsByUid.get(uid);
    const settings = mergedSettingsByUid.get(uid);
    const settingsResult = await client.query(
      `INSERT INTO user_settings (user_id,legacy_firebase_path,settings,version)
       VALUES ($1,$2,$3::jsonb,$4)
       ON CONFLICT (user_id) DO UPDATE SET
         legacy_firebase_path=COALESCE(user_settings.legacy_firebase_path,EXCLUDED.legacy_firebase_path),
         settings=CASE WHEN user_settings.settings='{}'::jsonb THEN EXCLUDED.settings ELSE user_settings.settings END,
         version=CASE WHEN user_settings.settings='{}'::jsonb THEN EXCLUDED.version ELSE user_settings.version END
       WHERE user_settings.settings='{}'::jsonb OR user_settings.settings=EXCLUDED.settings
       RETURNING user_id`,
      [userIds.get(uid), doc?.path || null, JSON.stringify(settings), Number(settings.version) || 1],
    );
    if (!settingsResult.rows[0]) throw new Error(`settings conflict for Firebase uid ${uid}`);
  }

  const resolvedBrokerIds = new Map();
  for (const broker of brokerPlans) {
    const mapped = broker.mappedLegacy ? resolvedAccountIds.get(`${broker.uid}:${broker.mappedLegacy}`) || null : null;
    await client.query(
      `INSERT INTO broker_connections
       (id,user_id,legacy_firebase_doc_id,provider,external_account_id,account_label,mapped_account_id,connected,
        access_token_ciphertext,refresh_token_ciphertext,provider_metadata,legacy_document,connected_at,last_sync_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false,NULL,NULL,$8::jsonb,$9::jsonb,$10,$11)`,
      [broker.id,userIds.get(broker.uid),broker.legacyDocId,broker.provider,broker.externalAccountId,broker.label,mapped,
        JSON.stringify(broker.metadata),JSON.stringify(broker.metadata),broker.connectedAt,broker.lastSyncAt],
    );
    const row = (await client.query('SELECT id FROM broker_connections WHERE user_id=$1 AND legacy_firebase_doc_id=$2', [userIds.get(broker.uid),broker.legacyDocId])).rows[0];
    assertDeterministicId(row,broker.id,`broker connection ${broker.uid}/${broker.legacyDocId}`);
    resolvedBrokerIds.set(`${broker.uid}:${broker.legacyDocId}`, row.id);
  }

  const resolvedTradeIds = new Map();
  for (const trade of tradePlans) {
    const d = trade.data;
    const deletedAt = trade.deletedAt;
    await client.query(
      `INSERT INTO trades
       (id,user_id,legacy_firebase_doc_id,account_id,legacy_account_id,broker_connection_id,source_system,ingestion_method,
        external_trade_key,broker_trade_id,symbol,asset,instrument,option_type,strike,expiry,exchange,product,direction,
        entry_price,exit_price,quantity,pnl,stop_loss,take_profit,is_open,trade_date,legacy_entry_time,legacy_exit_time,
        strategy,emotion,notes,tags,psychology,custom_fields,broker_data,legacy_document,created_at,updated_at,deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
        $27,$28,$29,$30,$31,$32,$33::jsonb,$34::jsonb,$35::jsonb,$36::jsonb,$37::jsonb,COALESCE($38::timestamptz,now()),COALESCE($39::timestamptz,now()),$40)`,
      [trade.id,userIds.get(trade.uid),trade.legacyDocId,resolvedAccountIds.get(`${trade.uid}:${trade.legacyAccountId}`)||null,
        trade.legacyAccountId,resolvedBrokerIds.get(`${trade.uid}:${trade.brokerLegacyId}`)||null,trade.sourceSystem,trade.ingestionMethod,
        text(d.externalTradeKey),text(d.brokerTradeId),trade.symbol,text(d.asset),text(d.instrument),text(d.optionType),databaseNumber(d.strike),validDate(d.expiry),
        text(d.exchange),text(d.product),trade.direction,trade.entry,databaseNumber(d.exit),trade.quantity,databaseNumber(d.pnl),databaseNumber(d.sl),databaseNumber(d.tp),
        d.isOpen === null || d.isOpen === undefined ? null : bool(d.isOpen),trade.tradeDate,validTime(d.entryTime),validTime(d.exitTime),
        text(d.strategy),text(d.emotion),text(d.notes),JSON.stringify(safeJson(d.tags,[])),JSON.stringify(safeJson(d.psychology,{})),
        JSON.stringify(safeJson(d.custom,{})),JSON.stringify({ needsReview:d.needsReview, groupingMode:d.groupingMode, lotSize:d.lotSize }),
        // The immutable archive above preserves the original URLs. The live
        // trade row is private-file canonical so the API cannot return the same
        // screenshots once as file_objects and again as legacy references.
        JSON.stringify({ ...d, screenshots:[] }),trade.createTime,trade.updateTime,deletedAt],
    );
    const row = (await client.query('SELECT id FROM trades WHERE user_id=$1 AND legacy_firebase_doc_id=$2', [userIds.get(trade.uid),trade.legacyDocId])).rows[0];
    assertDeterministicId(row,trade.id,`trade ${trade.path}`);
    resolvedTradeIds.set(trade.path,row.id);
  }

  for (const screenshot of screenshotPlans) {
    const userId = userIds.get(screenshot.uid);
    const resolvedTradeId = resolvedTradeIds.get(screenshot.tradePath);
    const shard = userId.replaceAll('-', '').slice(0, 2);
    const storageKey = `${shard}/${userId}/${resolvedTradeId}/${screenshot.id}${screenshot.extension}`;
    const destination = resolve(uploadRoot, ...storageKey.split('/'));
    const rel = relative(uploadRoot, destination);
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`unsafe storage key ${storageKey}`);
    let directory = uploadRoot;
    for (const segment of storageKey.split('/').slice(0, -1)) {
      directory = resolve(directory, segment);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw new Error(`upload directory is not a real directory: ${directory}`);
      }
      if (typeof process.getuid !== 'function' || process.getuid() !== uploadUid || process.getgid() !== uploadGid) {
        await chown(directory, uploadUid, uploadGid);
      }
      await chmod(directory, 0o700);
    }
    const sourceBuffer = screenshot.sourcePath
      ? await readFile(screenshot.sourcePath)
      : decodedDataUrl(screenshot.legacyUrl)?.buffer;
    if (!sourceBuffer || createHash('sha256').update(sourceBuffer).digest('hex') !== screenshot.sourceSha256) {
      throw new Error(`screenshot source changed after planning: ${screenshot.tradePath}#${screenshot.index}`);
    }
    const processed = await processMigrationImage(sourceBuffer, { maxBytes: maxUploadBytes, maxPixels: maxImagePixels });
    if (processed.sha256 !== screenshot.sha256 || processed.bytes.length !== screenshot.byteSize) {
      throw new Error(`screenshot processing changed after planning: ${screenshot.tradePath}#${screenshot.index}`);
    }
    try {
      const existing = await lstat(destination);
      if (!existing.isFile() || await sha256File(destination) !== screenshot.sha256) throw new Error(`existing file checksum mismatch: ${storageKey}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temp = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temp, processed.bytes, { flag:'wx', mode:0o600 });
      if (await sha256File(temp) !== screenshot.sha256) { await unlink(temp).catch(()=>{}); throw new Error(`copy checksum mismatch: ${storageKey}`); }
      await rename(temp, destination);
      copiedFiles.push(destination);
    }
    if (typeof process.getuid !== 'function' || process.getuid() !== uploadUid || process.getgid() !== uploadGid) {
      await chown(destination, uploadUid, uploadGid);
    }
    await chmod(destination, 0o600);
    await client.query(
      `INSERT INTO file_objects (id,user_id,trade_id,legacy_storage_url,storage_key,original_name,content_type,byte_size,sha256,width,height)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,decode($9,'hex'),$10,$11)`,
      [screenshot.id,userId,resolvedTradeId,screenshot.legacyUrl,storageKey,screenshot.originalName,screenshot.contentType,screenshot.byteSize,screenshot.sha256,screenshot.width,screenshot.height],
    );
    const fileRow = (await client.query('SELECT id,encode(sha256,\'hex\') sha256 FROM file_objects WHERE storage_key=$1',[storageKey])).rows[0];
    assertDeterministicId(fileRow,screenshot.id,`screenshot ${screenshot.tradePath}#${screenshot.index}`);
    if (fileRow.sha256 !== screenshot.sha256) throw new Error(`screenshot database checksum mismatch: ${storageKey}`);
  }

  for (const doc of notificationDocs) {
    const [,uid,legacyId]=doc.path.match(/^users\/([^/]+)\/notifications\/([^/]+)$/); const d=doc.data;
    await client.query(`INSERT INTO notifications (id,user_id,legacy_firebase_doc_id,type,title,message,category,action_label,action_target,is_read,metadata,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,COALESCE($12::timestamptz,now()))`,
      [deterministicUuid(`notification:${doc.path}`),userIds.get(uid),legacyId,text(d.type)||'info',text(d.title)||'Notification',text(d.message)||'',text(d.category),text(d.actionLabel),text(d.actionTarget),bool(d.read),JSON.stringify(d),timestamp(d.createdAt)||timestamp(doc.createTime)||manifestCreatedAt]);
    const expectedId=deterministicUuid(`notification:${doc.path}`); const row=(await client.query('SELECT id FROM notifications WHERE user_id=$1 AND legacy_firebase_doc_id=$2',[userIds.get(uid),legacyId])).rows[0];
    assertDeterministicId(row,expectedId,`notification ${doc.path}`);
  }
  for (const doc of orderDocs) {
    const [,uid,legacyId]=doc.path.match(/^users\/([^/]+)\/orders\/([^/]+)$/); const d=doc.data;
    await client.query(`INSERT INTO broker_orders (id,user_id,legacy_firebase_doc_id,external_order_id,status,raw_payload,broker_updated_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [deterministicUuid(`order:${doc.path}`),userIds.get(uid),legacyId,text(d.order_id)||legacyId,text(d.status),JSON.stringify(d),timestamp(d.exchange_update_timestamp||d.order_timestamp)]);
    const expectedId=deterministicUuid(`order:${doc.path}`); const row=(await client.query('SELECT id FROM broker_orders WHERE user_id=$1 AND legacy_firebase_doc_id=$2',[userIds.get(uid),legacyId])).rows[0];
    assertDeterministicId(row,expectedId,`broker order ${doc.path}`);
  }
  for (const doc of duplicateDocs) {
    const [,uid,legacyId]=doc.path.match(/^users\/([^/]+)\/pendingDuplicates\/([^/]+)$/); const d=doc.data;
    const existingLegacy=text(d.existingTradeId); const existing=existingLegacy?tradeByLegacy.get(`${uid}:${existingLegacy}`):null;
    if (existingLegacy && !existing) throw new Error(`pending duplicate ${doc.path} references missing trade ${existingLegacy}`);
    await client.query(`INSERT INTO pending_duplicates (id,user_id,legacy_firebase_doc_id,incoming_trade,existing_trade_id,source,status,resolution,created_at,resolved_at)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,COALESCE($9::timestamptz,now()),$10)`,
      [deterministicUuid(`duplicate:${doc.path}`),userIds.get(uid),legacyId,JSON.stringify(d.incomingTrade||{}),existing?resolvedTradeIds.get(existing.path)||null:null,text(d.source),['pending','resolved','dismissed'].includes(d.status)?d.status:'pending',JSON.stringify(d.resolution||null),timestamp(d.createdAt)||timestamp(doc.createTime)||manifestCreatedAt,timestamp(d.resolvedAt)]);
    const expectedId=deterministicUuid(`duplicate:${doc.path}`); const row=(await client.query('SELECT id FROM pending_duplicates WHERE user_id=$1 AND legacy_firebase_doc_id=$2',[userIds.get(uid),legacyId])).rows[0];
    assertDeterministicId(row,expectedId,`pending duplicate ${doc.path}`);
  }

  for (const plan of moodPlans) {
      const userId=userIds.get(plan.uid); const mood=plan.mood;
      await client.query(`INSERT INTO mood_checkins (id,user_id,legacy_id,kind,emotion,confidence,notes,local_date,local_time,metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [plan.id,userId,plan.legacyId,text(mood.type)||'checkin',text(mood.emotion)||'Unknown',plan.confidence,text(mood.notes),plan.date,plan.time,JSON.stringify(mood)]);
      const row=(await client.query('SELECT id FROM mood_checkins WHERE user_id=$1 AND legacy_id=$2',[userId,plan.legacyId])).rows[0];
      assertDeterministicId(row,plan.id,`mood ${plan.uid}/${plan.legacyId}`);
  }
  for (const plan of journalPlans) {
      const userId=userIds.get(plan.uid);
      await client.query(`INSERT INTO daily_journal_entries (id,user_id,journal_date,entry,legacy_document)
        VALUES ($1,$2,$3,$4::jsonb,$4::jsonb)`,
        [plan.id,userId,plan.date,JSON.stringify(plan.entry)]);
      const row=(await client.query('SELECT id FROM daily_journal_entries WHERE user_id=$1 AND journal_date=$2',[userId,plan.date])).rows[0];
      assertDeterministicId(row,plan.id,`journal ${plan.uid}/${plan.date}`);
  }

  await client.query(`UPDATE edgebook_migration.batches SET status='promoted', promoted_at=now() WHERE batch_id=$1`,[args['batch-id']]);
  await client.query('COMMIT');
  process.stdout.write(`${JSON.stringify({ mode:'apply', batchId:args['batch-id'], planSummary, copiedFiles:copiedFiles.length },null,2)}\n`);
} catch (error) {
  await client.query('ROLLBACK').catch(()=>{});
  process.stderr.write(`Promotion failed; database rolled back. ${copiedFiles.length} checksum-addressed file(s) may remain as safe orphans for retry.\n`);
  throw error;
} finally { await client.end(); }
