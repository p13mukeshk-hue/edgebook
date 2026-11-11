import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  databaseDateOnly,
  findForbiddenCredentialPaths,
  redactBrokerCredentials,
  sha256Text,
} from '../lib/bundle.mjs';
import { processMigrationImage } from '../lib/image.mjs';
import { mergeSettings } from '../lib/settings.mjs';

const migrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const promote = resolve(migrationRoot, 'scripts/promote.mjs');
const validate = resolve(migrationRoot, 'scripts/validate-bundle.mjs');
const importStaging = resolve(migrationRoot, 'scripts/import-staging.mjs');
const reconcile = resolve(migrationRoot, 'scripts/reconcile.mjs');
const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'edgebook-migration-test-'));

assert.equal(databaseDateOnly(new Date('2026-08-09T23:59:58.000Z')), '2026-08-09');
assert.equal(databaseDateOnly('2026-03-31'), '2026-03-31');
assert.equal(databaseDateOnly(null), null);

function run(script, args, { failure = false } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    cwd: migrationRoot,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`could not start ${script}: ${result.error.code || 'SPAWN_ERROR'} ${result.error.message}`);
  }
  if (failure) {
    assert.notEqual(result.status, 0, `expected failure from ${script}\n${result.stdout}\n${result.stderr}`);
  } else {
    assert.equal(result.status, 0, `${script} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function writeBundle(name, firestoreDocuments, authOverride = null) {
  const bundle = resolve(temporaryRoot, name);
  await mkdir(bundle, { mode: 0o700 });
  const auth = authOverride || [{
    uid: 'firebase-user-1',
    email: 'trader@example.com',
    emailVerified: true,
    disabled: false,
    providers: [{ providerId: 'google.com', uid: 'google-sub-1', email: 'trader@example.com' }],
    metadata: {},
  }];
  const contents = {
    'auth-users.ndjson': `${auth.map(value => canonicalJson(value)).join('\n')}\n`,
    'firestore.ndjson': `${firestoreDocuments.map(value => canonicalJson(value)).join('\n')}\n`,
    'storage.ndjson': '',
  };
  for (const [file, content] of Object.entries(contents)) {
    await writeFile(resolve(bundle, file), content, { mode: 0o600 });
  }
  const manifest = {
    formatVersion: 1,
    projectId: 'fixture',
    scope: { type: 'all-users' },
    includesStorageObjects: false,
    counts: { authUsers: auth.length, firestoreDocuments: firestoreDocuments.length, storageObjects: 0 },
    files: Object.fromEntries(Object.entries(contents).map(([file, content]) => [file, sha256Text(content)])),
  };
  await writeFile(resolve(bundle, 'manifest.json'), `${canonicalJson(manifest)}\n`, { mode: 0o600 });
  return { bundle, auth };
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const pngUrl = `data:image/png;base64,${png.toString('base64')}`;
const pngSha = (await processMigrationImage(png)).sha256;
const fiveScreenshots = Array.from({ length: 5 }, (_, index) => ({
  name: `chart-${index + 1}.png`,
  src: pngUrl,
}));
const baseDocuments = [
  {
    path: 'users/firebase-user-1/meta/settings',
    data: { accounts: [{ id: 'acct_1', name: 'Primary', currency: 'USD' }] },
    createTime: null,
    updateTime: null,
  },
  {
    path: 'users/firebase-user-1/trades/active',
    data: {
      tradingsymbol: 'NIFTY', date: '2026-08-08', transaction_type: 'BUY', average_price: '100.5',
      quantity: '2', pnl: '4.25', exchange: 7, entryTime: '09:15', screenshots: fiveScreenshots,
    },
    createTime: null,
    updateTime: null,
  },
  {
    path: 'users/firebase-user-1/trades/archived',
    data: {
      symbol: 'BANKNIFTY', date: '2026-08-07', direction: 'Short', entry: 200, size: 1,
      pnl: -3, deleted: true, deletedAt: '2026-08-08T10:00:00.000Z',
    },
    createTime: null,
    updateTime: null,
  },
  {
    path: 'users/firebase-user-1/orderUpdates/update-1',
    data: { status: 'complete' },
    createTime: null,
    updateTime: null,
  },
  {
    path: 'users/firebase-user-1/notifications/notification-1',
    data: { type: 'info', title: 'Review', message: 'Review the imported trade', read: false },
    createTime: null,
    updateTime: null,
  },
  {
    path: 'users/firebase-user-1/orders/order-1',
    data: { order_id: 'order-1', status: 'COMPLETE' },
    createTime: null,
    updateTime: null,
  },
  {
    path: 'users/firebase-user-1/pendingDuplicates/duplicate-1',
    data: { incomingTrade: { symbol: 'NIFTY' }, status: 'pending' },
    createTime: null,
    updateTime: null,
  },
];

try {
  const credentialFixture = {
    access_token: 'a',
    'refresh-token': 'b',
    client_secret: 'c',
    nested: { IDToken: 'd' },
    statusTokenCount: 3,
    screenshot: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/users%2Fu%2Fscreenshots%2Fx.png?alt=media&token=secret-value',
  };
  const redacted = redactBrokerCredentials(credentialFixture);
  assert.deepEqual(redacted.value, {
    nested: {},
    statusTokenCount: 3,
    screenshot: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/users%2Fu%2Fscreenshots%2Fx.png?alt=media',
  });
  assert.equal(findForbiddenCredentialPaths(redacted.value).length, 0);
  const promoterSource = await readFile(promote, 'utf8');
  assert.doesNotMatch(promoterSource, /ON CONFLICT[^;`]*DO NOTHING/i,
    'promotion conflicts must fail instead of silently preserving target rows');
  assert.match(promoterSource, /JSON\.stringify\(\{ \.\.\.d, screenshots:\[\] \}\)/,
    'live promoted trade rows must not retain screenshot URLs already materialized as private files');
  assert.match(promoterSource,
    /provider,connection_mode,external_account_id[\s\S]*CASE WHEN \$4='ctrader' THEN 'official' ELSE NULL END/,
    'legacy cTrader brokers must satisfy the post-MCP connection-mode constraint');

  const valid = await writeBundle('valid', baseDocuments);
  const browserLocal = resolve(temporaryRoot, 'browser-local.json');
  const browserLocalPayload = {users:{'firebase-user-1':{
    settings:{accounts:[
      {id:'acct_1',name:'Primary local newer',currency:'USD',updatedAt:1},
      {id:'acct_2',name:'Local only',currency:'INR'},
    ],brokerAccountMap:{ctrader:'acct_2'}},
    moods:[],dailyJournal:{},
  }}};
  await writeFile(browserLocal, `${canonicalJson(browserLocalPayload)}\n`, { mode: 0o600 });
  run(validate, ['--bundle', valid.bundle]);
  run(importStaging, ['--bundle', valid.bundle]);
  const promotion = run(promote, ['--bundle', valid.bundle, '--browser-local', browserLocal]);
  const promotionPlan = JSON.parse(promotion.stdout.match(/\{[\s\S]*\}/)?.[0] || '{}');
  assert.equal(promotionPlan.planSummary?.accounts, 2);
  assert.equal(promotionPlan.planSummary?.browserSettings, 1);
  assert.equal(promotionPlan.planSummary?.screenshots, 5);

  const brokerMappingBundle = await writeBundle('broker-mapping-precedence', [
    {
      path: 'users/firebase-user-1/meta/settings',
      data: { accounts: [{ id: 'acct_1', name: 'Primary' }] },
      createTime: null,
      updateTime: null,
    },
    {
      path: 'users/firebase-user-1/brokers/ctrader_123',
      data: { mapToEdgebookAccountId: 'stale-missing-account' },
      createTime: null,
      updateTime: null,
    },
    {
      path: 'users/firebase-user-1/trades/deletion-tombstone',
      data: { deleted: true, deletedAt: '2026-08-08T10:00:00.000Z' },
      createTime: null,
      updateTime: null,
    },
    {
      path: 'users/firebase-user-1/trades/missing-symbol',
      data: { date: '2026-08-08', direction: 'Long', entry: 100, size: 1 },
      createTime: null,
      updateTime: null,
    },
    {
      path: 'users/firebase-user-1/trades/known-zerodha-time-corruption',
      data: {
        symbol: 'NIFTY', date: '2026-08-08', direction: 'Long', entry: 100, size: 1,
        source: 'csv', broker: 'zerodha', entryTime: '2026 ', exitTime: '2026 ',
      },
      createTime: null,
      updateTime: null,
    },
  ]);
  const brokerMappingBrowser = resolve(temporaryRoot, 'broker-mapping-browser.json');
  await writeFile(brokerMappingBrowser, `${canonicalJson({ users: { 'firebase-user-1': {
    settings: { accounts: [{ id: 'acct_1', name: 'Primary' }], brokerAccountMap: { ctrader: 'acct_1' } },
    moods: [], dailyJournal: {},
  } } })}\n`, { mode: 0o600 });
  const brokerMappingPromotion = run(promote, [
    '--bundle', brokerMappingBundle.bundle, '--browser-local', brokerMappingBrowser,
  ]);
  const brokerMappingPlan = JSON.parse(brokerMappingPromotion.stdout.match(/\{[\s\S]*\}/)?.[0] || '{}');
  assert.equal(brokerMappingPlan.planSummary?.brokersDisconnected, 1,
    'browser provider mapping must override a stale connection-document account mapping');
  assert.equal(brokerMappingPlan.planSummary?.unmaterializedTrades, 2,
    'irrecoverable deletion tombstones and missing-symbol rows must remain in the raw archive only');
  assert.equal(brokerMappingPlan.planSummary?.normalizedLegacyTimeFields, 2,
    'known Zerodha year-only time corruption must normalize to null while raw source remains archived');

  const missingBrowserLocal = resolve(temporaryRoot, 'missing-browser-user.json');
  await writeFile(missingBrowserLocal, `${canonicalJson({ users: {} })}\n`, { mode: 0o600 });
  run(promote, ['--bundle', valid.bundle, '--browser-local', missingBrowserLocal], { failure: true });

  const invalidIdentity = await writeBundle('invalid-identity', baseDocuments, [{
    ...valid.auth[0],
    emailVerified: false,
    providers: [],
  }]);
  run(validate, ['--bundle', invalidIdentity.bundle], { failure: true });
  run(importStaging, ['--bundle', invalidIdentity.bundle], { failure: true });

  const invalidChecksum = await writeBundle('invalid-checksum', baseDocuments);
  const invalidChecksumManifestPath = resolve(invalidChecksum.bundle, 'manifest.json');
  const invalidChecksumManifest = JSON.parse(await readFile(invalidChecksumManifestPath, 'utf8'));
  invalidChecksumManifest.files['auth-users.ndjson'] = 'not-a-checksum';
  await writeFile(invalidChecksumManifestPath, `${canonicalJson(invalidChecksumManifest)}\n`, { mode: 0o600 });
  const invalidChecksumResult = run(validate, ['--bundle', invalidChecksum.bundle], { failure: true });
  assert.match(invalidChecksumResult.stderr, /manifest checksum is missing\/invalid for auth-users\.ndjson/);
  assert.doesNotMatch(invalidChecksumResult.stderr, /TypeError|undefined/);

  const target = resolve(temporaryRoot, 'target.ndjson');
  const targetLines = [
    {
      recordType: 'trade',
      legacyPath: 'users/firebase-user-1/trades/active',
      data: {
        symbol: 'NIFTY', date: '2026-08-08', direction: 'Long', entry: 100.5, size: 2,
        pnl: 4.25, exchange: '7', entryTime: '09:15', deleted: false,
        screenshots: fiveScreenshots.map(({ name }) => ({ name })),
      },
      mapped: {
        sourceSystem: 'manual', ingestionMethod: 'manual', legacyAccountId: null,
        linkedLegacyAccountId: null, legacyBrokerDocumentId: null,
        files: fiveScreenshots.map(({ name }) => ({ name, sha256: pngSha })),
      },
    },
    {
      recordType: 'trade',
      legacyPath: 'users/firebase-user-1/trades/archived',
      data: { ...baseDocuments[2].data, direction: 'Short', deleted: true, screenshots: [] },
      mapped: {
        sourceSystem: 'manual', ingestionMethod: 'manual', legacyAccountId: null,
        linkedLegacyAccountId: null, legacyBrokerDocumentId: null,
        files: [],
      },
    },
    ...baseDocuments.map(document => ({
      recordType: 'rawDocument',
      sourcePath: document.path,
      payloadSha256: sha256Text(canonicalJson(document.data)),
    })),
    ...baseDocuments.filter(document => /^users\/[^/]+\/(?:notifications|orders|pendingDuplicates)\/[^/]+$/.test(document.path))
      .map(document => ({ recordType: 'materializedDocument', sourcePath: document.path })),
    { recordType: 'identity', firebaseUid: 'firebase-user-1', googleSub: 'google-sub-1' },
    {
      recordType: 'settings',
      firebaseUid: 'firebase-user-1',
      data: mergeSettings(baseDocuments[0].data, browserLocalPayload.users['firebase-user-1'].settings),
    },
    {
      recordType: 'account', firebaseUid: 'firebase-user-1', legacyAccountId: 'acct_1',
      data: browserLocalPayload.users['firebase-user-1'].settings.accounts[0],
    },
    {
      recordType: 'account', firebaseUid: 'firebase-user-1', legacyAccountId: 'acct_2',
      data: browserLocalPayload.users['firebase-user-1'].settings.accounts[1],
    },
  ];
  await writeFile(target, `${targetLines.map(value => canonicalJson(value)).join('\n')}\n`, { mode: 0o600 });
  run(reconcile, ['--source-bundle', valid.bundle, '--browser-local', browserLocal, '--target', target]);

  const partialTarget = resolve(temporaryRoot, 'partial-target.ndjson');
  const partial = targetLines.map(value => value.legacyPath?.endsWith('/active')
    ? { ...value, mapped: { files: value.mapped.files.slice(0, 1) } }
    : value);
  await writeFile(partialTarget, `${partial.map(value => canonicalJson(value)).join('\n')}\n`, { mode: 0o600 });
  run(reconcile, ['--source-bundle', valid.bundle, '--browser-local', browserLocal, '--target', partialTarget], { failure: true });

  const cases = [
    ['blank-entry', { ...baseDocuments[1].data, average_price: '' }],
    ['missing-quantity', Object.fromEntries(Object.entries(baseDocuments[1].data).filter(([key]) => key !== 'quantity'))],
    ['impossible-date', { ...baseDocuments[1].data, date: '2026-02-30' }],
    ['date-with-garbage-suffix', { ...baseDocuments[1].data, date: '2026-08-08not-a-timestamp' }],
    ['impossible-time', { ...baseDocuments[1].data, entryTime: '25:61' }],
    ['impossible-deleted-timestamp', { ...baseDocuments[1].data, deleted: true, deletedAt: '2026-02-30T10:00:00Z' }],
    ['invalid-optional-number', { ...baseDocuments[1].data, pnl: 'not-a-number' }],
    ['too-many-screenshots', { ...baseDocuments[1].data, screenshots: [...fiveScreenshots, fiveScreenshots[0]] }],
  ];
  for (const [name, trade] of cases) {
    const documents = baseDocuments.map(document => document.path.endsWith('/active') ? { ...document, data: trade } : document);
    const invalid = await writeBundle(name, documents);
    run(promote, ['--bundle', invalid.bundle, '--browser-local', browserLocal], { failure: true });
  }

  const badTarget = resolve(temporaryRoot, 'bad-target.ndjson');
  const altered = targetLines.map(value => value.legacyPath?.endsWith('/active')
    ? { ...value, mapped: { files: value.mapped.files.map((file, index) => (
      index === 0 ? { ...file, sha256: '0'.repeat(64) } : file
    )) } }
    : value);
  await writeFile(badTarget, `${altered.map(value => canonicalJson(value)).join('\n')}\n`, { mode: 0o600 });
  run(reconcile, ['--source-bundle', valid.bundle, '--browser-local', browserLocal, '--target', badTarget], { failure: true });

  const badProjectionTarget = resolve(temporaryRoot, 'bad-projection-target.ndjson');
  const alteredProjection = targetLines.map(value => value.legacyPath?.endsWith('/active')
    ? { ...value, data: { ...value.data, sl: 99 }, mapped: { ...value.mapped, legacyAccountId: 'wrong-account' } }
    : value);
  await writeFile(badProjectionTarget, `${alteredProjection.map(value => canonicalJson(value)).join('\n')}\n`, { mode: 0o600 });
  run(reconcile, ['--source-bundle', valid.bundle, '--browser-local', browserLocal, '--target', badProjectionTarget], { failure: true });
  process.stdout.write('Migration synthetic tests passed.\n');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
