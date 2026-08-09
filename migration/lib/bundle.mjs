import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      args[rawKey] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[rawKey] = argv[i + 1];
      i += 1;
    } else {
      args[rawKey] = true;
    }
  }
  return args;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function resolveContainedRegularFile(root, childPath) {
  if (typeof childPath !== 'string' || !childPath || isAbsolute(childPath)) {
    throw new Error(`bundle file path must be a non-empty relative path: ${childPath}`);
  }
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, childPath);
  const lexicalRelative = relative(canonicalRoot, candidate);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`)) {
    throw new Error(`bundle file escapes root: ${childPath}`);
  }
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`bundle file must be a regular non-symlink: ${childPath}`);
  const canonicalCandidate = await realpath(candidate);
  if (canonicalCandidate !== candidate) throw new Error(`bundle file path resolves through a symlink: ${childPath}`);
  const canonicalRelative = relative(canonicalRoot, canonicalCandidate);
  if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`)) {
    throw new Error(`bundle file resolves outside root: ${childPath}`);
  }
  return canonicalCandidate;
}

export async function* readNdjson(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      yield { lineNumber, value: JSON.parse(line) };
    } catch (error) {
      throw new Error(`${filePath}:${lineNumber}: invalid JSON: ${error.message}`);
    }
  }
}

export async function appendNdjson(handle, value) {
  await handle.write(`${canonicalJson(value)}\n`);
}

export async function openNdjson(filePath) {
  return open(filePath, 'wx', 0o600);
}

export function encodeFirestoreValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(encodeFirestoreValue);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $type: 'bytes', value: Buffer.from(value).toString('base64') };
  }
  if (value instanceof Date) return { $type: 'date', value: value.toISOString() };
  if (typeof value === 'object') {
    if (typeof value.toDate === 'function' && typeof value.toMillis === 'function') {
      return { $type: 'timestamp', value: value.toDate().toISOString() };
    }
    if (typeof value.latitude === 'number' && typeof value.longitude === 'number') {
      return { $type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
    }
    if (typeof value.path === 'string' && value.firestore) {
      return { $type: 'reference', path: value.path };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, encodeFirestoreValue(child)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { $type: 'nonfinite-number', value: String(value) };
  }
  return value;
}

const BROKER_CREDENTIAL_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'bearertoken',
  'requesttoken',
  'idtoken',
  'oauthtoken',
  'token',
  'tokenciphertext',
  'accesstokenciphertext',
  'refreshtokenciphertext',
  'authorization',
  'authorizationheader',
  'clientsecret',
  'apisecret',
  'apikey',
  'secretkey',
  'privatekey',
  'consumersecret',
  'authorizationcode',
  'oauthcode',
  'passwordhash',
  'passwordsalt',
  'secret',
  'password',
]);

function isCredentialKey(key) {
  // Treat camelCase, snake_case, kebab-case and spaced variants identically.
  // This is intentionally used only on exported private user documents, where
  // retaining an OAuth/broker credential is more dangerous than dropping a
  // custom field that happens to use one of these exact normalized names.
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (BROKER_CREDENTIAL_KEYS.has(normalized)) return true;
  return /(?:^|encrypted|legacy|ctrader|zerodha)(?:access|refresh|bearer|request|id|oauth|session)token(?:ciphertext)?$/.test(normalized);
}

function sanitizeCredentialUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return { value, changed: false };
  let parsed;
  try { parsed = new URL(value); } catch { return { value, changed: false }; }
  let changed = false;
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
    changed = true;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (isCredentialKey(key) || ['code', 'state', 'signature', 'credential', 'xgoogsignature', 'xgoogcredential'].includes(normalized)) {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }
  if (parsed.hash && /(?:token|code|state|secret|password|credential|signature)/i.test(parsed.hash)) {
    parsed.hash = '';
    changed = true;
  }
  return { value: changed ? parsed.toString() : value, changed };
}

function containsCredentialUrl(value) {
  return sanitizeCredentialUrl(value).changed;
}

export function redactBrokerCredentials(value, trail = [], redacted = []) {
  if (Array.isArray(value)) {
    return {
      value: value.map((item, index) =>
        redactBrokerCredentials(item, [...trail, String(index)], redacted).value,
      ),
      redacted,
    };
  }
  if (typeof value === 'string') {
    const sanitized = sanitizeCredentialUrl(value);
    if (sanitized.changed) redacted.push(`${trail.join('.')}.$urlCredential`.replace(/^\./, ''));
    return { value: sanitized.value, redacted };
  }
  if (!value || typeof value !== 'object') return { value, redacted };

  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (isCredentialKey(key)) {
      redacted.push([...trail, key].join('.'));
      continue;
    }
    clean[key] = redactBrokerCredentials(child, [...trail, key], redacted).value;
  }
  return { value: clean, redacted };
}

export function findForbiddenCredentialPaths(value, trail = [], found = []) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => findForbiddenCredentialPaths(child, [...trail, String(index)], found));
    return found;
  }
  if (typeof value === 'string') {
    if (containsCredentialUrl(value)) found.push(`${trail.join('.')}.$urlCredential`.replace(/^\./, ''));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (isCredentialKey(key)) found.push([...trail, key].join('.'));
    findForbiddenCredentialPaths(child, [...trail, key], found);
  }
  return found;
}

export function decodeTaggedScalar(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value.$type === 'timestamp' || value.$type === 'date') return value.value;
  if (value.$type === 'nonfinite-number') return value.value;
  return value;
}
