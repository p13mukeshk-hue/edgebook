import { decodeTaggedScalar } from './bundle.mjs';

function scalar(value) {
  return decodeTaggedScalar(value);
}

function text(value) {
  const decoded = scalar(value);
  return decoded === null || decoded === undefined || decoded === '' ? null : String(decoded);
}

export function settingsObject(value, label = 'settings') {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function settingsAccounts(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return Object.values(value);
  throw new Error('settings accounts must be an array or numeric-keyed object');
}

function comparableTimestamp(value) {
  const decoded = scalar(value);
  if (typeof decoded === 'number' && Number.isFinite(decoded)) return decoded;
  const parsed = Date.parse(String(decoded ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function mergeSettings(remoteInput, localInput) {
  const remote = settingsObject(remoteInput, 'Firestore settings');
  const local = settingsObject(localInput, 'browser-local settings');
  const accountMap = (accounts, label) => {
    const map = new Map();
    for (const account of settingsAccounts(accounts)) {
      const id = text(account?.id);
      if (!id) throw new Error(`${label} account has no id`);
      if (map.has(id)) throw new Error(`${label} has duplicate account id ${id}`);
      map.set(id, account);
    }
    return map;
  };
  const remoteById = accountMap(remote.accounts, 'Firestore settings');
  const localById = accountMap(local.accounts, 'browser-local settings');
  const identifiedList = (value, label) => {
    const list = settingsAccounts(value);
    const seen = new Set();
    for (const item of list) {
      const id = text(item?.id);
      if (!id) throw new Error(`${label} item has no id`);
      if (seen.has(id)) throw new Error(`${label} has duplicate id ${id}`);
      seen.add(id);
    }
    return list;
  };
  const accounts = [...remoteById.values()].map((remoteAccount) => {
    const id = text(remoteAccount?.id);
    const localAccount = localById.get(id);
    if (id) localById.delete(id);
    if (!localAccount) return remoteAccount;
    return comparableTimestamp(localAccount.updatedAt) > comparableTimestamp(remoteAccount.updatedAt)
      ? localAccount
      : remoteAccount;
  });
  accounts.push(...localById.values());
  const nestedRemoteWins = (key) => ({
    ...settingsObject(local[key], `browser-local ${key}`),
    ...settingsObject(remote[key], `Firestore ${key}`),
  });
  const merged = {
    ...local,
    ...remote,
    accounts,
    brokerAccountMap: {
      ...settingsObject(remote.brokerAccountMap, 'Firestore brokerAccountMap'),
      ...settingsObject(local.brokerAccountMap, 'browser-local brokerAccountMap'),
    },
    prefs: nestedRemoteWins('prefs'),
    formFields: nestedRemoteWins('formFields'),
    widgets: nestedRemoteWins('widgets'),
    sidebarSections: nestedRemoteWins('sidebarSections'),
  };
  const remoteCustomFields = identifiedList(remote.customFields, 'Firestore custom fields');
  const localCustomFields = identifiedList(local.customFields, 'browser-local custom fields');
  if (remoteCustomFields.length) merged.customFields = remoteCustomFields;
  else if (localCustomFields.length) merged.customFields = localCustomFields;
  return merged;
}
