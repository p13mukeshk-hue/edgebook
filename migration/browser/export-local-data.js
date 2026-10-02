/*
 * Edge Book one-time browser-local export utility.
 *
 * Operator use: while signed in to the legacy app at exactly
 * https://edgebook.trade or https://www.edgebook.trade, paste this entire file
 * into DevTools Console. It reads localStorage only, performs no network I/O,
 * and waits for an explicit Download click after showing counts and SHA-256.
 */
(async () => {
  'use strict';

  const allowedOrigins = new Set(['https://edgebook.trade', 'https://www.edgebook.trade']);
  if (!allowedOrigins.has(window.location.origin)) {
    throw new Error(`Refusing unexpected origin ${window.location.origin}`);
  }
  const uid = String(window._fbAuth?.currentUser?.uid || '').trim();
  if (!uid || uid === 'guest') throw new Error('Sign in to the legacy Edge Book app before exporting');
  if (window.DataStore?._uid && window.DataStore._uid !== 'guest' && String(window.DataStore._uid) !== uid) {
    throw new Error('The app data UID does not match the authenticated Firebase UID');
  }

  const parseStored = (key, fallback, validate, label) => {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return { value: fallback, present: false };
    let value;
    try { value = JSON.parse(raw); } catch (error) {
      throw new Error(`${label} contains invalid JSON: ${error.message}`);
    }
    if (!validate(value)) throw new Error(`${label} has an invalid shape`);
    return { value, present: true };
  };
  const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const settings = parseStored(`tradedesk_settings_${uid}`, {}, plainObject, 'Browser settings');
  const moods = parseStored(`tradedesk_moods_${uid}`, [], Array.isArray, 'Browser moods');
  const dailyJournal = parseStored(`tradedesk_dailyjournal_${uid}`, {}, plainObject, 'Browser daily journal');

  const credentialKeys = new Set([
    'accesstoken', 'refreshtoken', 'bearertoken', 'requesttoken', 'idtoken', 'oauthtoken', 'token',
    'tokenciphertext', 'accesstokenciphertext', 'refreshtokenciphertext', 'authorization',
    'authorizationheader', 'clientsecret', 'apisecret', 'apikey', 'secretkey', 'privatekey',
    'consumersecret', 'authorizationcode', 'oauthcode', 'passwordhash', 'passwordsalt', 'secret', 'password',
  ]);
  const isCredentialKey = key => {
    const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    return credentialKeys.has(normalized)
      || /(?:^|encrypted|legacy|ctrader|zerodha)(?:access|refresh|bearer|request|id|oauth|session)token(?:ciphertext)?$/.test(normalized);
  };
  const stringHasCredentialUrl = value => {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
    let parsed;
    try { parsed = new URL(value); } catch { return false; }
    if (parsed.username || parsed.password) return true;
    for (const key of parsed.searchParams.keys()) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (isCredentialKey(key) || ['code', 'state', 'signature', 'credential', 'xgoogsignature', 'xgoogcredential'].includes(normalized)) return true;
    }
    return /(?:token|code|state|secret|password|credential|signature)/i.test(parsed.hash);
  };
  const forbidden = [];
  const inspect = (value, path = []) => {
    if (Array.isArray(value)) return value.forEach((child, index) => inspect(child, [...path, String(index)]));
    if (typeof value === 'string') {
      if (stringHasCredentialUrl(value)) forbidden.push(`${path.join('.')}.$urlCredential`);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (isCredentialKey(key)) forbidden.push([...path, key].join('.'));
      inspect(child, [...path, key]);
    }
  };

  const bundle = { users: { [uid]: {
    settings: settings.value,
    moods: moods.value,
    dailyJournal: dailyJournal.value,
  } } };
  inspect(bundle);
  if (forbidden.length) {
    throw new Error(`Credential-like data blocks export: ${forbidden.slice(0, 10).join(', ')}`);
  }

  const contents = `${JSON.stringify(bundle, null, 2)}\n`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(contents));
  const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const accountValue = settings.value.accounts;
  const accountCount = Array.isArray(accountValue)
    ? accountValue.length
    : (plainObject(accountValue) ? Object.keys(accountValue).length : 0);
  const counts = {
    settingsPresent: settings.present,
    settingsKeys: Object.keys(settings.value).length,
    accounts: accountCount,
    moods: moods.value.length,
    journalDays: Object.keys(dailyJournal.value).length,
  };

  document.getElementById('edgebook-browser-export-review')?.remove();
  const panel = document.createElement('section');
  panel.id = 'edgebook-browser-export-review';
  panel.style.cssText = 'position:fixed;z-index:2147483647;right:18px;bottom:18px;max-width:520px;padding:18px;border:2px solid #6c63ff;border-radius:12px;background:#111827;color:#f9fafb;font:14px/1.45 system-ui,sans-serif;box-shadow:0 18px 50px #0009';
  const heading = document.createElement('h2');
  heading.textContent = 'Edge Book migration export ready';
  heading.style.cssText = 'margin:0 0 10px;font-size:18px';
  const details = document.createElement('pre');
  details.textContent = [
    `Origin: ${window.location.origin}`,
    `Authenticated legacy UID: ${uid}`,
    `Settings key present: ${counts.settingsPresent}`,
    `Settings keys: ${counts.settingsKeys}`,
    `Accounts: ${counts.accounts}`,
    `Moods: ${counts.moods}`,
    `Journal days: ${counts.journalDays}`,
    `SHA-256: ${sha256}`,
  ].join('\n');
  details.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;background:#0b1020;padding:10px;border-radius:8px';
  const note = document.createElement('p');
  note.textContent = 'Record these counts and checksum, download the file, and give it only to the migration operator over the approved secure channel.';
  const download = document.createElement('button');
  download.type = 'button';
  download.textContent = 'Download complete browser backup';
  download.style.cssText = 'padding:9px 12px;margin-right:8px;border:0;border-radius:7px;background:#6c63ff;color:white;font-weight:600;cursor:pointer';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.style.cssText = 'padding:9px 12px;border:1px solid #94a3b8;border-radius:7px;background:transparent;color:white;cursor:pointer';
  const blobUrl = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  download.addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `edgebook-browser-migration-${uid}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
  });
  close.addEventListener('click', () => {
    URL.revokeObjectURL(blobUrl);
    panel.remove();
  });
  panel.append(heading, details, note, download, close);
  document.body.append(panel);
  console.info('Edge Book browser-local export prepared', { uid, counts, sha256 });
})().catch(error => {
  console.error('Edge Book browser-local export failed', error);
  window.alert(`Edge Book export failed: ${error.message}`);
});
