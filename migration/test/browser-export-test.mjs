import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const migrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(migrationRoot, 'browser/export-local-data.js'), 'utf8');
assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket)\b/, 'browser exporter must not have network primitives');
assert.doesNotMatch(source, /localStorage\.(?:setItem|removeItem|clear)\b/, 'browser exporter must not mutate localStorage');

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.style = {};
    this.events = new Map();
    this.textContent = '';
    this.id = '';
  }
  append(...children) { this.children.push(...children); }
  addEventListener(name, handler) { this.events.set(name, handler); }
  remove() { this.removed = true; }
  click() { this.clicked = true; }
}

async function runFixture({ origin = 'https://edgebook.trade', settings = {}, moods = [], dailyJournal = {} } = {}) {
  const uid = 'firebase-user-1';
  const stored = new Map([
    [`tradedesk_settings_${uid}`, JSON.stringify(settings)],
    [`tradedesk_moods_${uid}`, JSON.stringify(moods)],
    [`tradedesk_dailyjournal_${uid}`, JSON.stringify(dailyJournal)],
  ]);
  const created = [];
  const appended = [];
  const alerts = [];
  const objectUrls = [];
  const document = {
    body: { append: (...elements) => appended.push(...elements) },
    createElement(tagName) { const element = new FakeElement(tagName); created.push(element); return element; },
    getElementById() { return null; },
  };
  class FixtureUrl extends URL {}
  FixtureUrl.createObjectURL = blob => { objectUrls.push(blob); return 'blob:edgebook-fixture'; };
  FixtureUrl.revokeObjectURL = () => {};
  const window = {
    location: { origin },
    _fbAuth: { currentUser: { uid } },
    DataStore: { _uid: uid },
    localStorage: {
      getItem: key => stored.get(key) ?? null,
      setItem: () => { throw new Error('localStorage mutation'); },
      removeItem: () => { throw new Error('localStorage mutation'); },
    },
    alert: message => alerts.push(String(message)),
  };
  const context = vm.createContext({
    window, document, crypto: webcrypto, TextEncoder, Blob, URL: FixtureUrl,
    console: { info() {}, error() {} },
  });
  await vm.runInContext(source, context, { timeout: 2_000 });
  return { uid, created, appended, alerts, objectUrls };
}

const valid = await runFixture({
  settings: { accounts: [{ id: 'acct-1' }], prefs: { currency: 'USD' } },
  moods: [{ id: 'mood-1', date: '2026-08-09', emotion: 'Calm' }],
  dailyJournal: { '2026-08-09': { notes: 'Reviewed' } },
});
assert.deepEqual(valid.alerts, []);
assert.equal(valid.appended.length, 1);
assert.equal(valid.objectUrls.length, 1);
const payload = await valid.objectUrls[0].text();
const bundle = JSON.parse(payload);
assert.deepEqual(Object.keys(bundle.users), [valid.uid]);
assert.equal(bundle.users[valid.uid].settings.accounts.length, 1);
assert.equal(bundle.users[valid.uid].moods.length, 1);
assert.equal(Object.keys(bundle.users[valid.uid].dailyJournal).length, 1);
const details = valid.created.find(element => element.tagName === 'PRE')?.textContent || '';
assert.match(details, /Accounts: 1/);
assert.match(details, /Moods: 1/);
assert.match(details, /Journal days: 1/);
assert.match(details, new RegExp(`SHA-256: ${createHash('sha256').update(payload).digest('hex')}`));

const credential = await runFixture({ settings: { client_secret: 'must-not-export' } });
assert.equal(credential.objectUrls.length, 0);
assert.match(credential.alerts[0] || '', /Credential-like data blocks export/);

const wrongOrigin = await runFixture({ origin: 'https://attacker.example' });
assert.equal(wrongOrigin.objectUrls.length, 0);
assert.match(wrongOrigin.alerts[0] || '', /Refusing unexpected origin/);

process.stdout.write('Browser-local export tests passed.\n');
