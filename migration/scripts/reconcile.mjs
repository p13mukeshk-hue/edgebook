#!/usr/bin/env node
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { processMigrationImage } from '../lib/image.mjs';
import { mergeSettings, settingsAccounts } from '../lib/settings.mjs';
import {
  canonicalJson,
  decodeTaggedScalar,
  parseArgs,
  readNdjson,
  resolveContainedRegularFile,
  sha256File,
  sha256Text,
  findForbiddenCredentialPaths,
} from '../lib/bundle.mjs';

function usage(message) {
  if (message) process.stderr.write(`ERROR: ${message}\n\n`);
  process.stderr.write(`Usage:
  node scripts/reconcile.mjs --source-bundle /absolute/firebase-export \\
    --browser-local /absolute/browser-local.json \\
    --target /absolute/target-snapshot.ndjson [--report /absolute/report.json]
`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
if (!args['source-bundle'] || !isAbsolute(args['source-bundle'])) usage('--source-bundle must be absolute');
if (!args['browser-local'] || !isAbsolute(args['browser-local'])) usage('--browser-local must be absolute');
if (!args.target || !isAbsolute(args.target)) usage('--target must be absolute');
if (args.report && !isAbsolute(args.report)) usage('--report must be absolute');

const sourceBundle = await realpath(resolve(args['source-bundle']));
const manifest = JSON.parse(await readFile(await resolveContainedRegularFile(sourceBundle, 'manifest.json'), 'utf8'));
if (manifest.formatVersion !== 1) throw new Error(`unsupported bundle formatVersion ${manifest.formatVersion}`);
const requiredManifestFiles = ['auth-users.ndjson', 'firestore.ndjson', 'storage.ndjson'];
if (canonicalJson(Object.keys(manifest.files || {}).sort()) !== canonicalJson([...requiredManifestFiles].sort())) {
  throw new Error(`manifest files must be exactly: ${requiredManifestFiles.join(', ')}`);
}
const sourceFiles = new Map();
for (const name of requiredManifestFiles) {
  const file = await resolveContainedRegularFile(sourceBundle, name);
  const expected = manifest.files[name];
  if (!/^[a-f0-9]{64}$/.test(expected || '') || await sha256File(file) !== expected) {
    throw new Error(`source bundle checksum mismatch for ${name}`);
  }
  sourceFiles.set(name, file);
}
const sourceFile = sourceFiles.get('firestore.ndjson');
const targetFile = resolve(args.target);
const browserLocal = JSON.parse(await readFile(resolve(args['browser-local']), 'utf8'));
if (!browserLocal.users || typeof browserLocal.users !== 'object' || Array.isArray(browserLocal.users)) {
  throw new Error('browser-local file must contain a users object');
}
const forbiddenBrowserFields = findForbiddenCredentialPaths(browserLocal);
if (forbiddenBrowserFields.length) {
  throw new Error(`browser-local export contains forbidden credentials: ${forbiddenBrowserFields.join(', ')}`);
}

function scalar(value) {
  return decodeTaggedScalar(value);
}
function first(data, ...fields) {
  for (const field of fields) {
    const value = scalar(data?.[field]);
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}
function numeric(value) {
  const raw = scalar(value);
  if (raw === null || raw === undefined || typeof raw === 'boolean' || (typeof raw === 'string' && raw.trim() === '')) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
function textValue(value) {
  const raw = scalar(value);
  return raw === null || raw === undefined ? null : String(raw);
}
function normalizedDate(value) {
  const raw = scalar(value);
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const millis = Math.abs(raw) < 10_000_000_000 ? raw * 1_000 : raw;
    const parsed = new Date(millis);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
  }
  const valueText = String(raw);
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(valueText)
    ? valueText
    : normalizedTimestamp(valueText)?.slice(0, 10) || null;
  const match = candidate?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? candidate : null;
}
function normalizedTimestamp(value) {
  const raw = scalar(value);
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const millis = Math.abs(raw) < 10_000_000_000 ? raw * 1_000 : raw;
    const parsed = new Date(millis);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  const valueText = String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(valueText)) {
    return normalizedDate(valueText) === valueText ? `${valueText}T00:00:00.000Z` : null;
  }
  const iso = valueText.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/i);
  if (iso) {
    if (normalizedDate(iso[1]) !== iso[1] || Number(iso[2]) > 23 || Number(iso[3]) > 59
        || Number(iso[4] || 0) > 59 || Number(iso[6] || 0) > 23 || Number(iso[7] || 0) > 59) return null;
  } else if (!/^[A-Za-z]{3},\s.+(?:GMT|UTC)$/i.test(valueText)) return null;
  const parsed = new Date(valueText);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function normalizedTime(value) {
  const valueText = first({ value }, 'value');
  const match = valueText === null ? null : String(valueText).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] || 0) > 59) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}:${String(Number(match[3] || 0)).padStart(2, '0')}`;
}
function normalizedDirection(value) {
  const direction = String(value || '').toLowerCase();
  if (direction === 'long' || direction === 'buy') return 'Long';
  if (direction === 'short' || direction === 'sell') return 'Short';
  return value ?? null;
}
function normalizeScreenshot(value) {
  if (typeof value === 'string') return { name: null };
  if (!value || typeof value !== 'object') return { name: null };
  return { name: value.name || null };
}
function normalizedScreenshots(data) {
  return (Array.isArray(data?.screenshots) ? data.screenshots : [])
    .map(normalizeScreenshot)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}
function sourceInfo(data) {
  const rawSource = String(first(data, 'source') || 'manual').toLowerCase();
  const broker = String(first(data, 'broker') || '').toLowerCase();
  return {
    sourceSystem: rawSource === 'csv' && broker ? broker : rawSource,
    ingestionMethod: first(data, 'ingestionMethod') || (rawSource === 'manual' ? 'manual' : rawSource === 'csv' ? 'csv' : 'migration'),
  };
}
function tradeMapping(data, uid, accountKeys, brokerKeys) {
  const source = sourceInfo(data);
  const rawLegacyAccountId = first(data, 'accountId');
  const legacyAccountId = rawLegacyAccountId === null ? null : String(rawLegacyAccountId);
  let legacyBrokerDocumentId = first(data, 'brokerDocId');
  if (!legacyBrokerDocumentId && source.sourceSystem === 'zerodha') legacyBrokerDocumentId = 'zerodha';
  if (!legacyBrokerDocumentId && source.sourceSystem === 'ctrader') {
    const cTraderAccountId = first(data, 'ctraderAccountId');
    legacyBrokerDocumentId = cTraderAccountId ? `ctrader_${cTraderAccountId}` : 'ctrader';
  }
  if (legacyBrokerDocumentId !== null) legacyBrokerDocumentId = String(legacyBrokerDocumentId);
  const linkedLegacyAccountId = legacyAccountId && accountKeys.has(compoundKey(uid, legacyAccountId))
    ? legacyAccountId : null;
  const linkedLegacyBrokerDocumentId = legacyBrokerDocumentId && brokerKeys.has(compoundKey(uid, legacyBrokerDocumentId))
    ? legacyBrokerDocumentId : null;
  return {
    sourceSystem: source.sourceSystem,
    ingestionMethod: String(source.ingestionMethod),
    legacyAccountId,
    linkedLegacyAccountId,
    legacyBrokerDocumentId: linkedLegacyBrokerDocumentId,
  };
}
function jsonValue(value, fallback) {
  const raw = scalar(value);
  return raw && typeof raw === 'object' ? raw : fallback;
}
function firebaseObjectName(url) {
  try {
    const match = new URL(url).pathname.match(/\/o\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch { return null; }
}
function embeddedBytes(url) {
  const match = String(url).match(/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  return match ? Buffer.from(match[1].replace(/\s/g,''),'base64') : null;
}
function canonicalTrade(data, deletedFallback = null) {
  const deleted = scalar(data?.deleted) === true || scalar(data?.deleted) === 'true';
  const source = sourceInfo(data);
  return {
    externalTradeKey: first(data, 'externalTradeKey'),
    brokerTradeId: first(data, 'brokerTradeId'),
    symbol: first(data, 'symbol', 'tradingsymbol'),
    asset: first(data, 'asset'),
    instrument: first(data, 'instrument'),
    optionType: first(data, 'optionType'),
    strike: numeric(first(data, 'strike')),
    expiry: normalizedDate(first(data, 'expiry')),
    exchange: textValue(first(data, 'exchange')),
    product: first(data, 'product'),
    date: normalizedDate(first(data, 'date', 'fill_timestamp', 'order_timestamp')),
    entry: numeric(first(data, 'entry', 'average_price')),
    exit: numeric(first(data, 'exit')),
    size: numeric(first(data, 'size', 'quantity')),
    pnl: numeric(first(data, 'pnl')),
    sl: numeric(first(data, 'sl')),
    tp: numeric(first(data, 'tp')),
    sourceSystem: source.sourceSystem,
    ingestionMethod: source.ingestionMethod,
    accountId: first(data, 'accountId'),
    deleted,
    deletedAt: deleted ? normalizedTimestamp(scalar(data?.deletedAt) ?? deletedFallback) : null,
    entryTime: normalizedTime(first(data, 'entryTime')),
    exitTime: normalizedTime(first(data, 'exitTime')),
    direction: normalizedDirection(first(data, 'direction', 'transaction_type')),
    strategy: first(data, 'strategy'),
    emotion: first(data, 'emotion'),
    notes: first(data, 'notes'),
    psychology: jsonValue(data?.psychology, {}),
    tags: jsonValue(data?.tags, []),
    custom: jsonValue(data?.custom, {}),
    needsReview: scalar(data?.needsReview) ?? null,
    groupingMode: scalar(data?.groupingMode) ?? null,
    lotSize: numeric(first(data, 'lotSize')),
    isOpen: scalar(data?.isOpen) === null || scalar(data?.isOpen) === undefined
      ? null : (scalar(data?.isOpen) === true || scalar(data?.isOpen) === 'true'),
    screenshots: normalizedScreenshots(data),
  };
}
function fingerprintData(data, deletedFallback = null) {
  return sha256Text(canonicalJson(canonicalTrade(data, deletedFallback)));
}
function classifyTradeMaterialization(data, deletedFallback = null) {
  const canonical = canonicalTrade(data, deletedFallback);
  const source = sourceInfo(data);
  const supplied = field => {
    const value = scalar(data?.[field]);
    return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');
  };
  const optionalNumbersValid = ['strike', 'exit', 'pnl', 'sl', 'tp']
    .every(field => !supplied(field) || numeric(data[field]) !== null);
  const knownCorruptLegacyTime = field => source.sourceSystem === 'zerodha' &&
    /^20\d{2}\s*$/.test(String(scalar(data?.[field])));
  const otherRequiredFieldsValid = Boolean(canonical.date && ['Long', 'Short'].includes(canonical.direction) &&
    canonical.entry !== null && canonical.entry > 0 && canonical.size !== null && canonical.size > 0 &&
    optionalNumbersValid && (!supplied('entryTime') || canonical.entryTime || knownCorruptLegacyTime('entryTime')) &&
    (!supplied('exitTime') || canonical.exitTime || knownCorruptLegacyTime('exitTime')) &&
    (!supplied('expiry') || canonical.expiry) &&
    (!canonical.deleted || canonical.deletedAt));
  const valid = Boolean(canonical.symbol && otherRequiredFieldsValid);
  if (valid) return { materialize: true, reason: null };
  const deletionTombstoneWithoutBody = canonical.deleted && Boolean(canonical.deletedAt) &&
    Object.keys(data).every(key => key === 'deleted' || key === 'deletedAt');
  if (deletionTombstoneWithoutBody) return { materialize: false, reason: 'deletion-tombstone-without-body' };
  if (!canonical.symbol && otherRequiredFieldsValid) return { materialize: false, reason: 'missing-symbol' };
  throw new Error('source contains an invalid trade that was not eligible for raw-only preservation');
}
function compoundKey(...parts) {
  return canonicalJson(parts);
}

function summarize(trades, deletedFallbacks = new Map()) {
  const summary = {
    total: trades.size,
    active: 0,
    archived: 0,
    pnlSum: 0,
    screenshotRefs: 0,
    earliestDate: null,
    latestDate: null,
    bySource: {},
    byUser: {},
  };
  for (const [path, data] of trades) {
    const canonical = canonicalTrade(data, deletedFallbacks.get(path) || null);
    const match = path.match(/^users\/([^/]+)\/trades\/[^/]+$/);
    const uid = match?.[1] || 'unknown';
    summary[canonical.deleted ? 'archived' : 'active'] += 1;
    if (canonical.pnl !== null) summary.pnlSum += canonical.pnl;
    summary.screenshotRefs += canonical.screenshots.length;
    const source = String(canonical.sourceSystem || 'manual');
    summary.bySource[source] = (summary.bySource[source] || 0) + 1;
    summary.byUser[uid] = (summary.byUser[uid] || 0) + 1;
    const date = canonical.date;
    if (date) {
      if (!summary.earliestDate || date < summary.earliestDate) summary.earliestDate = date;
      if (!summary.latestDate || date > summary.latestDate) summary.latestDate = date;
    }
  }
  summary.pnlSum = Number(summary.pnlSum.toFixed(8));
  return summary;
}

const sourceTrades = new Map();
const sourceTradeDeletedFallbacks = new Map();
const sourceTradeFiles = new Map();
const sourceUnmaterializedTrades = new Map();
const sourceRawDocuments = new Map();
const sourceMaterializedDocuments = new Set();
const sourceSettingsDocuments = new Map();
const sourceBrokerDocuments = [];
for await (const { value } of readNdjson(sourceFile)) {
  if (!value.path || sourceRawDocuments.has(value.path)) throw new Error(`duplicate or missing source path ${value.path || '<missing>'}`);
  const forbidden = findForbiddenCredentialPaths(value.data);
  if (forbidden.length) throw new Error(`${value.path} contains forbidden credentials: ${forbidden.join(', ')}`);
  sourceRawDocuments.set(value.path, sha256Text(canonicalJson(value.data)));
  if (/^users\/[^/]+\/(?:notifications|orders|pendingDuplicates)\/[^/]+$/.test(value.path)) {
    sourceMaterializedDocuments.add(value.path);
  }
  if (/^users\/[^/]+\/trades\/[^/]+$/.test(value.path)) {
    const deletedFallback = normalizedTimestamp(value.updateTime) || normalizedTimestamp(manifest.createdAt);
    const classification = classifyTradeMaterialization(value.data, deletedFallback);
    if (classification.materialize) {
      sourceTrades.set(value.path, value.data);
      sourceTradeDeletedFallbacks.set(value.path, deletedFallback);
    } else {
      sourceUnmaterializedTrades.set(value.path, classification.reason);
    }
  }
  const settingsMatch = value.path.match(/^users\/([^/]+)\/meta\/settings$/);
  if (settingsMatch) sourceSettingsDocuments.set(settingsMatch[1], value.data);
  if (/^users\/[^/]+\/brokers\/[^/]+$/.test(value.path)) sourceBrokerDocuments.push(value);
}
if (manifest.counts?.firestoreDocuments !== sourceRawDocuments.size) {
  throw new Error('source manifest Firestore count does not match records');
}
const sourceStorage = new Map();
for await (const { value } of readNdjson(sourceFiles.get('storage.ndjson'))) {
  if (!value.name || sourceStorage.has(value.name)) throw new Error(`duplicate or missing source Storage object ${value.name || '<missing>'}`);
  const forbidden = findForbiddenCredentialPaths(value);
  if (forbidden.length) throw new Error(`source Storage record contains forbidden credentials: ${forbidden.join(', ')}`);
  sourceStorage.set(value.name,value);
}
if (manifest.counts?.storageObjects !== sourceStorage.size) throw new Error('source manifest Storage count does not match records');
if (!manifest.includesStorageObjects && sourceStorage.size !== 0) {
  throw new Error('source manifest says Storage objects were not included but storage.ndjson is non-empty');
}
for (const [path,data] of sourceTrades) {
  const files=[];
  for (const [index,screenshot] of (Array.isArray(data?.screenshots)?data.screenshots:[]).entries()) {
    const src=typeof screenshot==='string'?screenshot:screenshot?.src;
    const requestedName=basename(String((typeof screenshot==='object'&&screenshot?.name)||`screenshot-${index+1}`)).slice(0,255);
    const name=requestedName&&requestedName!=='.'&&requestedName!=='..'?requestedName:`screenshot-${index+1}`;
    const storage=sourceStorage.get(firebaseObjectName(src));
    let bytes=embeddedBytes(src);
    if (!bytes && storage?.localPath) {
      const sourcePath=await resolveContainedRegularFile(sourceBundle,storage.localPath);
      if (await sha256File(sourcePath)!==storage.sha256) throw new Error(`source Storage checksum mismatch: ${storage.name}`);
      bytes=await readFile(sourcePath);
    }
    const processed=bytes?await processMigrationImage(bytes):null;
    files.push({name,sha256:processed?.sha256||null});
  }
  files.sort((left,right)=>canonicalJson(left).localeCompare(canonicalJson(right)));
  sourceTradeFiles.set(path,files);
}
const sourceIdentities = new Map();
for await (const { value } of readNdjson(sourceFiles.get('auth-users.ndjson'))) {
  if (!value.uid || sourceIdentities.has(value.uid)) throw new Error(`duplicate or missing source identity ${value.uid || '<missing>'}`);
  const forbidden = findForbiddenCredentialPaths(value);
  if (forbidden.length) throw new Error(`source Auth identity ${value.uid} contains forbidden credentials: ${forbidden.join(', ')}`);
  const googleSub = value.providers?.find((provider) => provider.providerId === 'google.com')?.uid || null;
  if (!googleSub || value.emailVerified !== true) throw new Error(`source identity ${value.uid} is not a verified Google identity`);
  sourceIdentities.set(value.uid, googleSub);
}
if (manifest.counts?.authUsers !== sourceIdentities.size) throw new Error('source manifest Auth count does not match records');

for (const uid of Object.keys(browserLocal.users)) {
  if (!sourceIdentities.has(uid)) throw new Error(`browser-local uid not in Auth export: ${uid}`);
}
const missingBrowserUsers = [...sourceIdentities.keys()].filter((uid) => !Object.hasOwn(browserLocal.users, uid));
if (missingBrowserUsers.length) throw new Error(`browser-local export is missing Auth users: ${missingBrowserUsers.join(', ')}`);
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
const sourceSettings = new Map();
const sourceAccounts = new Map();
for (const uid of sourceIdentities.keys()) {
  const merged = mergeSettings(sourceSettingsDocuments.get(uid), browserLocal.users[uid]?.settings);
  sourceSettings.set(uid, merged);
  for (const account of settingsAccounts(merged.accounts)) {
    const legacyId = first(account, 'id');
    if (!legacyId) throw new Error(`merged account has no id for ${uid}`);
    const key = compoundKey(uid, String(legacyId));
    if (sourceAccounts.has(key)) throw new Error(`duplicate merged account ${uid}/${legacyId}`);
    sourceAccounts.set(key, account);
  }
}
const sourceBrokers = new Map();
for (const document of sourceBrokerDocuments) {
  const [, uid, legacyId] = document.path.match(/^users\/([^/]+)\/brokers\/([^/]+)$/);
  const provider = legacyId.startsWith('ctrader')
    ? 'ctrader'
    : legacyId === 'zerodha' ? 'zerodha' : String(first(document.data, 'provider') || legacyId);
  const mappedLegacyAccountId = sourceSettings.get(uid)?.brokerAccountMap?.[legacyId]
    || sourceSettings.get(uid)?.brokerAccountMap?.[provider]
    || first(document.data, 'mapToEdgebookAccountId')
    || null;
  sourceBrokers.set(compoundKey(uid, legacyId), {
    provider,
    externalAccountId: first(document.data, 'accountId', 'userId'),
    accountLabel: first(document.data, 'accountLabel', 'userName'),
    mappedLegacyAccountId: mappedLegacyAccountId === null ? null : String(mappedLegacyAccountId),
    connected: false,
    credentialsPresent: false,
    metadata: document.data,
  });
}
const sourceTradeMappings = new Map([...sourceTrades].map(([path, data]) => {
  const uid = path.split('/')[1];
  return [path, tradeMapping(data, uid, sourceAccounts, sourceBrokers)];
}));
const sourceMoods = new Map();
const sourceJournals = new Map();
for (const [uid, local] of Object.entries(browserLocal.users)) {
  if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error(`invalid browser-local record for ${uid}`);
  if (local.moods !== undefined && !Array.isArray(local.moods)) throw new Error(`browser-local moods must be an array for ${uid}`);
  if (local.dailyJournal !== undefined && (!local.dailyJournal || typeof local.dailyJournal !== 'object' || Array.isArray(local.dailyJournal))) {
    throw new Error(`browser-local dailyJournal must be an object for ${uid}`);
  }
  for (const mood of local.moods || []) {
    const legacyId = first(mood, 'id') || sha256Text(canonicalJson(mood)).slice(0, 32);
    const key = compoundKey(uid, String(legacyId));
    if (sourceMoods.has(key)) throw new Error(`duplicate browser-local mood ${uid}/${legacyId}`);
    sourceMoods.set(key, mood);
  }
  for (const [date, entry] of Object.entries(local.dailyJournal || {})) {
    sourceJournals.set(compoundKey(uid, date), entry);
  }
}

const targetTrades = new Map();
const targetTradeFiles = new Map();
const targetTradeMappings = new Map();
const targetRawDocuments = new Map();
const targetMaterializedDocuments = new Set();
const targetIdentities = new Map();
const targetSettings = new Map();
const targetAccounts = new Map();
const targetBrokers = new Map();
const targetMoods = new Map();
const targetJournals = new Map();
for await (const { lineNumber, value } of readNdjson(targetFile)) {
  const recordType = value.recordType || (value.legacyPath ? 'trade' : null);
  if (recordType === 'trade') {
    if (!value.legacyPath || typeof value.data !== 'object') throw new Error(`${targetFile}:${lineNumber}: invalid trade record`);
    if (targetTrades.has(value.legacyPath)) throw new Error(`duplicate target trade ${value.legacyPath}`);
    targetTrades.set(value.legacyPath, value.data);
    targetTradeFiles.set(value.legacyPath, Array.isArray(value.mapped?.files) ? value.mapped.files : []);
    targetTradeMappings.set(value.legacyPath, {
      sourceSystem: value.mapped?.sourceSystem ?? null,
      ingestionMethod: value.mapped?.ingestionMethod ?? null,
      legacyAccountId: value.mapped?.legacyAccountId ?? null,
      linkedLegacyAccountId: value.mapped?.linkedLegacyAccountId ?? null,
      legacyBrokerDocumentId: value.mapped?.legacyBrokerDocumentId ?? null,
    });
  } else if (recordType === 'rawDocument') {
    if (!value.sourcePath || !value.payloadSha256 || targetRawDocuments.has(value.sourcePath)) {
      throw new Error(`${targetFile}:${lineNumber}: invalid or duplicate rawDocument record`);
    }
    targetRawDocuments.set(value.sourcePath, value.payloadSha256);
  } else if (recordType === 'materializedDocument') {
    if (!value.sourcePath || targetMaterializedDocuments.has(value.sourcePath) ||
        !/^users\/[^/]+\/(?:notifications|orders|pendingDuplicates)\/[^/]+$/.test(value.sourcePath)) {
      throw new Error(`${targetFile}:${lineNumber}: invalid or duplicate materializedDocument record`);
    }
    targetMaterializedDocuments.add(value.sourcePath);
  } else if (recordType === 'identity') {
    if (!value.firebaseUid || targetIdentities.has(value.firebaseUid)) {
      throw new Error(`${targetFile}:${lineNumber}: invalid or duplicate identity record`);
    }
    targetIdentities.set(value.firebaseUid, value.googleSub || null);
  } else if (recordType === 'settings') {
    if (!value.firebaseUid || typeof value.data !== 'object' || targetSettings.has(value.firebaseUid)) {
      throw new Error(`${targetFile}:${lineNumber}: invalid or duplicate settings record`);
    }
    targetSettings.set(value.firebaseUid, value.data);
  } else if (recordType === 'account') {
    const key = compoundKey(value.firebaseUid, value.legacyAccountId);
    if (!value.firebaseUid || !value.legacyAccountId || typeof value.data !== 'object' || targetAccounts.has(key)) {
      throw new Error(`${targetFile}:${lineNumber}: invalid or duplicate account record`);
    }
    targetAccounts.set(key, value.data);
  } else if (recordType === 'broker') {
    const key = compoundKey(value.firebaseUid, value.legacyDocumentId);
    if (!value.firebaseUid || !value.legacyDocumentId || typeof value.data !== 'object' || targetBrokers.has(key)) {
      throw new Error(`${targetFile}:${lineNumber}: invalid or duplicate broker record`);
    }
    targetBrokers.set(key, value.data);
  } else if (recordType === 'mood') {
    const key = compoundKey(value.firebaseUid, value.legacyId);
    if (!value.firebaseUid || !value.legacyId || typeof value.data !== 'object' || targetMoods.has(key)) {
      throw new Error(`${targetFile}:${lineNumber}: invalid or duplicate mood record`);
    }
    targetMoods.set(key, value.data);
  } else if (recordType === 'journal') {
    const key = compoundKey(value.firebaseUid, value.date);
    if (!value.firebaseUid || !value.date || typeof value.data !== 'object' || targetJournals.has(key)) {
      throw new Error(`${targetFile}:${lineNumber}: invalid or duplicate journal record`);
    }
    targetJournals.set(key, value.data);
  } else {
    throw new Error(`${targetFile}:${lineNumber}: unknown recordType`);
  }
}

function compareMaps(source, target, valueMatches = (left, right) => left === right) {
  const missing = [];
  const extra = [];
  const mismatched = [];
  for (const [key, value] of source) {
    if (!target.has(key)) missing.push(key);
    else if (!valueMatches(value, target.get(key), key)) mismatched.push(key);
  }
  for (const key of target.keys()) if (!source.has(key)) extra.push(key);
  return { missing, extra, mismatched };
}

const tradeComparison = compareMaps(sourceTrades,targetTrades,(sourceData,targetData,path) => {
  const targetFiles=(targetTradeFiles.get(path)||[])
    .map(file=>({name:file.name||null,sha256:file.sha256||null}))
    .sort((left,right)=>canonicalJson(left).localeCompare(canonicalJson(right)));
  return fingerprintData(sourceData, sourceTradeDeletedFallbacks.get(path) || null) === fingerprintData(targetData) &&
    canonicalJson(sourceTradeFiles.get(path)||[]) === canonicalJson(targetFiles);
});
const tradeMappingComparison = compareMaps(sourceTradeMappings,targetTradeMappings,
  (source, target) => canonicalJson(source) === canonicalJson(target));
const rawComparison = compareMaps(sourceRawDocuments,targetRawDocuments);
const materializedComparison = compareMaps(
  new Map([...sourceMaterializedDocuments].map(path => [path, true])),
  new Map([...targetMaterializedDocuments].map(path => [path, true])),
);
const identityComparison = compareMaps(sourceIdentities,targetIdentities);
const settingsComparison = compareMaps(sourceSettings,targetSettings,
  (source, target) => canonicalJson(source) === canonicalJson(target));
const accountComparison = compareMaps(sourceAccounts,targetAccounts,
  (source, target) => canonicalJson(source) === canonicalJson(target));
const brokerComparison = compareMaps(sourceBrokers,targetBrokers,
  (source, target) => canonicalJson(source) === canonicalJson(target));
const moodComparison = compareMaps(sourceMoods,targetMoods,
  (source, target) => canonicalJson(source) === canonicalJson(target));
const journalComparison = compareMaps(sourceJournals,targetJournals,
  (source, target) => canonicalJson(source) === canonicalJson(target));
const sourceSummary = summarize(sourceTrades, sourceTradeDeletedFallbacks);
const targetSummary = summarize(targetTrades);
const summaryMatch = canonicalJson(sourceSummary) === canonicalJson(targetSummary);
const truncate = values => values.slice(0, 100);
const comparisonReport = (source, target, comparison) => ({
  sourceCount: source.size,
  targetCount: target.size,
  missingCount: comparison.missing.length,
  extraCount: comparison.extra.length,
  mismatchedCount: comparison.mismatched.length,
  missing: truncate(comparison.missing),
  extra: truncate(comparison.extra),
  mismatched: truncate(comparison.mismatched),
});
const report = {
  generatedAt: new Date().toISOString(),
  sourceSummary,
  unmaterializedSourceTrades: {
    count: sourceUnmaterializedTrades.size,
    records: truncate([...sourceUnmaterializedTrades].map(([path, reason]) => ({ path, reason }))),
  },
  targetSummary,
  summaryMatch,
  trades: {
    missingCount: tradeComparison.missing.length,
    extraCount: tradeComparison.extra.length,
    mismatchedCount: tradeComparison.mismatched.length,
    missing: truncate(tradeComparison.missing),
    extra: truncate(tradeComparison.extra),
    mismatched: truncate(tradeComparison.mismatched),
  },
  tradeMappings: comparisonReport(sourceTradeMappings,targetTradeMappings,tradeMappingComparison),
  rawDocuments: comparisonReport(sourceRawDocuments,targetRawDocuments,rawComparison),
  materializedDocuments: comparisonReport(
    new Map([...sourceMaterializedDocuments].map(path => [path, true])),
    new Map([...targetMaterializedDocuments].map(path => [path, true])),
    materializedComparison,
  ),
  identities: comparisonReport(sourceIdentities,targetIdentities,identityComparison),
  settings: comparisonReport(sourceSettings,targetSettings,settingsComparison),
  accounts: comparisonReport(sourceAccounts,targetAccounts,accountComparison),
  brokers: comparisonReport(sourceBrokers,targetBrokers,brokerComparison),
  moods: comparisonReport(sourceMoods,targetMoods,moodComparison),
  journals: comparisonReport(sourceJournals,targetJournals,journalComparison),
};
const comparisons = [tradeComparison,tradeMappingComparison,rawComparison,materializedComparison,identityComparison,settingsComparison,
  accountComparison,brokerComparison,moodComparison,journalComparison];
report.truncated = comparisons
  .some(comparison => comparison.missing.length > 100 || comparison.extra.length > 100 || comparison.mismatched.length > 100);

if (args.report) await writeFile(resolve(args.report), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
const failed = !summaryMatch || comparisons
  .some(comparison => comparison.missing.length || comparison.extra.length || comparison.mismatched.length);
if (failed) process.exitCode = 1;
