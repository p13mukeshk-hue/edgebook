import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createVpsDataAdapter } from './data-adapter.js';
import { createAuthAdapter } from './auth-adapter.js';

const require = createRequire(import.meta.url);
const xlsxExport = require('./xlsx-export.js');

const clientDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(clientDir);

const read = relativePath => fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
const app = read('app.html');
const indexPage = read('index.html');
const landingPage = read('landing.html');
const marketing = `${indexPage}\n${landingPage}`;
const apiClient = read('client/api-client.js');
const authAdapter = read('client/auth-adapter.js');
const dataAdapter = read('client/data-adapter.js');
const dictationControllerSource = read('client/on-device-dictation.js');
const whisperWorkerSource = read('client/on-device-whisper-worker.js');
const xlsxExportSource = read('client/xlsx-export.js');
const allBrowserSource = `${app}\n${marketing}\n${apiClient}\n${authAdapter}\n${dataAdapter}\n${dictationControllerSource}\n${whisperWorkerSource}\n${xlsxExportSource}`;

const failures = [];
const requireMatch = (text, pattern, label) => {
  if (!pattern.test(text)) failures.push(`Missing: ${label}`);
};
const rejectMatch = (text, pattern, label) => {
  if (pattern.test(text)) failures.push(`Still present: ${label}`);
};

// Keep security regressions executable instead of relying only on source
// patterns. The app is intentionally a single HTML file, so these helpers
// isolate named renderer sections and exercise them with a tiny inert DOM.
const sourceBetween = (start, end) => {
  const startIndex = app.indexOf(start);
  const endIndex = app.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    failures.push(`Could not isolate frontend source between ${start} and ${end}`);
    return '';
  }
  return app.slice(startIndex, endIndex);
};

const makeFakeElement = tagName => {
  const listeners = new Map();
  const element = {
    tagName: String(tagName || 'div').toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    value: '',
    options: [],
    className: '',
    textContent: '',
    _innerHTML: '',
    _innerHtmlWrites: 0,
    classList: {
      add() {},
      remove() {},
      toggle() { return false; },
      contains() { return false; },
    },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    remove() { this.removed = true; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    closest() { return null; },
    scrollIntoView() {},
    click() {},
    get listeners() { return listeners; },
  };
  Object.defineProperty(element, 'innerHTML', {
    get() { return this._innerHTML; },
    set(value) { this._innerHTML = String(value); this._innerHtmlWrites += 1; },
  });
  return element;
};

const makeFakeDocument = () => {
  const elements = new Map();
  const created = [];
  const body = makeFakeElement('body');
  return {
    body,
    created,
    elements,
    createElement(tagName) {
      const element = makeFakeElement(tagName);
      created.push(element);
      return element;
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeFakeElement('div'));
      return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
};

const htmlDecodeAttribute = value => String(value)
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const maliciousMarkup = `\"><img src=x onerror=\"globalThis.__edgebookXss=1\"><svg onload=\"globalThis.__edgebookXss=2\"></svg><script>globalThis.__edgebookXss=3</script>`;
const maliciousIdentifier = `id'\");globalThis.__edgebookXss=4;//${maliciousMarkup}`;

const actualHtmlAttributes = html => {
  const attributes = [];
  const text = String(html || '');
  for (let offset = 0; offset < text.length;) {
    const start = text.indexOf('<', offset);
    if (start < 0) break;
    let end = start + 1;
    let quote = '';
    for (; end < text.length; end += 1) {
      const char = text[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
    }
    if (end >= text.length) break;
    const tag = text.slice(start + 1, end);
    offset = end + 1;
    if (/^\s*[!/]/.test(tag)) continue;
    let index = tag.search(/\s/);
    if (index < 0) continue;
    while (index < tag.length) {
      while (/\s/.test(tag[index] || '')) index += 1;
      const nameStart = index;
      while (index < tag.length && !/[\s=/>]/.test(tag[index])) index += 1;
      const name = tag.slice(nameStart, index).toLowerCase();
      if (!name) { index += 1; continue; }
      while (/\s/.test(tag[index] || '')) index += 1;
      let value = '';
      if (tag[index] === '=') {
        index += 1;
        while (/\s/.test(tag[index] || '')) index += 1;
        if (tag[index] === '"' || tag[index] === "'") {
          const valueQuote = tag[index++];
          const valueStart = index;
          while (index < tag.length && tag[index] !== valueQuote) index += 1;
          value = tag.slice(valueStart, index);
          if (tag[index] === valueQuote) index += 1;
        } else {
          const valueStart = index;
          while (index < tag.length && !/[\s>]/.test(tag[index])) index += 1;
          value = tag.slice(valueStart, index);
        }
      }
      attributes.push({ name, value: htmlDecodeAttribute(value) });
    }
  }
  return attributes;
};

const assertNoExecutablePayload = (html, label) => {
  const rendered = String(html || '');
  if (/<script(?:\s|>)/i.test(rendered)) failures.push(`${label} rendered a script element`);
  const attributes = actualHtmlAttributes(rendered);
  if (attributes.some(attribute => ['onerror', 'onload'].includes(attribute.name))) {
    failures.push(`${label} rendered an executable event attribute`);
  }
  if (attributes.some(attribute => ['src', 'href', 'xlink:href'].includes(attribute.name) && /^\s*javascript:/i.test(attribute.value))) {
    failures.push(`${label} rendered a javascript URL`);
  }
};

const assertInlineArgument = (html, functionName, expectedValue, label) => {
  const handlers = [...String(html || '').matchAll(/onclick="([^"]*)"/g)]
    .map(match => htmlDecodeAttribute(match[1]));
  const handler = handlers.find(value => value.includes(`${functionName}(`));
  if (!handler) {
    failures.push(`${label} did not render its ${functionName} handler`);
    return;
  }
  const calls = [];
  const context = {
    [functionName]: (...args) => calls.push(args),
    event: { stopPropagation() {} },
    __edgebookXss: 0,
  };
  try {
    vm.runInNewContext(handler, context, { timeout: 100 });
    if (context.__edgebookXss !== 0) failures.push(`${label} executed injected handler code`);
    if (calls.length !== 1 || calls[0][0] !== expectedValue) failures.push(`${label} did not preserve its identifier as one string argument`);
  } catch (error) {
    failures.push(`${label} produced an invalid inline handler: ${error.message}`);
  }
};

const evaluateSecurityFixture = (source, globals, exportExpression) => {
  const context = vm.createContext({
    URL,
    console,
    ...globals,
  });
  vm.runInContext(`${source}\nglobalThis.__securityExports=${exportExpression};`, context, { timeout: 500 });
  return { context, exports: context.__securityExports };
};

// Parse every classic inline script without executing browser code.
for (const [index, match] of [...app.matchAll(/<script(?![^>]*\btype=["']module["'])[^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
  try {
    new vm.Script(match[1], { filename: `app.html:inline-script-${index + 1}.js` });
  } catch (error) {
    failures.push(`JavaScript parse error: ${error.message}`);
  }
}

// Parse inline modules as async bodies after removing their static import
// declarations. This catches syntax/top-level-await regressions without
// executing browser code or contacting remote module hosts.
for (const [pageName, pageText] of [['app.html', app], ['index.html', indexPage], ['landing.html', landingPage]]) {
  for (const [index, match] of [...pageText.matchAll(/<script[^>]*\btype=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
    const moduleBody = match[1].replace(/^\s*import\s+[^;]+;\s*$/gm, '');
    try {
      new vm.Script(`(async()=>{${moduleBody}\n})`, { filename: `${pageName}:inline-module-${index + 1}.js` });
    } catch (error) {
      failures.push(`JavaScript module parse error in ${pageName}: ${error.message}`);
    }
  }
}

// VPS/PostgreSQL is the only runtime identity and data authority. Auth must
// fail closed if the VPS capability check does not pass; there is no second
// writer or browser-side Firebase fallback.
requireMatch(app, /VPS\/PostgreSQL is the sole runtime identity and data authority/, 'VPS-only app configuration');
requireMatch(authAdapter, /dataApiReady\s*!==\s*true/, 'data API readiness gate');
requireMatch(authAdapter, /mode:\s*['"]vps['"]/, 'complete VPS adapter');
requireMatch(authAdapter, /legacyFirebaseUid/, 'legacy Firebase UID preservation');
requireMatch(authAdapter, /throw new Error\(['"]VPS data API is not marked ready['"]\)/, 'fail-closed VPS auth capability error');
rejectMatch(authAdapter, /mode:\s*['"]firebase['"]/, 'Firebase auth mode');
rejectMatch(authAdapter, /loadFirebase|firebase-fallback/i, 'Firebase auth fallback loader');
rejectMatch(allBrowserSource, /enableFirebaseFallback/, 'Firebase fallback configuration');
rejectMatch(app, /from\s+['"]\.\/client\/firebase-fallback\.js['"]/, 'Firebase fallback app import');
rejectMatch(app, /^\s*import\s+[^;]*https:\/\/www\.gstatic\.com\/firebasejs\//gmi, 'static Firebase import in app');
rejectMatch(marketing, /^\s*import\s+[^;]*https:\/\/www\.gstatic\.com\/firebasejs\//gmi, 'static Firebase import in marketing pages');
requireMatch(app, /window\._dataMode\s*=\s*['"]vps['"][\s\S]*?createVpsDataAdapter/, 'VPS data adapter initialization');
requireMatch(app, /edgebook-auth-error/, 'fail-closed app auth error event');
requireMatch(apiClient, /credentials:\s*['"]same-origin['"]/, 'same-origin session cookies');
requireMatch(apiClient, /x-csrf-token/i, 'CSRF propagation');
requireMatch(dataAdapter, /new EventSource\(['"]\/api\/events['"]/, 'VPS event stream');
requireMatch(dataAdapter, /payload\?\.nextCursor/, 'trade cursor pagination');
requireMatch(dataAdapter, /async\s+patch\(id, fields\)[\s\S]*?versionHeaders\(fields\?\.version\)/, 'trade PATCH If-Match propagation');
requireMatch(app, /_blockedByConflict/, 'settings conflict write barrier');
requireMatch(app, /VPS settings load failed:[\s\S]{0,180}?SettingsManager\._blockedByConflict\s*=\s*true|SettingsManager\._blockedByConflict\s*=\s*true[\s\S]{0,180}?VPS settings load failed:/, 'failed settings baseline locks editing');
requireMatch(app, /_moodsBaselineLoaded\s*:\s*false/, 'mood baseline fail-closed state');
requireMatch(app, /saveMoods\(m\)[\s\S]{0,700}?if\(!this\._moodsBaselineLoaded\)[\s\S]{0,250}?return false/, 'mood save blocks on unknown VPS baseline');
requireMatch(app, /edgebook_vps_local_migration_/, 'verified browser-data migration marker');
requireMatch(app, /migrationAlreadyVerified\s*=\s*!!readBrowserJson\(migrationMarkerKey,null\)\?\.verifiedAt/, 'browser-data migration marker is read');
requireMatch(app, /migrationAlreadyVerified[\s\S]{0,260}?dirtyMoodIds[\s\S]{0,260}?dirtyJournals/, 'completed browser migration retries only durable dirty records');
requireMatch(app, /tradedesk_moods_\$\{sourceUid\}/, 'legacy browser mood lookup');
requireMatch(app, /tradedesk_dailyjournal_\$\{user\.legacyFirebaseUid\}/, 'legacy browser journal lookup');
requireMatch(app, /edgebook_vps_settings_migration_v2_\$\{user\.uid\}_\$\{legacyUid\}/, 'versioned browser-settings migration marker');
requireMatch(app, /tradedesk_settings_\$\{legacyUid\}/, 'legacy browser settings lookup');
requireMatch(app, /S=await migrateBrowserLocalSettings\(user,S\)/, 'first-login browser-settings merge');
requireMatch(app, /onclick=["']exportMigrationBundle\(\)["']/, 'visible complete migration export control');

const browserSettingsMergeSource = sourceBetween('function mergeBrowserSettings', 'async function migrateBrowserLocalSettings');
const browserSettingsMigrationSource = sourceBetween('async function migrateBrowserLocalSettings', 'function moodFingerprint');
const browserDataMigrationSource = sourceBetween('async function migrateBrowserLocalData', 'let S={}, trades=[]');
const migrationExportSource = sourceBetween('function exportMigrationBundle', 'function importSettings');
const dataStoreSource = sourceBetween('const DataStore =', 'function readBrowserJson');
const tradeSaveSource = sourceBetween('async function saveTrade', '/* ═══ END TRADE FORM ═══ */');
const screenshotDraftUploadSource = sourceBetween('async function persistPendingTradeScreenshots', 'function restorePendingScreenshotPreviews');
const newTradeScreenshotPersistenceSource = sourceBetween('async function persistNewTradeWithScreenshotDraft', 'function renderScreenshotPreviews');
const screenshotSelectionSource = sourceBetween('async function uploadScreenshotFile', 'function handleFileSelect');
const heatmapScreenshotSource = sourceBetween('async function hmAddScreenshots', 'CSV IMPORT MODULE');
const closeModalSource = sourceBetween('function closeModal', 'function showConfirm');
const duplicateResolutionSource = sourceBetween('async function resolveDup', 'function showManualDupModal');
const jsonImportSource = sourceBetween('function importTradesJSON', 'function csvFormulaSafeText');
const csvImportCommitSource = sourceBetween('async function csvImportTrades', 'let ddRange');
const quantityProjectionSource = sourceBetween('function isCTraderTrade', 'const CTRADER_CALCULATED_GROSS_METHOD');
const calculatedGrossPresentationSource = sourceBetween('const CTRADER_CALCULATED_GROSS_METHOD', 'function cTraderExactPnlBreakdown');
const sizeLabelSource = sourceBetween('function getSizeLabel', 'function tradeRow');
requireMatch(migrationExportSource, /const bundle=\{users:\{\[legacyUid\]:\{[\s\S]*?settings:[\s\S]*?moods:[\s\S]*?dailyJournal:/, 'complete per-UID migration export shape');
requireMatch(dataStoreSource, /saveTrades\(t\)\{[\s\S]*?window\._dataMode===['"]vps['"][\s\S]*?return this\._syncVpsTrades\(t\);[\s\S]*?return false;/, 'trade save returns false without a selected provider');
requireMatch(dataStoreSource, /async _syncVpsTrades\(items\)[\s\S]*?const results=await Promise\.allSettled\(pending\);[\s\S]*?return failed\.length===0;/, 'trade save awaits every VPS mutation');
requireMatch(dataStoreSource, /saveTrade\(trade\)\{[\s\S]{0,700}?_syncVpsTrades\(\[trade\]\)/, 'trade modal persists only its owned mutation');
requireMatch(dataStoreSource, /exists&&isCTraderTrade\(trade\)[\s\S]{0,120}?cTraderJournalPatch\(trade\)/, 'existing cTrader edits send a journal-owned PATCH');
try {
  const { exports: journalPatch } = evaluateSecurityFixture(
    quantityProjectionSource,
    {},
    '{cTraderJournalPatch}',
  );
  const payload = journalPatch.cTraderJournalPatch({
    version: 3,
    date: '2026-08-13',
    sl: 4390,
    notes: 'Waited for confirmation',
    psychology: { review: 'patient' },
    custom: { setup: 'breakout' },
    legacyFirebaseDocId: null,
    brokerData: { provider: 'ctrader' },
    entryAt: new Date('2026-08-13T04:36:00.819Z'),
    sourceSystem: 'ctrader',
    screenshots: [{ id: 'server-file' }],
  });
  const keys = Object.keys(payload).sort();
  if (keys.some(key => ['legacyFirebaseDocId','brokerData','entryAt','sourceSystem','screenshots'].includes(key))
    || payload.version !== 3 || payload.date !== '2026-08-13' || payload.notes !== 'Waited for confirmation') {
    failures.push('cTrader journal PATCH leaked canonical provider/server fields or omitted editable fields');
  }
} catch (error) {
  failures.push(`cTrader journal PATCH fixture failed: ${error.message}`);
}
requireMatch(tradeSaveSource, /const synced=await DataStore\.saveTrade\((?:trades\[i\]|trade)\);[\s\S]*?if\(!synced\)[\s\S]*?return;[\s\S]*?showToast\(/, 'manual trade success waits for targeted persistence');
rejectMatch(newTradeScreenshotPersistenceSource, /if\(!synced\)[\s\S]{0,500}?reloadCommittedTradeKeepingScreenshotDraft/, 'unsafe same-ID recovery after failed trade create');
requireMatch(dataStoreSource, /_lastTradeSyncWarning=null[\s\S]*?promoteTradeScreenshots[\s\S]*?catch\(error\)[\s\S]*?_lastTradeSyncWarning=error[\s\S]*?const results=await Promise\.allSettled/, 'screenshot post-processing cannot misreport a committed trade as unsaved');
requireMatch(tradeSaveSource, /if\(_tradeSaveInFlight\)return;[\s\S]*?_tradeSaveInFlight=true;[\s\S]*?finally[\s\S]*?_tradeSaveInFlight=false/, 'manual trade submit has an in-flight double-click lock');
requireMatch(tradeSaveSource, /id:editId\|\|_tradeDraftId\|\|\(_tradeDraftId=crypto\.randomUUID\(\)\)/, 'manual trade retries retain a stable collision-resistant idempotency ID');
requireMatch(tradeSaveSource, /await loadManualDuplicateCandidates\(\)[\s\S]*?findLocalDuplicate\(trade,duplicateCandidates\)/, 'manual trade duplicate check uses the authoritative VPS list');
requireMatch(duplicateResolutionSource, /duplicateNumericClose\(existing\.entry,incoming\.entry,\.005\)[\s\S]*?duplicateNumericClose\(existing\.exit,incoming\.exit,\.005\)[\s\S]*?duplicateNumericClose\(existing\.size,incoming\.size,\.02\)/, 'manual duplicate check covers near entry exit and size values');
requireMatch(dataAdapter, /async create\(trade\)[\s\S]*?isAmbiguousCreateError\(error\)[\s\S]*?api\.get\([\s\S]*?encodeURIComponent\(trade\.id\)[\s\S]*?tradeCreateFingerprint\(current\) === tradeCreateFingerprint\(trade\)/, 'lost trade-create response reconciliation');
requireMatch(dataAdapter, /tradeCreateFingerprint[\s\S]*?pnl:[\s\S]*?entryTime:[\s\S]*?psychology:[\s\S]*?brokerData:/, 'complete normalized trade-create recovery fingerprint');
requireMatch(app, /function calFinancialForDay[\s\S]*?financialDisplayViewForTrades[\s\S]*?estimatedGross[\s\S]*?provisional/, 'calendar shared mixed-provisional financial aggregation');
requireMatch(app, /function renderCalStats[\s\S]*?Overall month P&L[\s\S]*?Est\. net[\s\S]*?Mixed provisional/, 'calendar explicit complete-versus-provisional provenance summary');
requireMatch(app, /function hmFilteredTrades[\s\S]*?financialDisplayViewForTrades[\s\S]*?function renderHeatmap[\s\S]*?Overall range P&L[\s\S]*?Est\. net[\s\S]*?Mixed provisional/, 'heatmap shared mixed-provisional realized-close ledger');
requireMatch(app, /function djDayStats[\s\S]*?financialDisplayViewForTrades[\s\S]*?verifiedNet[\s\S]*?estimatedGross/, 'daily journal shared mixed-provisional day-level aggregation');
requireMatch(app, /function tradeJournalCsv[\s\S]*?P&L Status[\s\S]*?Fees & Charges[\s\S]*?Fee Status[\s\S]*?Calculated Gross/, 'CSV financial provenance columns');
requireMatch(app, /function tradeJournalCsv[\s\S]*?Duration Seconds/, 'CSV exact trade-duration columns');
requireMatch(app, /const TABLE_HEADS[\s\S]*?Entry time[\s\S]*?Duration/, 'dashboard and journal trade-duration column');
requireMatch(app, /Average hold:[\s\S]*?timed trade/, 'analytics average holding-duration metric');
requireMatch(app, /analytics-pnl-coverage[\s\S]*?Mixed provisional analytics[\s\S]*?estimated net value[\s\S]*?included provisionally/, 'mixed-provisional analytics estimate disclosure');
requireMatch(duplicateResolutionSource, /const saved=await DataStore\.saveTrades\(trades\);[\s\S]*?if\(!saved\)[\s\S]*?recoverTradesAfterFailedWrite/, 'duplicate resolution waits for persistence');
requireMatch(jsonImportSource, /const saved=await DataStore\.saveTrades\(trades\);[\s\S]*?if\(!saved\)[\s\S]*?recoverTradesAfterFailedWrite/, 'JSON import waits for persistence');
requireMatch(csvImportCommitSource, /const saved=await DataStore\.saveTrades\(trades\);[\s\S]*?if\(!saved\)[\s\S]*?recoverTradesAfterFailedWrite[\s\S]*?return;[\s\S]*?closeModal/, 'CSV import waits for persistence before closing');
requireMatch(csvImportCommitSource, /String\(trade\.broker\|\|['"]['"]\)\.toLowerCase\(\)===String\(csvState\.selectedBroker\|\|['"]['"]\)\.toLowerCase\(\)/, 'legacy CSV open-position reconciliation is broker-scoped');
requireMatch(app, /async function commitSettings\([\s\S]*?const saved=await SettingsManager\.set\(S\);/, 'settings commit awaits VPS persistence');
requireMatch(browserDataMigrationSource, /remoteStillAtBase=dirty\.baseKnown===true&&remoteFingerprint===dirty\.baseFingerprint/, 'dirty journal retry compares the remote row with its captured base');
requireMatch(browserDataMigrationSource, /if\(!remoteAlreadyHasLocal&&!remoteStillAtBase&&!safelyCreating\)[\s\S]*?djRecordConflict\(date,dirty,existing\);[\s\S]*?continue;/, 'divergent journal edits are preserved as conflicts without a PUT');
requireMatch(browserDataMigrationSource, /if\(journalConflicts\.includes\(date\)\) continue;[\s\S]*?await djClearDirty\(date,localEntry\)/, 'journal dirty marker clears only after verified non-conflicting content');
for (const mutation of ['saveBrokerMapping','addAccount','saveEditAccount','toggleFormField','addCustomField','removeCustomField','saveEditCF','moveCFInSection','moveCFSection','setTheme','setThemeChoice','toggleSidebarPin','addSymbol','removeSymbol']) {
  requireMatch(app, new RegExp(`async function ${mutation}\\b[\\s\\S]{0,1800}?await (?:commitSettings\\(|SettingsManager\\.set\\(S\\))`), `${mutation} awaits settings persistence`);
}
requireMatch(app, /function removeAccount\b[\s\S]{0,800}?async\(\)=>\{[\s\S]*?await SettingsManager\.set\(S\)/, 'removeAccount awaits settings persistence');
requireMatch(app, /function clearSymbolsForTab\b[\s\S]{0,800}?async\(\)=>\{[\s\S]*?await commitSettings\(/, 'clearSymbolsForTab awaits settings persistence');

// Theme palettes keep the legacy dark/light preference contract while adding
// one allowlisted dark-palette field shared by topbar and Settings controls.
requireMatch(app, /theme:'dark',darkPalette:'midnight'/, 'backward-compatible default theme preferences');
for (const [value, label] of [
  ['dark-midnight', 'Midnight Violet'],
  ['dark-obsidian', 'Obsidian Teal'],
  ['dark-navy', 'Deep Navy'],
  ['light-paper', 'Paper Ledger'],
]) {
  requireMatch(app, new RegExp(`id=["']theme-palette-select["'][\\s\\S]{0,800}?value=["']${value}["']>${label}`), `topbar theme option ${label}`);
  requireMatch(app, new RegExp(`id=["']pref-theme-palette["'][\\s\\S]{0,800}?value=["']${value}["']>${label}`), `settings theme option ${label}`);
}
requireMatch(app, /sessionStorage\.getItem\(['"]edgebook_theme_uid['"]\)[\s\S]{0,500}?tradedesk_settings_\$\{uid\}/, 'session-scoped cached theme prepaint');
requireMatch(app, /function applyTheme\(theme,darkPalette\)[\s\S]{0,500}?document\.documentElement\.dataset\.theme=state\.choice[\s\S]{0,250}?classList\.toggle\(['"]light['"],state\.theme===['"]light['"]\)/, 'resolved data-theme with legacy body.light compatibility');
requireMatch(app, /function restoreSettingsSnapshot\(previous\)[\s\S]{0,120}?applyTheme\(S\.prefs\?\.theme,S\.prefs\?\.darkPalette\)/, 'failed settings write restores the applied theme');
requireMatch(app, /let _themeMutationChain=Promise\.resolve\(\)[\s\S]{0,260}?_themeMutationChain\.then\(mutation,mutation\)[\s\S]{0,180}?request\.catch\(\(\)=>undefined\)/, 'theme mutations are serialized across persistence and rollback');
requireMatch(app, /@media\(max-width:900px\)\{[\s\S]{0,240}?#topbar-acct-badge\{display:none\}[\s\S]{0,180}?\.theme-choice-select\{max-width:116px\}/, 'theme selector preserves topbar space at compact desktop widths');
requireMatch(app, /@media\(max-width:720px\)\{[\s\S]{0,220}?\.topbar-left\{display:none\}[\s\S]{0,260}?\.theme-choice-select\{max-width:104px\}/, 'theme selector remains visible without overflowing narrow topbars');
try {
  const themeSource=sourceBetween('const DARK_THEME_PALETTES=', 'let _themeChartRedrawToken=0;');
  const { exports: theme }=evaluateSecurityFixture(
    themeSource,
    {},
    '{normalizeDarkPalette,themeChoiceFromPreferences,parseThemeChoice}',
  );
  const legacyDark=theme.themeChoiceFromPreferences({theme:'dark'});
  const legacyLight=theme.themeChoiceFromPreferences({theme:'light'});
  const navy=theme.themeChoiceFromPreferences({theme:'dark',darkPalette:'navy'});
  if(legacyDark.choice!=='dark-midnight'||legacyLight.choice!=='light-paper'||navy.choice!=='dark-navy') {
    failures.push('Legacy dark/light preferences do not resolve to canonical theme choices');
  }
  if(theme.parseThemeChoice('dark-obsidian')?.darkPalette!=='obsidian'||theme.parseThemeChoice('light-paper')?.theme!=='light') {
    failures.push('Canonical theme choices are not parsed correctly');
  }
  for(const untrusted of ['dark-ember','dark-__proto__','light','paper',null,{toString:()=> 'navy'}]) {
    if(theme.parseThemeChoice(untrusted)!==null)failures.push(`Unallowlisted theme choice was accepted: ${String(untrusted)}`);
  }
  if(theme.normalizeDarkPalette('ember')!=='midnight')failures.push('Unknown persisted dark palette does not fail closed to Midnight Violet');
} catch(error) {
  failures.push(`Theme preference fixture failed: ${error.message}`);
}

try {
  const settingsSource=sourceBetween('function settingsSnapshot()', '/* ═══ END SETTINGS MANAGER');
  const themeMutationSource=sourceBetween('const DARK_THEME_PALETTES=', 'async function toggleSidebarPin');
  const elements=new Map();
  const element=()=>({value:'',title:'',style:{},classList:{toggle(){}},querySelector(){return null;}});
  const deferredWrites=[];
  const themeMutationContext={
    console,
    setTimeout:callback=>callback(),
    requestAnimationFrame:()=>{},
    document:{
      documentElement:{dataset:{},style:{}},
      body:{classList:{toggle(){}}},
      getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},
      querySelector:()=>null,
    },
    SettingsManager:{set(value){return new Promise(resolve=>deferredWrites.push({value:JSON.parse(JSON.stringify(value)),resolve}));}},
    applySettings(){},buildSettingsUI(){},buildAcctDropdown(){},updateAccountSelect(){},renderPageAcctTabs(){},refreshAll(){},
    renderCharts(){},dashboardChartPalette(){return{};},showToast(){},
  };
  const {context:themeRace,exports:themeRaceApi}=evaluateSecurityFixture(
    `let S={prefs:{theme:'dark',darkPalette:'midnight'}},CH={};\n${settingsSource}\n${themeMutationSource}`,
    themeMutationContext,
    '{setThemeChoice,getState:()=>JSON.parse(JSON.stringify(S)),getDomTheme:()=>document.documentElement.dataset.theme}',
  );
  const first=themeRaceApi.setThemeChoice('dark-navy');
  const second=themeRaceApi.setThemeChoice('dark-obsidian');
  await Promise.resolve();
  const firstWrite=deferredWrites[0];
  if(!firstWrite)throw new Error('First rapid theme choice did not start its persistence transaction');
  if(deferredWrites.length!==1||firstWrite.value?.prefs?.darkPalette!=='navy') {
    failures.push('Rapid theme choices started concurrently or persisted the wrong first choice');
  }
  firstWrite.resolve(false);
  await first;
  await Promise.resolve();
  const secondWrite=deferredWrites[1];
  if(!secondWrite)throw new Error('Second theme choice did not run after the first rollback settled');
  if(deferredWrites.length!==2||secondWrite.value?.prefs?.darkPalette!=='obsidian') {
    failures.push('Second serialized theme choice persisted the wrong value');
  }
  secondWrite.resolve(true);
  const [,secondResult]=await Promise.all([first,second]);
  const settled=themeRaceApi.getState();
  if(secondResult!==true||settled?.prefs?.darkPalette!=='obsidian'||themeRaceApi.getDomTheme()!=='dark-obsidian') {
    failures.push('Failed first theme choice rolled back a later successful choice');
  }
  deferredWrites.length=0;
  const successThenFail=themeRaceApi.setThemeChoice('dark-navy');
  const finalFailure=themeRaceApi.setThemeChoice('dark-obsidian');
  await Promise.resolve();
  const successfulWrite=deferredWrites[0];
  if(!successfulWrite)throw new Error('Success-then-failure theme sequence did not start');
  successfulWrite.resolve(true);
  await successThenFail;
  await Promise.resolve();
  const failingWrite=deferredWrites[1];
  if(!failingWrite)throw new Error('Latest failing theme choice did not run after the prior success');
  failingWrite.resolve(false);
  const finalFailureResult=await finalFailure;
  const afterFinalFailure=themeRaceApi.getState();
  if(finalFailureResult!==false||afterFinalFailure?.prefs?.darkPalette!=='navy'||themeRaceApi.getDomTheme()!=='dark-navy') {
    failures.push('Failed latest theme choice did not restore the preceding successful choice');
  }
  void themeRace;
} catch(error) {
  failures.push(`Theme mutation serialization fixture failed: ${error.message}`);
}

// Trading Playbook: recommended defaults remain a low-friction starting point,
// while user terminology, nested setups, ordered fields, and option libraries
// stay fully editable without mutating historical snapshots.
requireMatch(app, /id=["']sn-playbook["'][\s\S]{0,180}?showSPanel\(['"]playbook['"]/, 'Trading Playbook settings navigation');
requireMatch(app, /id=["']sp-playbook["'][\s\S]*?Edgebook recommended[\s\S]*?My custom playbook/, 'recommended and custom playbook choices');
requireMatch(app, /function playbookRecommendedSettings\b[\s\S]*?strategy:\{label:'Strategy',enabled:true[\s\S]*?execution:\{label:'Execution quality',enabled:false/, 'low-friction recommended playbook defaults');
requireMatch(app, /function normalizePlaybookSettings\b[\s\S]*?fields\[key\]\.required=false/, 'hidden playbook fields cannot remain required');
requireMatch(app, /function buildPlaybookStrategyList\b[\s\S]*?addPlaybookSetup/, 'nested strategy and setup management');
requireMatch(app, /function buildTradePlaybookForm\b[\s\S]*?updateTradeSetupOptions/, 'dependent playbook trade-form dropdowns');
requireMatch(app, /function readTradePlaybook\b[\s\S]*?playbookTradeSnapshot\(existingTrade\)/, 'historical playbook snapshot preservation');
requireMatch(app, /const playbookSnapshot=readTradePlaybook\(existingTrade\);cfVals\.playbook=playbookSnapshot/, 'manual trades persist playbook snapshots');
requireMatch(app, /validateTradePlaybook\(\)/, 'required playbook field validation');
requireMatch(app, /Setup Grade['"],[\s\S]*?Execution Quality/, 'playbook fields included in CSV backup');
rejectMatch(app, /id=["']t-strat["']/, 'obsolete free-text strategy field');

try {
  const playbookSource = sourceBetween('const PLAYBOOK_FIELD_META=', 'function settingsSnapshot');
  const { exports: playbook } = evaluateSecurityFixture(
    playbookSource,
    {},
    '{playbookRecommendedSettings,normalizePlaybookSettings}',
  );
  const recommended = playbook.playbookRecommendedSettings();
  if (!recommended.fields.strategy.enabled || !recommended.fields.setup.enabled || recommended.fields.probability.enabled || recommended.fields.execution.enabled) {
    failures.push('Recommended playbook no longer starts with the intended low-friction field set');
  }
  const custom = playbook.normalizePlaybookSettings({
    mode: 'custom',
    fields: { strategy: { label: 'Trading System', enabled: false, required: true, order: 4 } },
    strategies: [{ id: 'fib', name: 'Fibonacci', setups: [{ id: 'golden', name: 'Golden pocket' }] }],
    grades: [{ id: 'prime', label: 'Prime', description: 'Every criterion present' }],
  });
  if (custom.mode !== 'custom' || custom.fields.strategy.label !== 'Trading System' || custom.fields.strategy.enabled || custom.fields.strategy.required ||
      custom.strategies[0]?.name !== 'Fibonacci' || custom.strategies[0]?.setups?.[0]?.name !== 'Golden pocket' || custom.grades[0]?.label !== 'Prime') {
    failures.push('Custom playbook normalization lost terminology, hierarchy, or hidden-field safety');
  }
  const blank = playbook.normalizePlaybookSettings({ mode: 'custom', strategies: [], grades: [] });
  if (blank.strategies.length !== 0 || blank.grades.length !== 0) failures.push('Custom blank playbook was repopulated unexpectedly');
} catch (error) {
  failures.push(`Trading Playbook fixture failed: ${error.message}`);
}

// The dashboard equity curve must retain the underlying per-trade values while
// presenting them on a proportionate, intelligible horizontal axis.
requireMatch(app, /class=["']equity-chart-wrap["'][\s\S]{0,120}?canvas id=["']equity-chart["']/, 'responsive equity chart wrapper');
requireMatch(app, /\.equity-chart-wrap\{[^}]*height:clamp\(300px,25vw,420px\)/, 'proportional equity chart height');
requireMatch(app, /#page-dashboard\{--text2:var\(--dashboard-text2\);--text3:var\(--dashboard-text3\)\}/, 'dashboard text hierarchy uses active semantic theme tokens');
for (const chartToken of ['--chart-grid', '--chart-tick', '--chart-zero', '--chart-tooltip-bg']) {
  requireMatch(app, new RegExp(chartToken), `semantic canvas token ${chartToken}`);
}
requireMatch(app, /function dashboardChartPalette\([^)]*\)[\s\S]{0,240}?getComputedStyle\(scope\)[\s\S]{0,1100}?read\('--green'[\s\S]{0,220}?read\('--red'[\s\S]{0,260}?read\('--chart-tick'[\s\S]{0,600}?read\('--chart-grid'[\s\S]{0,300}?read\('--chart-zero'[\s\S]{0,400}?read\('--chart-tooltip-bg'/, 'dashboard charts read computed semantic CSS colors');
requireMatch(app, /function scheduleThemeChartRedraw\(\)[\s\S]{0,500}?activePage==='dashboard'[\s\S]{0,80}?renderCharts\(\)/, 'active dashboard charts redraw after a theme switch');
requireMatch(app, /chart\.canvas\.closest\?\.\(['"]\.page-content['"]\)[\s\S]{0,120}?chartPage&&!chartPage\.classList\.contains\(['"]active['"]\)/, 'theme redraw skips charts mounted in inactive pages');
requireMatch(app, /function applyTheme\([^)]*\)[\s\S]{0,700}?scheduleThemeChartRedraw\(\)/, 'theme application schedules safe chart recoloring');
requireMatch(app, /setEquityAxisMode\(['"]date['"]\)[\s\S]{0,260}?By date/, 'date-based equity axis control');
requireMatch(app, /setEquityAxisMode\(['"]trade['"]\)[\s\S]{0,260}?By trade #/, 'explicit trade-number equity axis control');
requireMatch(app, /class=["']equity-axis-btn["'] id=["']equity-axis-date["'] aria-pressed=["']false["'][^>]*>By date<\/button>[\s\S]{0,180}?class=["']equity-axis-btn active["'] id=["']equity-axis-trade["'] aria-pressed=["']true["'][^>]*>By trade #<\/button>/, 'trade-number equity axis is active in the initial dashboard markup');
requireMatch(app, /tradeGrouping:['"]fifo['"],equityAxisMode:['"]trade['"]/, 'trade-number equity axis default preference');
requireMatch(app, /function applySettings\(\)[\s\S]{0,180}?applyEquityAxisPreference\(S\.prefs\?\.equityAxisMode\)/, 'persisted equity axis preference is applied during settings hydration');
requireMatch(app, /let _equityAxisMutationChain=Promise\.resolve\(\)[\s\S]*?function setEquityAxisMode[\s\S]{0,700}?commitSettings\(previous\)[\s\S]{0,260}?_equityAxisMutationChain\.then\(mutation,mutation\)/, 'equity axis persistence is serialized and uses settings rollback');
requireMatch(app, /function equityTradeTimestamp\b/, 'equity close timestamp projection');
requireMatch(app, /cubicInterpolationMode:['"]monotone['"]/, 'monotone equity line interpolation');
requireMatch(app, /pointRadius:context=>context\.raw\?\.synthetic\?0:\(displayedEquityPoints\.length===1\?4:0\)[\s\S]{0,220}?pointHoverRadius:4/, 'visible first equity point with decluttered multi-point curve');
requireMatch(app, /maxTicksLimit:7[\s\S]{0,180}?equityDateTick/, 'bounded date ticks on equity curve');
requireMatch(app, /Cumulative \$\{view\.degraded\?['"]provisional ['"]:['"]['"]\}P&L:\s*\$\{signedMoney\(point\.y/, 'authority-aware cumulative P&L equity tooltip');
requireMatch(app, /aggregateEquityDaily\(rawEquityPoints\)/, 'daily-close smoothing for date equity view');
requireMatch(app, /ensureEquityStartAnchor\(displayedEquityPoints,chartAxisMode\)/, 'zero baseline anchor for the first equity close');
requireMatch(app, /visibleEquityValues=displayedEquityPoints\.map[\s\S]{0,160}?equityAxisDomain\(visibleEquityValues\)/, 'dynamic equity Y-domain from visible points');
requireMatch(app, /y:\{[\s\S]{0,100}?min:yDomain\.min,[\s\S]{0,60}?max:yDomain\.max/, 'exact equity Y-domain without library tick expansion');
requireMatch(app, /insertEquityZeroCrossings\(plotEquityPoints\)/, 'exact zero crossing projection');
requireMatch(app, /segment:\{borderColor:context=>equityDirectionColor\(context\.p0\.parsed\.y,context\.p1\.parsed\.y,palette\)\}/, 'direction-aware theme-derived equity line colors');
requireMatch(app, /backgroundColor:context=>equityDirectionFillGradient\(context,palette\)/, 'direction-aware theme-derived subtle equity fill');
requireMatch(app, /pointBackgroundColor:context=>equityPointDirectionColor\(context,palette\)[\s\S]{0,120}?pointBorderColor:context=>equityPointDirectionColor\(context,palette\)/, 'direction-aware theme-derived equity point colors');
rejectMatch(app, /\(context\.p0\.parsed\.y\+context\.p1\.parsed\.y\)\/2/, 'above-or-below-zero equity segment colors');
requireMatch(app, /id=["']equity-empty["'][\s\S]{0,100}?Log a completed trade/, 'empty equity curve guidance');
rejectMatch(app, /labels:closed\.map\(\(_,i\)=>['"]T['"]\+\(i\+1\)\)/, 'opaque T-number equity labels');

const dashboardMetricsSource = sourceBetween('function updateMetrics', 'function acctTagCell');
requireMatch(dashboardMetricsSource, /pnlEl\.textContent=Number\.isFinite\(net\)\?signedMoney\(net,c,coverage\.moneyDigits\):['"]—['"][\s\S]*?pnlLabel\.textContent=view\.analysisLabel/, 'dashboard KPI uses the authority-labelled best-available financial view');
rejectMatch(app, /dashboard-financial-summary|renderDashboardFinancialSummary|financial-summary-(?:strip|item|label|value|note)/, 'removed dashboard financial-breakdown strip');
rejectMatch(dashboardMetricsSource, /pnlEl\.textContent=\(net>=0\?['"]\+['"]:['"]['"]\)\+c\+Math\.abs\(net\)/, 'dashboard Net P&L KPI sign-dropping formatter');
try {
  const signedMoneyContext = {};
  vm.runInNewContext(`${sourceBetween('function signedMoney', 'function analyticsWeekKey')}globalThis.signedMoney=signedMoney;`, signedMoneyContext);
  if (signedMoneyContext.signedMoney(-53, '$', 0) !== '-$53' || signedMoneyContext.signedMoney(53, '$', 0) !== '+$53' || signedMoneyContext.signedMoney(0, '$', 0) !== '$0' || signedMoneyContext.signedMoney(null, '$', 2) !== '—') {
    failures.push('Dashboard Net P&L formatter did not preserve negative, positive, and zero signs');
  }
} catch (error) {
  failures.push(`Dashboard Net P&L sign fixture failed: ${error.message}`);
}

const equityAxisPreferenceSource = sourceBetween('function normalizeEquityAxisMode', 'function equityDayKey');
try {
  const makeAxisButton = () => {
    const button = { active: false, disabled: false, title: '', attributes: {} };
    button.classList = { toggle(name, state) { if (name === 'active') button.active = Boolean(state); } };
    button.setAttribute = (name, value) => { button.attributes[name] = String(value); };
    return button;
  };
  const dateButton = makeAxisButton();
  const tradeButton = makeAxisButton();
  const equityAxisContext = {
    console,
    Promise,
    document: { getElementById: id => id === 'equity-axis-date' ? dateButton : id === 'equity-axis-trade' ? tradeButton : null },
  };
  vm.runInNewContext(`
    let S={prefs:{}};
    let renderCount=0;
    const commits=[];
    const outcomes=[true,false];
    function settingsSnapshot(){return JSON.parse(JSON.stringify(S));}
    function renderCharts(){renderCount+=1;}
    async function commitSettings(previous){
      commits.push(S.prefs.equityAxisMode);
      const saved=outcomes.shift();
      if(!saved){S=previous;applyEquityAxisPreference(S.prefs?.equityAxisMode);renderCharts();}
      return saved;
    }
    ${equityAxisPreferenceSource}
    globalThis.axisApi={
      initialize:value=>applyEquityAxisPreference(value),
      set:setEquityAxisMode,
      snapshot:()=>({mode:equityAxisMode,pref:S.prefs.equityAxisMode,commits:[...commits],renderCount}),
    };
  `, equityAxisContext);
  const axisApi = equityAxisContext.axisApi;
  if (axisApi.initialize(undefined) !== 'trade' || !tradeButton.active || dateButton.active || tradeButton.attributes['aria-pressed'] !== 'true') {
    failures.push('Equity axis did not initialize to By trade for a missing/legacy preference');
  }
  const dateSaved = await axisApi.set('date');
  let axisState = axisApi.snapshot();
  if (dateSaved !== true || axisState.mode !== 'date' || axisState.pref !== 'date' || axisState.commits.join(',') !== 'date' || !dateButton.active || tradeButton.active) {
    failures.push('Equity date-axis selection was not persisted and reflected in the controls');
  }
  const tradeSaved = await axisApi.set('trade');
  axisState = axisApi.snapshot();
  if (tradeSaved !== false || axisState.mode !== 'date' || axisState.pref !== 'date' || axisState.commits.join(',') !== 'date,trade' || !dateButton.active || tradeButton.active) {
    failures.push('Failed equity-axis persistence did not roll back to the last saved selection');
  }
  const commitsBeforeInvalid = axisState.commits.length;
  if (await axisApi.set('invalid') !== false || axisApi.snapshot().commits.length !== commitsBeforeInvalid) {
    failures.push('Invalid equity-axis selection reached persistence');
  }
} catch (error) {
  failures.push(`Equity axis preference fixture failed: ${error.message}`);
}
for (const insightCanvas of ['symbol-chart', 'outcome-chart', 'direction-chart', 'day-chart']) {
  requireMatch(app, new RegExp(`id=["']${insightCanvas}["']`), `dashboard insight canvas ${insightCanvas}`);
}
requireMatch(app, /function renderDashboardInsights\(ledgerRows,closed,displayC,palette,view\)[\s\S]*?const ledger=ledgerRows\.filter/, 'dashboard insights use the shared authority-labelled event ledger');
requireMatch(app, /const day=String\(event\.ledgerDate\|\|''\)\.slice\(0,10\)/, 'day consistency canonicalizes timestamp dates');
requireMatch(app, /\.insight-ring-wrap canvas\{width:100%!important;height:100%!important\}/, 'dashboard ring canvases have bounded empty-state dimensions');
requireMatch(app, /\.insight-ring-wrap\{[^}]*width:118px;height:118px/, 'prominent dashboard outcome rings');
requireMatch(app, /class=["']insight-mini-card insight-ring-card["'][\s\S]{0,220}?Outcome Mix/, 'outcome card visual treatment');
requireMatch(app, /class=["']insight-mini-card insight-ring-card["'][\s\S]{0,220}?Day Consistency/, 'day-consistency card visual treatment');
requireMatch(app, /bySymbol[\s\S]{0,500}?Math\.abs\(b\.pnl\)-Math\.abs\(a\.pnl\)/, 'signed symbol P&L ranking retains gains and losses');
requireMatch(app, /outcomeCounts=\[outcomes\.filter\(value=>value>0\)[\s\S]{0,160}?value===0/, 'outcome mix includes break-even trades');
requireMatch(app, /dayCounts=\[dayValues\.filter\(value=>value>\.005\)[\s\S]{0,180}?Math\.abs\(value\)<=\.005/, 'day consistency includes profitable losing and flat days');
requireMatch(app, /function renderDashboardInsights\([^)]*palette,view\)[\s\S]*?backgroundColor:\[palette\.positive,palette\.negative,palette\.neutral\]/, 'dashboard doughnuts use semantic theme colors');
requireMatch(app, /symbolRows\.map\(row=>row\.pnl>=0\?palette\.positiveStrong:palette\.negativeStrong\)/, 'symbol P&L bars use semantic theme colors');
requireMatch(app, /directionNames\.map\(name=>directionStats\[name\]\.pnl>=0\?palette\.positiveStrong:palette\.negativeStrong\)/, 'direction P&L bars use semantic theme colors');
requireMatch(app, /grid:\{color:context=>Number\(context\.tick\?\.value\)===0\?palette\.zeroGrid:palette\.grid/, 'dashboard chart grids use semantic theme colors');
requireMatch(app, /dashboardTooltipOptions\(palette\)/, 'dashboard tooltips use semantic theme colors');
rejectMatch(app, /id=["']asset-chart["']|Object\.keys\(apnl\)\.filter\(k=>apnl\[k\]>0\)/, 'positive-only asset-class doughnut');

try {
  const paletteSource = sourceBetween('function chartColorWithAlpha', 'function tradeChronologyKey');
  const semanticColors = {
    '--green': '#16875e', '--red': '#c84550', '--chart-tick': '#68756d',
    '--chart-grid': 'rgba(38,43,39,.075)', '--chart-zero': 'rgba(38,43,39,.24)',
    '--chart-tooltip-bg': '#fcfbf7', '--text': '#1b211e', '--dashboard-text2': '#4f5c54',
    '--accent': '#b87512', '--border2': 'rgba(38,43,39,.17)',
  };
  const paletteContext = {
    document: { getElementById: () => ({}), body: {} },
    getComputedStyle: () => ({ getPropertyValue: name => semanticColors[name] || '' }),
  };
  vm.runInNewContext(`${paletteSource}\nglobalThis.palette=dashboardChartPalette();`, paletteContext);
  const palette = paletteContext.palette;
  if (palette?.positive !== '#16875e' || palette?.negative !== '#c84550' || palette?.tick !== '#68756d' ||
      palette?.grid !== 'rgba(38,43,39,.075)' || palette?.zeroGrid !== 'rgba(38,43,39,.24)' ||
      palette?.tooltipBackground !== '#fcfbf7' || palette?.positiveStrong !== 'rgba(22,135,94,0.78)') {
    failures.push('Dashboard Chart.js palette did not resolve computed semantic CSS variables');
  }
} catch (error) {
  failures.push(`Dashboard chart palette fixture failed: ${error.message}`);
}

try {
  const redrawSource = sourceBetween('let _themeChartRedrawToken', 'function applyTheme');
  const frames = [];
  let activePageId = 'page-dashboard', dashboardRenders = 0, hiddenDashboardUpdates = 0, activePageUpdates = 0;
  const pageFor = id => ({ id, classList: { contains: name => name === 'active' && id === activePageId } });
  const redrawContext = {
    document: { querySelector: () => ({ id: activePageId }), body: {} },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    setTimeout: callback => callback(),
    renderCharts: () => { dashboardRenders += 1; },
    dashboardChartPalette: () => ({ grid: 'g', tick: 't', tooltipBackground: 'b', text: 'x', text2: 'x2', borderStrong: 's' }),
    CH: {
      hiddenDashboard: { canvas: { closest: () => pageFor('page-dashboard') }, ctx: {}, options: { scales: {}, plugins: {} }, update: () => { hiddenDashboardUpdates += 1; } },
      activeSettings: { canvas: { closest: () => pageFor('page-settings') }, ctx: {}, options: { scales: {}, plugins: {} }, update: mode => { if (mode === 'none') activePageUpdates += 1; } },
      destroyed: { options: { scales: {}, plugins: {} }, update: () => { activePageUpdates += 100; } },
    },
  };
  vm.runInNewContext(`${redrawSource}\nglobalThis.schedule=scheduleThemeChartRedraw;`, redrawContext);
  redrawContext.schedule();
  redrawContext.schedule();
  frames[0]();
  frames[1]();
  activePageId = 'page-settings';
  redrawContext.schedule();
  frames[2]();
  if (dashboardRenders !== 1 || hiddenDashboardUpdates !== 0 || activePageUpdates !== 1) {
    failures.push('Theme chart redraw is not coalesced, updates a hidden dashboard canvas, or skips an active-page chart');
  }
} catch (error) {
  failures.push(`Theme chart redraw fixture failed: ${error.message}`);
}

// Dictation is one privacy-scoped, review-first on-device Whisper controller
// for every narrative field. It never depends on the browser speech service.
const dictationSource = sourceBetween('/* One privacy-scoped on-device Whisper controller', 'const CTRADER_OWNED_FORM_IDS');
for (const target of ['t-psych-prethought','t-psych-execution','t-psych-review','t-notes']) {
  requireMatch(app,new RegExp(`data-dictation-target=["']${target}["'][\\s\\S]{0,160}?toggleDictation\\('${target}'\\)`),`trade dictation control for ${target}`);
}
for (const target of ['dj-mistake','dj-keylesson','dj-woulddodiff','dj-intentions','dj-notes']) {
  requireMatch(app,new RegExp(`dictationControlHtml\\('${target}'`),`Daily Journal dictation control ${target}`);
}
for (const target of ['mood-notes-inp','mm-notes']) {
  requireMatch(app,new RegExp(`data-dictation-target=["']${target}["']`),`mood dictation control ${target}`);
}
requireMatch(dictationControllerSource,/\^cf-v-\[A-Za-z0-9_-\]\+\$[\s\S]{0,120}?context:\s*'trade'/,'dynamic custom free-text dictation allowlist');
requireMatch(dictationControllerSource,/\^hm-note-\[A-Za-z0-9_-\]\+\$[\s\S]{0,120}?context:\s*'heatmap'/,'dynamic heatmap-note dictation allowlist');
requireMatch(app,/if\(cf\.type==='text'\)[^\n]*dictationControlHtml\(id,cf\.label\)/,'dynamic custom free-text dictation control');
requireMatch(app,/dictationControlHtml\(`hm-note-\$\{domToken\}`,'heatmap note'\)/,'dynamic heatmap dictation control');
requireMatch(app, /\.trade-voice-wave b\{[^}]*transition:height 70ms/, 'audio-level-driven live dictation waveform');
requireMatch(dictationControllerSource,/root\.isSecureContext\s*!==\s*true/,'secure-context dictation gate');
requireMatch(dictationControllerSource,/navigator\?\.mediaDevices\?\.getUserMedia/,'microphone capability gate');
requireMatch(dictationControllerSource,/baseText:\s*element\.value/,'dictation preserves existing text');
requireMatch(dictationControllerSource,/function promoteInterim[\s\S]{0,240}?renderTranscript/,'interim transcript promotion before teardown');
requireMatch(dictationControllerSource,/track\.stop\(\)/,'immediate microphone privacy stop');
requireMatch(dictationSource,/visibilitychange[\s\S]{0,180}?pagehide/,'background/page-exit privacy teardown');
requireMatch(dictationControllerSource,/spec\.context\s*===\s*'dailyjournal'\) cancelDailyAutosave\(\)/,'Daily Journal pending autosave cancellation on dictation start');
requireMatch(dictationControllerSource,/First use downloads about 95 MB once/,'finite first-use model download disclosure');
requireMatch(dictationControllerSource,/audio never leaves this device/,'on-device audio privacy disclosure');
requireMatch(whisperWorkerSource,/onnx-community\/whisper-tiny\.en/,'pretrained Whisper Tiny English model');
requireMatch(whisperWorkerSource,/@huggingface\/transformers@4\.2\.0/,'pinned Transformers.js runtime');
requireMatch(whisperWorkerSource,/env\.useBrowserCache\s*=\s*true/,'browser model cache');
requireMatch(whisperWorkerSource,/navigator\?\.gpu\s*\?\s*'webgpu'\s*:\s*'wasm'/,'WebGPU acceleration with broad WASM fallback');
requireMatch(whisperWorkerSource,/dtype:\s*'q4'/,'efficient quantized inference');
requireMatch(whisperWorkerSource,/preferredDevice\s*!==\s*'webgpu'[\s\S]{0,160}?createPipeline\('wasm'\)/,'automatic WebGPU initialization fallback');
requireMatch(whisperWorkerSource,/resampleTo16Khz/,'deterministic Whisper input resampling');
requireMatch(whisperWorkerSource,/const finalRequests\s*=\s*\[\][\s\S]{0,4000}?finalRequests\.shift\(\)\s*\|\|\s*latestInterimRequest/,'ordered final transcript queue with coalesced interim inference');
requireMatch(whisperWorkerSource,/if\s*\(next\.final\)\s*finalRequests\.push\(next\)[\s\S]{0,100}?latestInterimRequest\s*=\s*next/,'final transcript segments cannot be displaced by newer interim audio');
rejectMatch(`${app}\n${dictationControllerSource}`,/SpeechRecognition|webkitSpeechRecognition|processLocally|private English speech pack/,'unreliable browser speech service dependency');
rejectMatch(dictationControllerSource,/saveTrade\s*\(|djSaveForm\s*\(|saveMoodEntry\s*\(|hmSaveNote\s*\(/,'automatic persistence from dictation');
for (const [start,end,readMarker,label] of [
  ['async function saveTrade','/* ═══ END TRADE FORM',"document.getElementById('t-sym-select')",'trade save'],
  ['async function saveMoodEntry','async function saveModalMood','moodEmoji','mood-page save'],
  ['async function saveModalMood','function refreshAll','modalEmoji','mood-modal save'],
  ['async function hmSaveNote','async function hmAddScreenshots','const ta =','heatmap-note save'],
  ['async function djSaveForm','// also auto-save on textarea blur','djCollectForm()','Daily Journal save'],
]) {
  const saveSource=sourceBetween(start,end),stopIndex=saveSource.indexOf('stopDictation({quiet:true,immediate:true})'),readIndex=saveSource.indexOf(readMarker);
  if(stopIndex<0||readIndex<0||stopIndex>readIndex)failures.push(`Missing: ${label} freezes dictation before reading the field`);
}
requireMatch(sourceBetween('function renderHeatmap','function buildHmGridWithInsert'),/stopDictation\(\{quiet:true,immediate:true\}\)/,'heatmap redraw privacy teardown');
const equityProjectionSource = sourceBetween('function equityTradeTimestamp', 'function signedMoney');
const equityAxisDomainSource = sourceBetween('function equityAxisDomain', 'function setDashboardInsightEmpty');
const equityProjectionContext = {};
vm.runInNewContext(`
  const palette={positive:'#light-green',negative:'#light-red',neutral:'#light-neutral',positiveFill:'rgba(15,158,101,.105)',negativeFill:'rgba(217,59,71,.095)',neutralFill:'rgba(111,102,88,.045)'};
  function isRealIsoDate(value){
    const match=/^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(String(value??''));
    if(!match)return false;
    const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
    const parsed=new Date(Date.UTC(year,month-1,day));
    return parsed.getUTCFullYear()===year&&parsed.getUTCMonth()===month-1&&parsed.getUTCDate()===day;
  }
  ${equityProjectionSource}
  ${equityAxisDomainSource}
  const projected=new Date(equityTradeTimestamp({date:'2026-06-02T00:00:00.000Z',exitTime:'09:15'}));
  globalThis.result=[projected.getFullYear(),projected.getMonth()+1,projected.getDate(),projected.getHours(),projected.getMinutes()];
  const dayOne=new Date(2026,5,2,9,15).getTime(),dayTwo=new Date(2026,5,3,10,0).getTime();
  globalThis.daily=aggregateEquityDaily([
    {x:dayOne,y:10,timestamp:dayOne,tradeNumber:1,tradePnl:10,trade:{}},
    {x:dayOne+3600000,y:20,timestamp:dayOne+3600000,tradeNumber:2,tradePnl:10,trade:{}},
    {x:dayTwo,y:-10,timestamp:dayTwo,tradeNumber:3,tradePnl:-30,trade:{}}
  ]);
  globalThis.firstClose=ensureEquityStartAnchor([{x:dayOne,y:60,timestamp:dayOne,tradeNumber:1,tradePnl:60,trade:{}}],'date');
  globalThis.crossings=insertEquityZeroCrossings([{x:0,y:20,timestamp:0},{x:10,y:-20,timestamp:10}]);
  globalThis.directions=[equityDirection(-20,-10),equityDirection(20,10),equityDirection(10,10)];
  globalThis.directionColors=[equityDirectionColor(20,10,palette),equityDirectionColor(-20,-10,palette)];
  const stops=[];
  equityDirectionFillGradient({
    dataset:{data:[{x:0,y:-20},{x:5,y:10},{x:10,y:0}]},
    chart:{chartArea:{left:0,right:100},scales:{x:{getPixelForValue:value=>Number(value)*10}},ctx:{createLinearGradient:()=>({addColorStop:(offset,color)=>stops.push([offset,color])})}}
  },palette);
  globalThis.gradientStops=stops;
  globalThis.axisDomain=equityAxisDomain([-3000,2800]);
`, equityProjectionContext);
if (equityProjectionContext.result?.join('-') !== '2026-6-2-9-15') {
  failures.push('Equity date projection rejected the VPS ISO timestamp shape');
}
if (equityProjectionContext.daily?.length !== 2 || equityProjectionContext.daily[0]?.tradeCount !== 2 || equityProjectionContext.daily[0]?.y !== 20 || equityProjectionContext.daily[0]?.dayPnl !== 20) {
  failures.push('Equity date view did not aggregate to one closing point per day');
}
if (equityProjectionContext.firstClose?.length !== 2 || equityProjectionContext.firstClose[0]?.y !== 0 || !equityProjectionContext.firstClose[0]?.synthetic || equityProjectionContext.firstClose[1]?.y !== 60) {
  failures.push('First equity close has no zero baseline segment');
}
if (equityProjectionContext.crossings?.length !== 3 || equityProjectionContext.crossings[1]?.y !== 0 || equityProjectionContext.crossings[1]?.x !== 5 || !equityProjectionContext.crossings[1]?.synthetic) {
  failures.push('Equity curve no longer preserves its exact synthetic zero crossing');
}
if (equityProjectionContext.directions?.join(',') !== 'up,down,flat') {
  failures.push('Equity segment direction is not derived from the change between consecutive cumulative values');
}
if (equityProjectionContext.directionColors?.join(',') !== '#light-red,#light-green') {
  failures.push('Equity colors still follow absolute zero instead of red-down and green-up movement');
}
if (equityProjectionContext.gradientStops?.length !== 4 || !equityProjectionContext.gradientStops[0]?.[1]?.includes('15,158,101') || !equityProjectionContext.gradientStops[3]?.[1]?.includes('217,59,71')) {
  failures.push('Equity area fill does not transition from rising green to falling red');
}
if (equityProjectionContext.axisDomain?.min !== -3348 || equityProjectionContext.axisDomain?.max !== 3148) {
  failures.push('Equity axis does not stay close to the actual visible P&L range');
}

try {
  const { exports: duplicateFixture } = evaluateSecurityFixture(
    `${quantityProjectionSource}\n${duplicateResolutionSource}`,
    {},
    '{findLocalDuplicate}',
  );
  const existing = {
    id: 'existing', date: '2026-08-09', symbol: 'GOLD', direction: 'Long',
    accountId: 'acct-1', instrument: null, optionType: null,
    entry: 4144, exit: 4150, size: 0.1,
  };
  const nearCopy = {
    ...existing, id: 'new',
    entry: 4144.5, exit: 4150.5, size: 0.101,
  };
  const separateTrade = { ...nearCopy, id: 'separate', size: 0.2 };
  if (duplicateFixture.findLocalDuplicate(nearCopy, [existing])?.id !== 'existing') {
    failures.push('Near-identical manual trade was not flagged as a possible duplicate');
  }
  if (duplicateFixture.findLocalDuplicate(separateTrade, [existing]) !== null) {
    failures.push('Materially different trade was incorrectly flagged as a duplicate');
  }
  if (duplicateFixture.findLocalDuplicate(existing, [existing]) !== null) {
    failures.push('Idempotent retry of the same browser trade ID was flagged as a new duplicate');
  }
  const cTraderBaseUnits = {
    ...existing,
    id: 'ctrader-base-units',
    source: 'ctrader',
    size: 0.1,
    brokerData: { quantityProjection: { version: 1, value: '0.1', unit: 'base_units', volumeScale: 'unit_cents', source: 'provider_filled_volume', baseAssetName: 'XAU' } },
  };
  if (duplicateFixture.findLocalDuplicate(nearCopy, [cTraderBaseUnits]) !== null) {
    failures.push('A manual lot quantity was falsely matched to a cTrader base-unit quantity');
  }
} catch (error) {
  failures.push(`Manual duplicate fixture failed: ${error.message}`);
}

try {
  const insightDocument = makeFakeDocument();
  for (const id of ['symbol-chart','symbol-empty','symbol-summary','outcome-chart','outcome-empty','outcome-rate','outcome-legend','direction-chart','direction-empty','direction-summary','day-chart','day-empty','day-rate','day-legend']) {
    insightDocument.getElementById(id).id = id;
  }
  const renderedInsightCharts = new Map();
  class FakeInsightChart {
    constructor(element, config) { this.element = element; this.config = config; renderedInsightCharts.set(element.id, this); }
    destroy() { this.destroyed = true; }
  }
  const insightPalette = {
    positive: '#theme-green', negative: '#theme-red', neutral: '#theme-neutral',
    positiveStrong: 'theme-green-strong', negativeStrong: 'theme-red-strong',
    tick: 'theme-tick', grid: 'theme-grid', zeroGrid: 'theme-zero-grid',
    tooltipBackground: 'theme-surface', text: 'theme-text', text2: 'theme-text2', borderStrong: 'theme-border',
  };
  const insightSource = sourceBetween('function setDashboardInsightEmpty', 'function renderCharts');
  const { exports: insightRenderer } = evaluateSecurityFixture(
    insightSource,
    {
      document: insightDocument,
      Chart: FakeInsightChart,
      CH: {},
      CBO: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      GC: 'grid',
      TC: 'text',
      DASH_TC: 'dashboard-text',
      FxRates: { toUSD: value => Number(value) },
      acctCur: () => '$',
      tradePnlInAccountCurrency: (trade, value = trade?.pnl) => Number(value),
      tradePnlToUSD: (trade, value = trade?.pnl) => Number(value),
      realizedLedgerForTrades: source => source,
      isRealIsoDate: value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)),
      safeAccountColor: value => value,
      escapeHtml: value => String(value),
      signedMoney: (value, symbol) => `${Number(value) < 0 ? '-' : Number(value) > 0 ? '+' : ''}${symbol}${Math.abs(Number(value)).toFixed(0)}`,
      equityMoneyTick: (value, symbol) => `${symbol}${value}`,
      dashboardTooltipOptions: palette => ({ backgroundColor: palette.tooltipBackground }),
    },
    '{renderDashboardInsights}',
  );
  const realised = [
    { symbol: 'XAUUSD', ledgerDate: '2026-08-01T00:00:00.000Z', displayPnl: 120, direction: 'Long', accountId: 'a' },
    { symbol: 'BTCUSD', ledgerDate: '2026-08-02', displayPnl: -200, direction: 'Short', accountId: 'a' },
    { symbol: 'XAUUSD', ledgerDate: '2026-08-02', displayPnl: -20, direction: 'Long', accountId: 'a' },
    { symbol: 'EURUSD', ledgerDate: '2026-08-03', displayPnl: 0, direction: 'Short', accountId: 'a' },
  ];
  const closedOutcomes = [
    { _displayPnl: 100, direction: 'Long', accountId: 'a' },
    { _displayPnl: -200, direction: 'Short', accountId: 'a' },
    { _displayPnl: 0, direction: 'Short', accountId: 'a' },
  ];
  insightRenderer.renderDashboardInsights(realised, closedOutcomes, '$', insightPalette, { degraded: true });
  const symbolConfig = renderedInsightCharts.get('symbol-chart')?.config;
  const outcomeConfig = renderedInsightCharts.get('outcome-chart')?.config;
  const directionConfig = renderedInsightCharts.get('direction-chart')?.config;
  const dayConfig = renderedInsightCharts.get('day-chart')?.config;
  if (symbolConfig?.data?.labels?.[0] !== 'BTCUSD' || symbolConfig?.data?.datasets?.[0]?.data?.[0] !== -200 || !insightDocument.getElementById('symbol-summary').textContent.includes('mixed provisional total -$100')) {
    failures.push('P&L-by-symbol insight omitted or misranked a losing symbol');
  }
  if (outcomeConfig?.data?.datasets?.[0]?.data?.join(',') !== '1,1,1' || insightDocument.getElementById('outcome-rate').textContent !== '33%') {
    failures.push('Outcome-mix insight does not reconcile wins losses and break-even trades');
  }
  if (directionConfig?.data?.datasets?.[0]?.data?.join(',') !== '100,-200') {
    failures.push('Direction-edge insight does not retain signed long/short P&L');
  }
  if (dayConfig?.data?.datasets?.[0]?.data?.join(',') !== '1,1,1' || insightDocument.getElementById('day-rate').textContent !== '33%') {
    failures.push('Day-consistency insight does not reconcile profitable losing and flat days');
  }
  if (symbolConfig?.data?.datasets?.[0]?.backgroundColor?.join(',') !== 'theme-red-strong,theme-green-strong,theme-green-strong' || directionConfig?.data?.datasets?.[0]?.backgroundColor?.join(',') !== 'theme-green-strong,theme-red-strong') {
    failures.push('Dashboard P&L bars did not consume the supplied semantic chart palette');
  }
  if (outcomeConfig?.data?.datasets?.[0]?.backgroundColor?.join(',') !== '#theme-green,#theme-red,#theme-neutral' || dayConfig?.data?.datasets?.[0]?.backgroundColor?.join(',') !== '#theme-green,#theme-red,#theme-neutral') {
    failures.push('Dashboard doughnuts did not consume the supplied semantic chart palette');
  }
  if (symbolConfig?.options?.scales?.x?.ticks?.color !== 'theme-tick' || symbolConfig?.options?.plugins?.tooltip?.backgroundColor !== 'theme-surface') {
    failures.push('Dashboard axes or tooltips did not consume the supplied semantic chart palette');
  }
} catch (error) {
  failures.push(`Dashboard insight fixture failed: ${error.message}`);
}
const settingsSaveIndex = browserSettingsMigrationSource.indexOf('const saved=await SettingsManager.set(merged);');
const settingsMarkerAfterSave = browserSettingsMigrationSource.indexOf("localStorage.setItem(marker,'complete');", settingsSaveIndex + 1);
if (settingsSaveIndex < 0 || settingsMarkerAfterSave < settingsSaveIndex) {
  failures.push('Browser-settings migration marker is not written after the confirmed VPS save');
}

try {
  const { exports: settingsMigration } = evaluateSecurityFixture(
    browserSettingsMergeSource,
    {},
    '{mergeBrowserSettings}',
  );
  const merged = JSON.parse(JSON.stringify(settingsMigration.mergeBrowserSettings(
    {
      remoteOnly: true,
      prefs: { shared: 'remote', remotePreference: true },
      formFields: { remoteField: true },
      accounts: [
        { id: 'remote-newer', name: 'Remote newer', updatedAt: '2026-08-09T10:00:00Z' },
        { id: 'local-newer', name: 'Remote older', updatedAt: '2026-08-01T10:00:00Z' },
      ],
      brokerAccountMap: { shared: 'remote-account', remoteOnly: 'remote-account' },
      customFields: [{ id: 'remote-field', label: 'Remote field' }],
    },
    {
      localOnly: true,
      prefs: { shared: 'local', localPreference: true },
      formFields: { localField: true },
      accounts: [
        { id: 'remote-newer', name: 'Local older', updatedAt: '2026-08-01T10:00:00Z' },
        { id: 'local-newer', name: 'Local newer', updatedAt: '2026-08-09T10:00:00Z' },
        { id: 'local-only', name: 'Local only' },
      ],
      brokerAccountMap: { shared: 'local-account', localOnly: 'local-account' },
      customFields: [{ id: 'local-field', label: 'Local field' }],
    },
  )));
  const accounts = Object.fromEntries(merged.accounts.map(account => [account.id, account.name]));
  if (!merged.remoteOnly || !merged.localOnly) failures.push('Browser-settings merge dropped an ordinary remote/local-only key');
  if (merged.prefs.shared !== 'remote' || !merged.prefs.remotePreference || !merged.prefs.localPreference) {
    failures.push('Browser-settings merge precedence for nested preferences regressed');
  }
  if (!merged.formFields.remoteField || !merged.formFields.localField) failures.push('Browser-settings merge dropped nested form fields');
  if (accounts['remote-newer'] !== 'Remote newer' || accounts['local-newer'] !== 'Local newer' || accounts['local-only'] !== 'Local only') {
    failures.push('Browser-settings account timestamp/local-only merge regressed');
  }
  if (merged.brokerAccountMap.shared !== 'local-account' || merged.brokerAccountMap.remoteOnly !== 'remote-account') {
    failures.push('Browser broker-account mapping did not retain reviewed local precedence');
  }
  if (merged.customFields.length !== 1 || merged.customFields[0].id !== 'remote-field') {
    failures.push('Remote custom fields did not retain reviewed precedence');
  }
} catch (error) {
  failures.push(`Browser-settings migration fixture failed: ${error.message}`);
}

try {
  const journalPersistenceSource = sourceBetween('function djStorageKey', 'function renderDailyJournal');
  const stableJournalJson = value => {
    if (Array.isArray(value)) return `[${value.map(stableJournalJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJournalJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  const storageValues = new Map();
  const localStorage = {
    getItem: key => storageValues.has(key) ? storageValues.get(key) : null,
    setItem: (key, value) => storageValues.set(key, String(value)),
    removeItem: key => storageValues.delete(key),
  };
  const dataStore = { _uid: 'user-1', _legacyUid: null };
  const serverBase = { notes: 'server base', date: '2026-08-09' };
  const firstWindow = {
    _dataMode: 'vps',
    _vpsData: { journals: {
      state: () => ({ known: true, version: 1, entry: serverBase }),
      get: async () => serverBase,
      put: async () => { throw new Error('offline'); },
    } },
  };
  const { exports: journalFirst } = evaluateSecurityFixture(
    journalPersistenceSource,
    { window: firstWindow, localStorage, DataStore: dataStore, stableJson: stableJournalJson, console: { error() {}, warn() {}, log() {} } },
    '{djSaveEntry,djLoadAll,djLoadDirty,djFingerprint,djClearDirty}',
  );
  const initialEntry = { notes: 'offline edit' };
  if (await journalFirst.djSaveEntry('2026-08-09', initialEntry)) failures.push('Offline journal save incorrectly reported VPS durability');
  if (await journalFirst.djSaveEntry('2026-08-09', { notes: 'newer offline edit' })) failures.push('Later offline journal edit incorrectly reported VPS durability');
  if (await journalFirst.djClearDirty('2026-08-09', { ...initialEntry, date: '2026-08-09' }) !== false) {
    failures.push('An older journal write cleared a later dirty edit');
  }

  // Re-evaluate the module against the same browser storage to model an app
  // reload. The newest local entry and retry marker must both survive.
  const { exports: journalReloaded } = evaluateSecurityFixture(
    journalPersistenceSource,
    { window: firstWindow, localStorage, DataStore: dataStore, stableJson: stableJournalJson, console: { error() {}, warn() {}, log() {} } },
    '{djLoadAll,djLoadDirty,djFingerprint}',
  );
  const reloadedDirty = JSON.parse(JSON.stringify(journalReloaded.djLoadDirty()['2026-08-09']));
  const reloadedLocal = JSON.parse(JSON.stringify(journalReloaded.djLoadAll()['2026-08-09']));
  const reloadedFingerprint = await journalReloaded.djFingerprint(reloadedLocal);
  if (!reloadedDirty?.baseKnown || reloadedDirty?.baseVersion !== 1 || reloadedDirty?.baseFingerprint == null ||
      reloadedDirty?.pendingFingerprint !== reloadedFingerprint || 'notes' in reloadedDirty || reloadedLocal?.notes !== 'newer offline edit') {
    failures.push('Journal local data or durable retry marker did not survive reload');
  }
} catch (error) {
  failures.push(`Journal dirty-marker fixture failed: ${error.message}`);
}

try {
  const stableJournalJson = value => {
    if (Array.isArray(value)) return `[${value.map(stableJournalJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJournalJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  const fingerprint = async value => {
    const source = stableJournalJson(value);
    let a = 2166136261, b = 2246822507;
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      a = Math.imul(a ^ code, 16777619) >>> 0;
      b = Math.imul(b ^ (code + index), 3266489909) >>> 0;
    }
    return `fallback-${source.length}-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
  };
  const date = '2026-08-09';
  const baseEntry = { notes: 'base A', date };
  const localEntry = { notes: 'local A', date };
  const remoteEntry = { notes: 'remote B', date };
  const dirtyMarker = {
    baseKnown: true,
    baseVersion: 1,
    baseFingerprint: await fingerprint(baseEntry),
    pendingFingerprint: await fingerprint(localEntry),
    markedAt: '2026-08-09T10:00:00Z',
  };
  let journalPutCount = 0;
  let conflictRecord = null;
  const { exports: migration } = evaluateSecurityFixture(
    browserDataMigrationSource,
    {
      window: { _dataMode: 'vps', _vpsData: {
        moods: { list: async () => [], create: async () => null },
        journals: {
          list: async () => [{ date, entry: remoteEntry, version: 2 }],
          put: async () => { journalPutCount += 1; },
        },
      } },
      localStorage: { getItem() { return null; }, setItem() {} },
      readBrowserJson: () => null,
      DataStore: { _loadDirtyMoodIds: () => new Set(), _clearDirtyMood() {} },
      browserMoodCandidates: () => [],
      browserJournalCandidates: () => ({ [date]: localEntry }),
      djLoadDirty: () => ({ [date]: { ...dirtyMarker } }),
      djValidDirtyMarker: marker => marker?.baseKnown === true && typeof marker?.baseFingerprint === 'string' && typeof marker?.pendingFingerprint === 'string',
      djFingerprint: fingerprint,
      djSaveDirty: () => true,
      djRecordConflict: (conflictDate, marker, remote) => { conflictRecord = { conflictDate, marker, remote }; },
      djClearDirty: async () => { throw new Error('conflicting marker must not clear'); },
      moodFingerprint: value => stableJournalJson(value),
      stableJson: stableJournalJson,
      runInBatches: async (items, worker) => { for (const item of items) await worker(item); },
    },
    '{migrateBrowserLocalData}',
  );
  let conflictError = null;
  try { await migration.migrateBrowserLocalData({ uid: 'user-1' }); } catch (error) { conflictError = error; }
  if (conflictError?.code !== 'JOURNAL_SYNC_CONFLICT' || journalPutCount !== 0 || conflictRecord?.conflictDate !== date || conflictRecord?.remote?.version !== 2 ||
      localEntry.notes !== 'local A' || remoteEntry.notes !== 'remote B') {
    failures.push('Divergent dirty/local and newer remote journal edits were not preserved as a no-PUT conflict');
  }
} catch (error) {
  failures.push(`Journal startup-conflict fixture failed: ${error.message}`);
}

try {
  const staleDate = '2026-08-08';
  const staleMood = { id: 'deleted-mood', emoji: '😟', note: 'deleted elsewhere' };
  const staleJournal = { date: staleDate, notes: 'deleted elsewhere' };
  let moodCreateCount = 0;
  let journalPutCount = 0;
  let markerWriteCount = 0;
  const stableFixtureJson = value => JSON.stringify(value, Object.keys(value || {}).sort());
  const { exports: migration } = evaluateSecurityFixture(
    browserDataMigrationSource,
    {
      window: { _dataMode: 'vps', _vpsData: {
        moods: { list: async () => [], create: async () => { moodCreateCount += 1; } },
        journals: { list: async () => [], put: async () => { journalPutCount += 1; } },
      } },
      localStorage: { setItem() { markerWriteCount += 1; } },
      readBrowserJson: key => key.startsWith('edgebook_vps_local_migration_') ? { verifiedAt: '2026-08-09T00:00:00Z' } : null,
      DataStore: { _loadDirtyMoodIds: () => new Set(), _clearDirtyMood() {} },
      browserMoodCandidates: () => [staleMood],
      browserJournalCandidates: () => ({ [staleDate]: staleJournal }),
      djLoadDirty: () => ({}),
      djValidDirtyMarker: () => false,
      djFingerprint: async value => stableFixtureJson(value),
      djSaveDirty: () => true,
      djRecordConflict() {},
      djClearDirty: async () => true,
      moodFingerprint: value => stableFixtureJson(value),
      stableJson: stableFixtureJson,
      runInBatches: async (items, worker) => { for (const item of items) await worker(item); },
    },
    '{migrateBrowserLocalData}',
  );
  const result = await migration.migrateBrowserLocalData({ uid: 'user-1', legacyFirebaseUid: 'legacy-user-1' });
  if (moodCreateCount !== 0 || journalPutCount !== 0 || result?.moods?.length !== 0 || result?.journals?.length !== 0 || markerWriteCount !== 1) {
    failures.push('Completed browser migration resurrected stale cached mood or journal data');
  }
} catch (error) {
  failures.push(`Completed browser migration one-shot fixture failed: ${error.message}`);
}
requireMatch(app, /_vpsData\.screenshots\.delete/, 'VPS screenshot deletion');
requireMatch(app, /data-auth-mode=["']vps["'][\s\S]*?#screenshot-url-row|html\[data-auth-mode="vps"\] #screenshot-url-row/, 'VPS image-URL control hiding');
requireMatch(app, /promoteTradeScreenshots/, 'legacy screenshot promotion');
requireMatch(app, /PNG, JPG, WebP/, 'supported screenshot label');
requireMatch(app, /accept=["']image\/png,image\/jpeg,image\/webp["']/, 'restricted screenshot file picker');
requireMatch(app, /SCREENSHOT_MIME_TYPES=new Set\(\[['"]image\/png['"],['"]image\/jpeg['"],['"]image\/webp['"]\]\)/, 'screenshot runtime MIME allowlist');
requireMatch(app, /const pendingScreenshots=\(trade\.screenshots\|\|\[\]\)\.filter/, 'screenshot promotion on existing and new trades');
rejectMatch(app, /pendingScreenshots\s*=\s*!exists\s*\?/, 'new-trade-only screenshot promotion');
requireMatch(app, /pendingTradeScreenshotDraft\s*=\s*\[\][\s\S]*?queuePendingTradeScreenshotFile/, 'new-trade screenshot retains its File in a modal draft');
requireMatch(app, /const idempotencyKey=crypto\.randomUUID\(\)[\s\S]*?pendingTradeScreenshotDraft\.push\(item\)/, 'new-trade screenshot retains a stable upload idempotency key');
requireMatch(screenshotDraftUploadSource, /uploadVpsScreenshotFile\(trade\.id,item\.file,\{idempotencyKey:item\.idempotencyKey\}\)/, 'new-trade screenshot uploads the retained File with its stable key after canonical create');
rejectMatch(screenshotDraftUploadSource, /fetch\s*\(/, 'data or blob fetch in new-trade screenshot upload');
requireMatch(newTradeScreenshotPersistenceSource, /previousDraftTrade\?\.version[\s\S]*?trade\.version=previousDraftTrade\.version/, 'attachment retry carries canonical optimistic-concurrency version');
requireMatch(newTradeScreenshotPersistenceSource, /attachmentsSaved:false[\s\S]*?form is still open/, 'failed attachment keeps the new-trade form recoverable');
requireMatch(newTradeScreenshotPersistenceSource, /attachmentsSaved:true[\s\S]*?if\(!result\.attachmentsSaved\)[\s\S]*?return false;[\s\S]*?closeModal\(['"]trade-modal['"],\{force:true\}\)/, 'new-trade modal closes only after every pending attachment succeeds');
requireMatch(screenshotSelectionSource, /const generation=context\.generation[\s\S]*?const targetTradeId=context\.targetTradeId[\s\S]*?generation!==_tradeModalGeneration[\s\S]*?uploadVpsScreenshotFile\(targetTradeId,uploadFile\)/, 'screenshot selection binds modal generation and target trade before compression');
rejectMatch(screenshotSelectionSource, /uploadVpsScreenshotFile\(editId|screenshots\.upload\(String\(editId\)/, 'mutable edit ID after asynchronous screenshot compression');
requireMatch(heatmapScreenshotSource, /const uploadFile=new File[\s\S]*?uploadVpsScreenshotFile\(t\.id,uploadFile,\{idempotencyKey\}\)[\s\S]*?loadFromFirestore\(\{forceServer:true\}\)/, 'heatmap performs direct private upload with partial-success reconciliation');
requireMatch(closeModalSource, /pendingTradeScreenshotDraft\.length[\s\S]*?Discard pending screenshots[\s\S]*?discardPending:true/, 'trade modal requires explicit confirmation before discarding pending files');

// cTrader keeps official read-only OAuth as the primary route. An explicitly
// enabled Remote MCP compatibility route accepts the old copied configuration
// through the same-origin API, with a mandatory trading-capability warning.
requireMatch(app, /app\.html\?ctrader=select|callback\?\.state===['"]select['"]/, 'cTrader OAuth account-selection callback');
requireMatch(app, /pendingOAuth\(\)/, 'pending cTrader OAuth grant lookup');
requireMatch(app, /mappedLegacyAccountId/, 'cTrader legacy account mapping');
requireMatch(app, /function applyVpsCtraderPickerDefaults[\s\S]*?existing\?\.mappedLegacyAccountId/, 'cTrader reconnect mapping preservation');
requireMatch(app, /lastSyncStatus/, 'cTrader sync status rendering');
requireMatch(app, /positionsAwaitingReview[\s\S]*?Review needed/, 'cTrader quarantined-position review state');
requireMatch(app, /lastWarning[\s\S]*?excluded from the journal and analytics/, 'cTrader safe execution-quarantine explanation');
requireMatch(app, /Official OAuth uses read-only account access|Edgebook invokes read tools only/, 'automatic cTrader sync messaging');
requireMatch(app, /function cTraderReviewRevision[\s\S]*?realizedEvents[\s\S]*?executions:/, 'cTrader provider-revision review marker');
requireMatch(app, /function cTraderTradeNeedsReview[\s\S]*?edgebookReview/, 'cTrader needs-review detection');
requireMatch(app, /cfVals\.edgebookReview=\{version:1,providerRevision:cTraderReviewRevision\(existingTrade\)/, 'cTrader review acknowledgement on journal save');
requireMatch(app, /const CTRADER_OWNED_FORM_IDS=[\s\S]*?function setTradeBrokerOwnedMode/, 'cTrader broker-owned form lock');
requireMatch(app, /const CTRADER_OWNED_FORM_IDS=\[[^\]]*['"]t-time['"][^\]]*\]/, 'cTrader execution-time form lock');
rejectMatch(app.match(/const CTRADER_OWNED_FORM_IDS=\[[^\]]*\]/)?.[0] || '', /['"]t-date['"]/, 'cTrader journal-date form lock');
requireMatch(app, /id="t-date-label"[\s\S]*?id="t-date"[\s\S]*?id="t-date-help"/, 'editable cTrader journal-date explanation');
requireMatch(app, /getElementById\('t-date'\)\.value=tradeJournalDate\(t\)\|\|todayIST\(\)/, 'cTrader journal date is populated from canonical provider date');
requireMatch(app, /cTraderReviewBadge\(t\)/, 'cTrader needs-review table badge');
requireMatch(app, /function renderHmInsert[\s\S]*?getTradeSizeValue\(t\)[\s\S]*?getSizeLabel\(t\)[\s\S]*?Size \(\$\{escapeHtml\(sizeUnit\)\}\)/, 'heatmap cTrader quantity unit label');
requireMatch(app, /id="sn-brokers"[^>]*showBrokerConnections/, 'dedicated broker sync settings navigation');
requireMatch(app, /cTrader automatic sync[\s\S]*?Setup required[\s\S]*?never paste a broker password, API secret, or access token/, 'visible fail-closed cTrader setup card');
requireMatch(app, /escapeCtraderText\(JSON\.stringify\(id\)\)/, 'safe VPS cTrader inline identifier');
requireMatch(app, /html\[data-auth-mode="vps"\] \.ctrader-legacy-only\{display:none!important\}/, 'legacy cTrader controls hidden in VPS mode');
requireMatch(dataAdapter, /['"]\/ctrader\/oauth\/start['"]/, 'same-origin cTrader OAuth start route');
requireMatch(dataAdapter, /['"]\/ctrader\/oauth\/pending['"]/, 'same-origin cTrader OAuth pending route');
requireMatch(dataAdapter, /['"]\/ctrader\/mcp\/connect['"]/, 'same-origin cTrader Remote MCP connection route');
requireMatch(dataAdapter, /\/live-reconciliation['"`]/, 'same-origin live cTrader reconciliation read route');
requireMatch(dataAdapter, /\/live-reconciliation\/\$\{encodedCandidateId\}\/resolve/, 'same-origin live cTrader reconciliation decision route');
requireMatch(dataAdapter, /resolveLiveCandidate[\s\S]*?['"]if-match['"][\s\S]*?['"]idempotency-key['"][\s\S]*?resolutionClientRequestId[\s\S]*?recoveredAfterAmbiguousResponse/, 'live cTrader decision concurrency and exact lost-response recovery');
requireMatch(dataAdapter, /\/historical-imports['"`]/, 'same-origin staged cTrader historical-import route');
requireMatch(dataAdapter, /\/historical-imports\/current/, 'canonical cTrader historical-import recovery route');
requireMatch(dataAdapter, /\/reconciliation\/\$\{encodedCandidateId\}\/resolve/, 'same-origin cTrader reconciliation route');
requireMatch(dataAdapter, /startHistoricalPreview[\s\S]*?['"]idempotency-key['"][\s\S]*?recoveredAfterAmbiguousResponse/, 'historical preview lost-response reconciliation');
requireMatch(dataAdapter, /resolveHistoricalCandidate[\s\S]*?['"]if-match['"][\s\S]*?['"]idempotency-key['"][\s\S]*?recoveredAfterAmbiguousResponse/, 'historical decision concurrency and lost-response reconciliation');
rejectMatch(dataAdapter, /https?:\/\//i, 'absolute URL in VPS data adapter');
requireMatch(app, /Possible cTrader matches[\s\S]*?Nothing is merged automatically/, 'visible live cTrader reconciliation review');
requireMatch(app, /Merge keeps one record:[\s\S]*?chosen manual trade ID becomes cTrader-linked[\s\S]*?Manual P&amp;L survives only when cTrader has no verified P&amp;L/, 'live merge explains identity survival and broker-first P&L precedence');
requireMatch(app, /function liveCtraderAllowedActions[\s\S]*?candidate\.allowedActions[\s\S]*?classActions\.has/, 'live cTrader actions intersect server authorization and known classifications');
requireMatch(app, /classification===['"]ambiguous['"][\s\S]*?Choose the manual journal trade to merge[\s\S]*?manualSelections/, 'ambiguous live cTrader match requires explicit manual selection');
requireMatch(app, /manual\.hasStrategy[\s\S]*?manual\.hasPsychology[\s\S]*?manual\.hasNotes[\s\S]*?manual\.hasCustomFields[\s\S]*?manual\.screenshotCount/, 'live cTrader review shows preservation flags');
requireMatch(app, /brokerFirst=isManual&&isCTraderTrade\(existing\)[\s\S]*?replace\.style\.display=brokerFirst\?['"]none['"]/, 'broker-first duplicate hides manual price replacement');
requireMatch(app, /action===['"]replace_prices['"]&&brokerFirst[\s\S]*?Verified cTrader facts cannot be replaced/, 'broker-first duplicate rejects forged price replacement');
requireMatch(app, /queueBrokerFirstReconciliation[\s\S]*?\.ctrader\.sync[\s\S]*?review the match in Settings/, 'broker-first keep-both queues reconciliation review');

const ctraderMcpModalSource = sourceBetween('<!-- VPS cTrader Remote MCP compatibility.', '<!-- VPS cTrader OAuth account picker');
const ctraderMcpSubmitSource = sourceBetween('function clearVpsCtraderMcpForm', 'function openVpsCtraderPicker');
const ctraderHistoryModalSource = sourceBetween('<!-- Historical cTrader imports are staged for review.', '<div class="s-section" style="margin-top:16px">');
const ctraderHistoryUiSource = sourceBetween('function ctraderHistoryRequestId', 'async function syncVpsCtraderConnection');
requireMatch(ctraderMcpModalSource, /id="ctrader-mcp-configuration"[\s\S]*?<\/textarea>/, 'full copied Remote MCP configuration field');
requireMatch(ctraderMcpModalSource, /id="ctrader-mcp-account-id"[^>]*inputmode="numeric"/, 'optional numeric cTrader account ID');
requireMatch(ctraderMcpModalSource, /id="ctrader-mcp-environment"[\s\S]*?value="live"[\s\S]*?value="demo"/, 'explicit cTrader live or demo environment selection');
requireMatch(ctraderMcpModalSource, /id="ctrader-mcp-map-account"/, 'Remote MCP Edgebook account mapping');
requireMatch(ctraderMcpModalSource, /id="ctrader-mcp-label"/, 'Remote MCP connection label');
requireMatch(ctraderMcpModalSource, /id="ctrader-mcp-risk-ack"[\s\S]*?session-bound and trading-capable[\s\S]*?only read tools/, 'explicit Remote MCP capability acknowledgement');
requireMatch(ctraderMcpModalSource, /id="ctrader-mcp-flat-ack"[\s\S]*?When I click Connect[\s\S]*?no open positions[\s\S]*?older history will not be inferred[\s\S]*?hold role-less positions out of the journal/, 'explicit account-flat lineage acknowledgement');
rejectMatch(ctraderMcpModalSource, /type="password"|client secret|access token|refresh token|\bFIX\b/i, 'unrelated credential field in Remote MCP compatibility modal');
requireMatch(ctraderMcpSubmitSource, /if\(!requestBody\.acknowledgeTradingCredentialRisk\)[\s\S]*?return;/, 'Remote MCP acknowledgement enforcement');
requireMatch(ctraderMcpSubmitSource, /document\.getElementById\(['"]ctrader-mcp-configuration['"]\)\.value=['"]['"]/, 'Remote MCP configuration cleared after submission');
rejectMatch(ctraderMcpSubmitSource, /localStorage|sessionStorage|console\.(?:log|warn|error)/, 'Remote MCP secret persistence or logging');
requireMatch(app, /current\.authMode\|\|current\.mode[\s\S]*?Remote MCP compatibility[\s\S]*?Official OAuth/, 'cTrader connection mode rendering');
requireMatch(ctraderHistoryModalSource, /Import earlier cTrader trades[\s\S]*?Start date[\s\S]*?Timezone \(IANA name\)/, 'historical import boundary controls');
requireMatch(ctraderHistoryModalSource, /Required:[\s\S]*?no open positions[\s\S]*?does not modify or reuse[\s\S]*?flat when connected/, 'separate required historical lineage statement');
requireMatch(ctraderHistoryModalSource, /staged preview[\s\S]*?does not publish trades[\s\S]*?change dashboard totals/, 'non-publishing historical preview explanation');
requireMatch(ctraderHistoryModalSource, /role-less deals cannot be reconstructed safely[\s\S]*?execution-only[\s\S]*?will not guess/, 'historical execution-only safety explanation');
requireMatch(ctraderHistoryUiSource, /if\(!acknowledged\)[\s\S]*?return;/, 'required historical boundary acknowledgement enforcement');
requireMatch(ctraderHistoryUiSource, /Exact boundary:[\s\S]*?boundary\.boundaryAt[\s\S]*?server will independently validate/, 'exact historical instant preview');
requireMatch(ctraderHistoryUiSource, /classificationActions=\{[\s\S]*?deleted:new Set\(\[['"]suppress_deleted['"],['"]reject['"]\]\)[\s\S]*?['"]execution-only['"]:new Set\(\[['"]reject['"]\]\)/, 'classification-scoped historical actions');
requireMatch(ctraderHistoryUiSource, /if\(!Array\.isArray\(candidate\?\.allowedActions\)\)return \[\]/, 'historical actions fail closed without server authorization');
requireMatch(ctraderHistoryUiSource, /action===['"]leave_pending['"]\?showToast[\s\S]*?:resolveCtraderCandidate/, 'leave-pending is a non-mutating client decision');
requireMatch(ctraderHistoryUiSource, /reject:['"]Exclude from this import['"][\s\S]*?allowed\.includes\(action\)/, 'server-authorized historical exclusion control');
requireMatch(ctraderHistoryUiSource, /reject:['"]No journal trade will be created, linked, deleted, or edited\.[\s\S]*?Only this staged candidate is excluded from this historical import/, 'non-destructive historical exclusion confirmation');
requireMatch(ctraderHistoryUiSource, /manual\.hasNotes[\s\S]*?manual\.hasPsychology[\s\S]*?customFieldCount[\s\S]*?screenshotCount/, 'privacy-preserving manual journal summary shown in historical review');
requireMatch(ctraderHistoryUiSource, /quantityUnit===['"]base_units['"][\s\S]*?quantityBaseUnits\?\?broker\?\.quantity[\s\S]*?quantityLots\?\?broker\?\.quantity/, 'canonical broker quantity projection fields shown in historical review');
requireMatch(ctraderHistoryUiSource, /entryPrice\?\?broker\?\.entry[\s\S]*?exitPrice\?\?broker\?\.exit/, 'canonical broker price projection fields shown in historical review');
requireMatch(ctraderHistoryUiSource, /function ctraderDifferenceSummaries[\s\S]*?Object\.entries\(value\)[\s\S]*?manual[\s\S]*?broker/, 'object-shaped reconciliation differences shown safely');

try {
  const elements = new Map([
    ['ctrader-mcp-configuration', { value: '{"mcpServers":{"ctrader":{"transport":"fixture"}}}' }],
    ['ctrader-mcp-account-id', { value: '42' }],
    ['ctrader-mcp-environment', { value: 'live' }],
    ['ctrader-mcp-label', { value: 'The5ers' }],
    ['ctrader-mcp-map-account', { value: 'acct_1', innerHTML: '' }],
    ['ctrader-mcp-risk-ack', { checked: false }],
    ['ctrader-mcp-flat-ack', { checked: true }],
    ['ctrader-vps-mcp-error', { textContent: '', style: {} }],
    ['ctrader-vps-mcp-submit', { disabled: false, innerHTML: '' }],
    ['ctrader-vps-mcp', { style: { display: 'flex' } }],
  ]);
  const mcpCalls = [];
  const { exports: mcpForm } = evaluateSecurityFixture(
    ctraderMcpSubmitSource,
    {
      document: { getElementById: id => elements.get(id) || null },
      window: {
        _dataMode: 'vps',
        _vpsData: { ctrader: { connectMcp: async body => {
          mcpCalls.push({ ...body });
          return { connection: { id: 'mcp-1', mode: 'mcp_read' } };
        } } },
      },
      vpsCtraderState: { mcpEnabled: true },
      ctraderAccountOptions: () => '<option value="">Not mapped</option>',
      showToast() {},
      setTimeout() {},
      loadVpsCtraderConnections: async () => {},
    },
    '{submitVpsCtraderMcp}',
  );
  await mcpForm.submitVpsCtraderMcp();
  if (mcpCalls.length !== 0 || !/acknowledge/i.test(elements.get('ctrader-vps-mcp-error').textContent)) {
    failures.push('Remote MCP form submitted without the explicit trading-capability acknowledgement');
  }
  elements.get('ctrader-mcp-risk-ack').checked = true;
  elements.get('ctrader-mcp-configuration').value = '{"mcpServers":{"ctrader":{"transport":"fixture"}}}';
  await mcpForm.submitVpsCtraderMcp();
  const request = mcpCalls[0];
  if (mcpCalls.length !== 1 || request?.accountId !== '42' || request?.environment !== 'live' || request?.mappedLegacyAccountId !== 'acct_1' || request?.label !== 'The5ers' || request?.acknowledgeTradingCredentialRisk !== true || request?.acknowledgeNoOpenPositionsAtConnect !== true || !request?.configuration) {
    failures.push('Remote MCP form did not submit the exact acknowledged connection contract');
  }
  if (elements.get('ctrader-mcp-configuration').value !== '' || elements.get('ctrader-vps-mcp').style.display !== 'none') {
    failures.push('Remote MCP form retained the copied configuration after connecting');
  }
} catch (error) {
  failures.push(`Remote MCP form fixture failed: ${error.message}`);
}

try {
  const ctraderPanelSource = sourceBetween('function renderVpsCtraderPanel', 'async function loadVpsCtraderConnections');
  const panel = makeFakeElement('div');
  const context = {
    document: { getElementById: id => id === 'ctrader-vps-panel' ? panel : null },
  };
  vm.runInNewContext(`
    const vpsCtraderState={oauthEnabled:false,mcpEnabled:true,pending:null,connections:[],statuses:new Map(),message:null,messageType:'success'};
    const escapeCtraderText=value=>String(value??'');
    const ctraderConnectionCard=()=>'';
    ${ctraderPanelSource}
    renderVpsCtraderPanel();
  `, context, { timeout: 500 });
  if (!/Paste Remote MCP configuration/.test(panel.innerHTML) || /awaiting one-time activation|aria-disabled="true"/.test(panel.innerHTML)) {
    failures.push('MCP-only cTrader capability did not render an active direct-connection control');
  }
} catch (error) {
  failures.push(`cTrader MCP-only panel fixture failed: ${error.message}`);
}

try {
  const ctraderCardSource = sourceBetween('function ctraderConnectionCard', 'function renderVpsCtraderPanel');
  const context = {
    S: { accounts: [], brokerAccountMap: {} },
    vpsCtraderState: { mcpEnabled: true, oauthEnabled: false },
    escapeCtraderText: value => String(value ?? ''),
    formatCtraderWhen: () => 'now',
    ctraderAccountCashFlowLedger: () => '',
    ctraderCashFlowScaleCoverage: (connection, status) => {
      const pendingRetries = Math.max(0, Number(status?.accountCashFlowPendingScaleRetries || status?.latestSyncRun?.counters?.pendingCashFlowMoneyRetries || 0));
      return { complete: status?.accountCashFlowMonetaryScaleComplete === true && pendingRetries === 0, scaledRows: status?.accountCashFlowScaledRows ?? 0, unscaledRows: status?.accountCashFlowUnscaledRows ?? 0, pendingRetries };
    },
  };
  const rendered = vm.runInNewContext(`
    ${ctraderCardSource}
    ctraderConnectionCard(
      {id:'mcp-1',connected:true,authMode:'remote_mcp',environment:'live',ctidTraderAccountId:'42'},
      {accountCashFlowMonetaryScaleComplete:true,accountCashFlowScaledRows:0,accountCashFlowUnscaledRows:0,accountCashFlowPendingScaleRetries:0,latestSyncRun:{status:'succeeded',counters:{inserted:0,updated:0,positionsAwaitingReview:2}}}
    );
  `, context, { timeout: 500 });
  if (!/Review needed/.test(rendered) || !/2 awaiting review/.test(rendered) || !/safely retained as broker executions/.test(rendered) || !/excluded from the journal and analytics/.test(rendered)) {
    failures.push('cTrader execution quarantine was not surfaced as an amber review state with a safe explanation');
  }
  const recoveryRendered = vm.runInNewContext(`
    ${ctraderCardSource}
    ctraderConnectionCard(
      {id:'oauth-1',connected:true,authMode:'oauth',environment:'live',ctidTraderAccountId:'43'},
      {accountCashFlowMonetaryScaleComplete:true,accountCashFlowScaledRows:0,accountCashFlowUnscaledRows:0,accountCashFlowPendingScaleRetries:0,latestSyncRun:{status:'succeeded',counters:{inserted:0,updated:0,pendingExactMoneyRetries:3}}}
    );
  `, context, { timeout: 500 });
  if (!/P&amp;L recovery pending|P&L recovery pending/.test(recoveryRendered) || !/3 exact P&amp;L retries|3 exact P&L retries/.test(recoveryRendered) || !/automatic retries are active/.test(recoveryRendered) || !/No manual entry is needed/.test(recoveryRendered)) {
    failures.push('Pending exact-money recovery did not render as an amber self-healing state with its retry count');
  }
  const adjustmentRecoveryRendered = vm.runInNewContext(`
    ${ctraderCardSource}
    ctraderConnectionCard(
      {id:'oauth-2',connected:true,authMode:'oauth',environment:'live',ctidTraderAccountId:'44'},
      {accountCashFlowMonetaryScaleComplete:true,accountCashFlowTotalRows:2,accountCashFlowScaledRows:2,accountCashFlowUnscaledRows:0,accountCashFlowPendingScaleRetries:1,latestSyncRun:{status:'succeeded',counters:{inserted:0,updated:0,pendingCashFlowMoneyRetries:1}}}
    );
  `, context, { timeout: 500 });
  if (!/Adjustment recovery pending/.test(adjustmentRecoveryRendered) || !/1 adjustment-scale retry/.test(adjustmentRecoveryRendered) || !/subtotals and Excel monetary reconciliation are withheld/.test(adjustmentRecoveryRendered) || !/No manual entry is needed/.test(adjustmentRecoveryRendered)) failures.push('Pending cash-flow scale recovery did not render as an amber self-healing state with its retry count and withheld-subtotal boundary');
} catch (error) {
  failures.push(`cTrader execution-quarantine card fixture failed: ${error.message}`);
}

try {
  const boundarySource = sourceBetween('function ctraderHistoryBoundaryParts', 'function ctraderHistoryConnection');
  const { exports: boundaryFixture } = evaluateSecurityFixture(
    boundarySource,
    { document: { getElementById: () => null } },
    '{resolveCtraderHistoryBoundary}',
  );
  const indiaBoundary = boundaryFixture.resolveCtraderHistoryBoundary('2026-08-11T00:00', 'Asia/Kolkata');
  if (indiaBoundary.boundaryAt !== '2026-08-10T18:30:00.000Z' || indiaBoundary.offsetLabel !== 'UTC+05:30') {
    failures.push('Historical boundary did not resolve the requested India local instant exactly');
  }
  for (const [local, label] of [['2026-03-08T02:30', 'nonexistent'], ['2026-11-01T01:30', 'ambiguous']]) {
    let rejected = false;
    try { boundaryFixture.resolveCtraderHistoryBoundary(local, 'America/New_York'); }
    catch (error) { rejected = label === 'nonexistent' ? /does not exist/.test(error.message) : /occurs twice/.test(error.message); }
    if (!rejected) failures.push(`Historical boundary accepted a ${label} DST wall time`);
  }
} catch (error) {
  failures.push(`cTrader historical-boundary fixture failed: ${error.message}`);
}

try {
  const candidateSource = sourceBetween('function ctraderCandidateClass', 'function renderCtraderHistoricalReview');
  const candidateDocument = makeFakeDocument();
  const candidateConfirmations = [];
  const { context, exports: candidateFixture } = evaluateSecurityFixture(
    candidateSource,
    {
      document: candidateDocument,
      confirmCtraderCandidateResolution: (candidate, action) => candidateConfirmations.push({ candidate, action }),
    },
    '{renderCtraderCandidate,ctraderCandidateAllowedActions}',
  );
  const baseCandidate = {
    id: maliciousIdentifier,
    version: 3,
    status: 'pending',
    reasons: [maliciousMarkup],
    differences: {
      entryPrice: { manual: '1.24', broker: maliciousMarkup },
      quantityLots: { existing: '0.10', incoming: '0.12' },
    },
    brokerTrade: {
      symbol: maliciousMarkup,
      positionId: maliciousIdentifier,
      entryPrice: '1.25',
      exitPrice: '1.30',
      quantityLots: '0.12',
    },
    manualTrade: {
      id: maliciousIdentifier,
      hasStrategy: true,
      hasEmotion: true,
      hasNotes: true,
      hasPsychology: true,
      customFieldCount: 3,
      screenshotCount: 2,
    },
  };
  const deletedCard = candidateFixture.renderCtraderCandidate({
    ...baseCandidate,
    classification: 'deleted_manual',
    manualTrade: { ...baseCandidate.manualTrade, deletedAt: '2026-08-11T01:00:00Z' },
    // Even an inconsistent or stale server payload cannot expose link/publish
    // for a protected deleted-manual classification.
    allowedActions: ['link_manual', 'publish_separate', 'suppress_deleted'],
  });
  const ambiguousCard = candidateFixture.renderCtraderCandidate({
    ...baseCandidate,
    classification: 'ambiguous',
    allowedActions: ['link_manual', 'publish_separate', 'suppress_deleted'],
  });
  const failClosedCard = candidateFixture.renderCtraderCandidate({
    ...baseCandidate,
    classification: 'high_confidence',
  });
  const executionOnlyCard = candidateFixture.renderCtraderCandidate({
    ...baseCandidate,
    classification: 'execution_only',
    manualTrade: null,
    // Only reject is valid for an incomplete execution, even if a stale or
    // malicious payload advertises publishing and suppression too.
    allowedActions: ['publish_separate', 'suppress_deleted', 'reject'],
  });
  const unmatchedCard = candidateFixture.renderCtraderCandidate({
    ...baseCandidate,
    classification: 'unmatched',
    manualTrade: null,
    // Exclusion appears only because the server explicitly authorized it.
    allowedActions: ['link_manual', 'suppress_deleted', 'reject'],
  });
  const excludedCard = candidateFixture.renderCtraderCandidate({
    ...baseCandidate,
    classification: 'execution_only',
    status: 'rejected',
    resolutionAction: 'reject',
    manualTrade: null,
    allowedActions: ['reject'],
  });
  const baseUnitCard = candidateFixture.renderCtraderCandidate({
    ...baseCandidate,
    classification: 'unmatched',
    manualTrade: null,
    brokerTrade: {
      ...baseCandidate.brokerTrade,
      quantity: '2', quantityUnit: 'base_units', quantityLots: null, quantityBaseUnits: '2',
    },
    allowedActions: ['publish_separate', 'reject'],
  });
  const collect = (element, predicate, output = []) => {
    if (predicate(element)) output.push(element);
    for (const child of element?.children || []) collect(child, predicate, output);
    return output;
  };
  const buttonLabels = card => collect(card, element => element?.tagName === 'BUTTON').map(button => button.textContent);
  const deletedButtons = buttonLabels(deletedCard);
  const ambiguousButtons = buttonLabels(ambiguousCard);
  const failClosedButtons = buttonLabels(failClosedCard);
  const executionOnlyButtons = buttonLabels(executionOnlyCard);
  const unmatchedButtons = buttonLabels(unmatchedCard);
  const excludedButtons = buttonLabels(excludedCard);
  const baseUnitText=collect(baseUnitCard,element=>typeof element?.textContent==='string').map(element=>element.textContent).join('\n');
  if (deletedButtons.join('|') !== 'Suppress because manually deleted|Leave pending') {
    failures.push('Deleted-manual historical candidate exposed an unsafe action');
  }
  if (ambiguousButtons.join('|') !== 'Keep separate / publish broker|Leave pending') {
    failures.push('Ambiguous historical candidate exposed link or suppression');
  }
  if (failClosedButtons.join('|') !== 'Leave pending') {
    failures.push('Historical candidate actions did not fail closed without server allowedActions');
  }
  if (executionOnlyButtons.join('|') !== 'Exclude from this import|Leave pending') {
    failures.push('Execution-only historical candidate did not expose only its server-authorized exclusion decision');
  }
  if (unmatchedButtons.join('|') !== 'Exclude from this import|Leave pending') {
    failures.push('Unmatched historical candidate did not expose only its server-authorized exclusion decision');
  }
  if (excludedButtons.length !== 0 || !collect(excludedCard, element => /Excluded from this import\. No journal trade was changed\./.test(element?.textContent || '')).length) {
    failures.push('Completed historical exclusion still exposed actions or omitted its non-destructive saved state');
  }
  if (!baseUnitText.includes('Size (base units)') || !baseUnitText.includes('2') || baseUnitText.includes('Size (lots)')) {
    failures.push('Historical cTrader review mislabeled a base-unit quantity');
  }
  for (const card of [executionOnlyCard, unmatchedCard]) {
    const excludeButton = collect(card, element => element?.tagName === 'BUTTON').find(button => button.textContent === 'Exclude from this import');
    excludeButton?.listeners.get('click')?.();
  }
  if (candidateConfirmations.length !== 2 || candidateConfirmations.some(call => call.action !== 'reject')) {
    failures.push('Server-authorized exclusion buttons did not request an explicit reject confirmation');
  }
  if (candidateDocument.created.some(element => element._innerHtmlWrites > 0) || context.__edgebookXss) {
    failures.push('Historical candidate renderer used executable HTML for untrusted broker/manual values');
  }
  const allText = candidateDocument.created.map(element => element.textContent).join('\n');
  if (!allText.includes(maliciousMarkup)) {
    failures.push('Historical candidate fixture did not exercise malicious broker/manual text');
  }
  for (const expected of ['1.25', '1.30', '0.12', 'entryPrice: manual 1.24, broker', '3 saved and preserved', 'Saved and preserved']) {
    if (!allText.includes(expected)) failures.push(`Historical candidate omitted canonical review value: ${expected}`);
  }
} catch (error) {
  failures.push(`cTrader historical-candidate security fixture failed: ${error.message}`);
}

try {
  const liveReviewSource = sourceBetween('function liveCtraderCandidateClass', 'async function loadVpsCtraderConnections');
  const liveDocument = makeFakeDocument();
  const liveState = {
    reviews: new Map(), errors: new Map(), loading: new Set(), resolving: new Set(),
    resolutionKeys: new Map(), manualSelections: new Map(),
  };
  const { context, exports: liveReview } = evaluateSecurityFixture(
    liveReviewSource,
    {
      document: liveDocument,
      vpsCtraderState: { live: liveState, connections: [] },
      ctraderDifferenceSummaries: () => [],
      showToast() {}, showConfirm() {},
      window: {}, DataStore: {}, crypto,
    },
    '{renderLiveCtraderCandidate,liveCtraderAllowedActions}',
  );
  const liveCandidateBase = {
    id: '00000000-0000-4000-8000-000000000079',
    version: 2,
    status: 'pending',
    reasons: [maliciousMarkup],
    differences: {},
    brokerTrade: { symbol: maliciousMarkup, positionId: maliciousIdentifier, entryPrice: '1.25', pnl: '5.50' },
    manualTrade: null,
    manualChoices: [
      { id: '00000000-0000-4000-8000-000000000080', version: 3, symbol: 'XAUUSD', direction: 'Long', date: '2026-08-12', hasStrategy: true, hasPsychology: true, hasNotes: true, hasCustomFields: true, screenshotCount: 2 },
      { id: '00000000-0000-4000-8000-000000000081', version: 1, symbol: 'XAUUSD', direction: 'Long', date: '2026-08-12' },
    ],
  };
  const collectLive = (element, predicate, output = []) => {
    if (predicate(element)) output.push(element);
    for (const child of element?.children || []) collectLive(child, predicate, output);
    return output;
  };
  const liveButtons = card => collectLive(card, element => element?.tagName === 'BUTTON').map(button => button.textContent);
  const ambiguous = { ...liveCandidateBase, classification: 'ambiguous', allowedActions: ['link_manual', 'publish_separate', 'suppress_deleted', 'reject'] };
  const ambiguousCard = liveReview.renderLiveCtraderCandidate('connection-1', ambiguous);
  if (liveButtons(ambiguousCard).join('|') !== 'Keep both|Dismiss match') failures.push('Ambiguous live match linked without an explicit manual selection or exposed suppression');
  liveState.manualSelections.set(`connection-1:${ambiguous.id}`, ambiguous.manualChoices[0].id);
  if (liveReview.liveCtraderAllowedActions('connection-1', ambiguous).join('|') !== 'link_manual|publish_separate|reject') failures.push('Ambiguous live match did not unlock only server-authorized actions after an advertised selection');
  const unknownCard = liveReview.renderLiveCtraderCandidate('connection-1', { ...liveCandidateBase, classification: 'future_class', allowedActions: ['link_manual', 'publish_separate', 'suppress_deleted', 'reject'] });
  const unversionedCard = liveReview.renderLiveCtraderCandidate('connection-1', { ...liveCandidateBase, version: null, classification: 'high_confidence', manualTrade: liveCandidateBase.manualChoices[0], allowedActions: ['link_manual'] });
  const deletedCard = liveReview.renderLiveCtraderCandidate('connection-1', { ...liveCandidateBase, classification: 'deleted_manual', manualTrade: { ...liveCandidateBase.manualChoices[0], deleted: true }, allowedActions: ['link_manual', 'publish_separate', 'suppress_deleted', 'reject'] });
  const pairedCard = liveReview.renderLiveCtraderCandidate('connection-1', { ...liveCandidateBase, classification: 'existing_pair', manualTrade: liveCandidateBase.manualChoices[0], allowedActions: ['link_manual', 'publish_separate', 'suppress_deleted', 'reject'] });
  const baseUnitCard = liveReview.renderLiveCtraderCandidate('connection-1', {
    ...liveCandidateBase,
    classification: 'ambiguous',
    allowedActions: ['publish_separate', 'reject'],
    brokerTrade: {
      ...liveCandidateBase.brokerTrade,
      quantity: '2', quantityUnit: 'base_units', quantityLots: null, quantityBaseUnits: '2',
    },
  });
  if (liveButtons(unknownCard).length || liveButtons(unversionedCard).length) failures.push('Unknown or unversioned live cTrader candidate exposed a mutation control');
  if (liveButtons(deletedCard).join('|') !== 'Keep both|Suppress broker copy') failures.push('Deleted-manual live match exposed an unsafe action');
  if (liveButtons(pairedCard).join('|') !== 'Merge + preserve manual journal|Dismiss match') failures.push('Broker-first existing pair exposed keep-both or suppression after broker publication');
  const baseUnitText=collectLive(baseUnitCard,element=>typeof element?.textContent==='string').map(element=>element.textContent).join('\n');
  if (!baseUnitText.includes('Size (base units)') || !baseUnitText.includes('2') || baseUnitText.includes('Size (lots)')) failures.push('Live cTrader review mislabeled a base-unit quantity');
  if (liveDocument.created.some(element => element._innerHtmlWrites > 0) || context.__edgebookXss) failures.push('Live cTrader review rendered untrusted values through executable HTML');
  const liveText = liveDocument.created.map(element => element.textContent).join('\n');
  for (const expected of [maliciousMarkup, 'Verified cTrader facts', 'Manual journal details preserved', 'Saved and preserved', '2 preserved']) {
    if (!liveText.includes(expected)) failures.push(`Live cTrader review omitted safe comparison value: ${expected}`);
  }
} catch (error) {
  failures.push(`Live cTrader reconciliation security fixture failed: ${error.message}`);
}

try {
  const reviewSource = sourceBetween('const CTRADER_OWNED_FORM_IDS', 'function openTradeModal');
  const reviewStableJson = value => {
    if (Array.isArray(value)) return `[${value.map(reviewStableJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${reviewStableJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
  };
  const reviewElements = new Map([
    ['t-date-label', { textContent: '' }],
    ['t-date-help', { textContent: '' }],
    ['broker-owned-note', { classList: { toggle() {} } }],
    ['broker-pnl-breakdown', { textContent: '', classList: { toggle() {} } }],
    ['broker-calculated-gross', { textContent: '', classList: { toggle() {} } }],
    ['t-size-label', { innerHTML: '' }],
    ...['t-asset','t-sym-select','t-sym','t-dir','t-instrument','t-position','t-strike','t-account','t-entry','t-exit','t-size','t-date','t-time']
      .map(id => [id, { disabled: false }]),
  ]);
  const { exports: review } = evaluateSecurityFixture(
    reviewSource,
    {
      stableJson: reviewStableJson,
      normalizeFxCurrency: value => String(value||'').replace(/[^A-Za-z]/g,'').slice(0,3).toUpperCase()||null,
      acctCur: () => '$',
      vpsCtraderState: { connections: [] },
      mappedAccountForCTraderConnection: () => '',
      tradeIsOpen: trade => trade?.isOpen === true || (trade?.isOpen == null && trade?.exit == null && trade?.pnl == null),
      tradeHasPnl: trade => trade?.pnl !== null && trade?.pnl !== undefined && Number.isFinite(Number(trade.pnl)),
      tradeRealizedEvents: trade => trade?.pnl !== null && trade?.pnl !== undefined && Number.isFinite(Number(trade.pnl)) ? [{ executionId: `trade:${trade.id || ''}`, date: trade.date, pnl: Number(trade.pnl) }] : [],
      isRealIsoDate: value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)),
      document: {
        getElementById: id => reviewElements.get(id) || null,
        querySelector: selector => selector === 'label[for-size]' ? reviewElements.get('t-size-label') : null,
      },
    },
    '{cTraderReviewRevision,cTraderTradeNeedsReview,cTraderProviderTradeDate,cTraderCalculatedGross,calculatedGrossText,tradeFinancialPresentation,calculatedGrossLedgerEvents,financialPresentationLedgerForTrades,cTraderExactPnlBreakdown,cTraderExactPnlBreakdownText,setTradeBrokerOwnedMode}',
  );
  const imported = { source: 'ctrader', isOpen: true, date: '2026-08-11', entryAt: '2026-08-11T01:00:00.000Z', brokerData: { providerTradeDate: '2026-08-11', realizedEvents: [] }, custom: {} };
  if (!review.cTraderTradeNeedsReview(imported)) failures.push('A newly imported cTrader trade was not marked for review');
  const reviewed = { ...imported, custom: { edgebookReview: { providerRevision: review.cTraderReviewRevision(imported) } } };
  if (review.cTraderTradeNeedsReview(reviewed)) failures.push('An unchanged reviewed cTrader trade remained marked for review');
  const closed = { ...reviewed, isOpen: false, exitAt: '2026-08-11T02:00:00.000Z', brokerData: { realizedEvents: [{ executionId: 'close-1', executedAt: '2026-08-11T02:00:00.000Z', pnl: '12.5' }] } };
  if (!review.cTraderTradeNeedsReview(closed)) failures.push('A newly closed cTrader trade did not return to needs-review state');
  review.setTradeBrokerOwnedMode(imported);
  if (reviewElements.get('t-date').disabled) failures.push('cTrader journal date was locked with provider-owned execution facts');
  if (!reviewElements.get('t-time').disabled || !reviewElements.get('t-entry').disabled || !reviewElements.get('t-sym').disabled) failures.push('cTrader provider execution facts were left editable');
  if (reviewElements.get('t-date-label').textContent !== 'Journal date' || !/sync will not overwrite/i.test(reviewElements.get('t-date-help').textContent)) failures.push('cTrader journal date ownership was not explained');
  const baseUnitTrade = {
    ...imported,
    brokerData: {
      ...imported.brokerData,
      quantityProjection: { version: 1, value: '2', unit: 'base_units', volumeScale: 'unit_cents', source: 'provider_filled_volume', baseAssetName: 'XAU' },
    },
  };
  review.setTradeBrokerOwnedMode(baseUnitTrade);
  if (!/XAU base units from cTrader; lot conversion unavailable/.test(reviewElements.get('t-size-label').innerHTML)) failures.push('Unknown-contract cTrader quantity was not identified as base units in the edit form');
  if (review.cTraderProviderTradeDate({ date: '2026-08-12', brokerData: { providerTradeDate: '2026-08-11' } }) !== '2026-08-11') failures.push('cTrader provider date did not remain distinct from edited journal date');
  const calculated = { id: 'calc-1', source: 'ctrader', pnl: null, isOpen: false, exitAt: '2026-08-12T23:30:00.000Z', date: '2026-08-12', brokerData: {
    calculatedGrossPnl: '20.66', calculatedGrossCurrency: 'USD',
    calculatedGrossMethod: 'fill_price_base_units_identity_conversion_v1',
    calculatedGrossEvents: [{ executionId: 'close-1', executedAt: '2026-08-12T23:30:00.000Z', grossPnl: '20.66' }],
    providerTradeDateTimeZone: 'Asia/Kolkata',
    calculatedGrossProvenance: { version: 1, feesIncluded: false, accountMoneyDigits: 2, quoteCurrency: 'USD', accountCurrency: 'USD', conversionRate: '1' },
  } };
  if (review.calculatedGrossText(review.cTraderCalculatedGross(calculated)) !== '+$20.66') failures.push('Safe cTrader calculated-gross estimate was not exposed separately');
  const financialPresentation=review.tradeFinancialPresentation(calculated);
  if (financialPresentation?.kind !== 'estimated_gross' || financialPresentation.amount !== 20.66 || !financialPresentation.isEstimate) failures.push('Shared financial presentation rejected a valid calculated-gross estimate');
  const calculatedLedger=review.financialPresentationLedgerForTrades([calculated]);
  if (calculatedLedger.length !== 1 || calculatedLedger[0].ledgerDate !== '2026-08-13' || calculatedLedger[0].ledgerPnl !== 20.66 || !calculatedLedger[0].financialIsEstimate) failures.push('Calculated-gross close event was not assigned to the provider-local calendar day');
  const malformedLedger=review.calculatedGrossLedgerEvents({ ...calculated, brokerData: { ...calculated.brokerData, calculatedGrossEvents: [{ executionId: 'close-1', executedAt: calculated.exitAt, grossPnl: '99.99' }] } });
  if (malformedLedger.length) failures.push('Calculated-gross event ledger accepted a total that disagrees with provenance');
  const calculatedAtDigits = (calculatedGrossPnl, accountMoneyDigits) => ({
    ...calculated,
    brokerData: {
      ...calculated.brokerData,
      calculatedGrossPnl,
      calculatedGrossProvenance: { ...calculated.brokerData.calculatedGrossProvenance, accountMoneyDigits },
    },
  });
  if (review.calculatedGrossText(review.cTraderCalculatedGross(calculatedAtDigits('21', 0))) !== '+$21') failures.push('Zero-digit calculated gross formatting did not honor provider precision');
  if (review.calculatedGrossText(review.cTraderCalculatedGross(calculatedAtDigits('20.6', 3))) !== '+$20.600') failures.push('Three-digit calculated gross formatting did not honor provider precision');
  if (review.calculatedGrossText(review.cTraderCalculatedGross(calculatedAtDigits('123456789012345678.123456789012345678', 18))) !== '+$123456789012345678.123456789012345678') failures.push('High-precision calculated gross formatting lost decimal precision');
  if (review.cTraderCalculatedGross({ ...calculated, pnl: 19.5 }) !== null) failures.push('Provider exact net P&L did not supersede calculated gross in the UI');
  review.setTradeBrokerOwnedMode(calculated);
  if (!/Calculated gross: \+\$20\.66 USD[\s\S]*outside Net P&L and analytics/.test(reviewElements.get('broker-calculated-gross').textContent)) failures.push('cTrader calculated-gross detail did not disclose fee and analytics exclusions');
  const exact = { source: 'ctrader', pnl: '114.5', brokerData: {
    pnlMethod: 'provider_close_detail_money_digits', pnlAuthority: 'provider', accountCurrency: 'USDT',
    grossProfit: '120', swap: '-1', commission: '-4', pnlConversionFee: '0.5',
    pnlComponentsCoverage: {
      version: 1, source: 'ProtoOAClosePositionDetail', tradeLevelExact: true,
      grossProfit: true, brokerCommission: true, swap: true, pnlConversionFee: true,
      otherAccountCashFlowsIncluded: false, otherAccountCashFlowsAttribution: 'not_provided_by_position',
    },
  } };
  const exactBreakdown = review.cTraderExactPnlBreakdown(exact);
  if (!exactBreakdown || exactBreakdown.currency !== 'USDT') failures.push('Provider-exact trade P&L breakdown rejected an official account asset currency');
  if (!/Broker trade net[\s\S]*gross[\s\S]*swap[\s\S]*commission[\s\S]*conversion fee[\s\S]*not assumed to be zero/.test(review.cTraderExactPnlBreakdownText(exactBreakdown))) failures.push('Provider-exact trade P&L breakdown omitted components or the account-charge boundary');
  if (review.cTraderExactPnlBreakdown({ ...exact, pnl: '114.6' }) !== null) failures.push('Inconsistent provider component arithmetic was presented as an exact P&L breakdown');
  review.setTradeBrokerOwnedMode(exact);
  if (!/Broker trade net[\s\S]*Separate account-level cash flows/.test(reviewElements.get('broker-pnl-breakdown').textContent)) failures.push('Trade modal did not expose exact broker P&L components separately from account cash flows');
} catch (error) {
  failures.push(`cTrader review lifecycle fixture failed: ${error.message}`);
}

try {
  const ledgerSource = sourceBetween('function ctraderCashFlowLabel', 'function ctraderConnectionCard');
  const { context, exports: ledger } = evaluateSecurityFixture(
    ledgerSource,
    {
      escapeCtraderText: value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'),
      formatCtraderWhen: value => String(value),
    },
    '{ctraderAccountCashFlowLedger}',
  );
  const ledgerHtml = ledger.ctraderAccountCashFlowLedger({ accountCashFlows: [{
    operationName: maliciousMarkup,
    amount: '-1.25', currency: maliciousMarkup,
    occurredAt: '2026-08-13T10:00:00.000Z', balanceHistoryId: maliciousIdentifier,
  }] }, false);
  if (/<(?:img|svg|script)\b/i.test(ledgerHtml) || context.__edgebookXss) failures.push('Account cash-flow ledger rendered untrusted provider fields as executable HTML');
  if (!/does not assign them to a trade[\s\S]*not assume an absent charge is zero/.test(ledgerHtml)) failures.push('Account cash-flow ledger omitted its non-attribution and unknown-charge boundary');
  if (!/recent-row preview only/.test(ledgerHtml) || !/incomplete or has not yet been verified/.test(ledgerHtml)) failures.push('Account cash-flow card did not identify its recent-row and provider-coverage limits');
  const completeLedgerHtml = ledger.ctraderAccountCashFlowLedger({ accountCashFlowHistoryComplete: true, accountCashFlowSyncedThroughTimestamp: 1786943100000, latestSyncRun: { status: 'failed' }, accountCashFlows: [] }, false);
  if (!/complete through 1786943100000/.test(completeLedgerHtml) || !/latest sync failed[\s\S]*newer coverage is not guaranteed/.test(completeLedgerHtml)) failures.push('Account cash-flow history did not expose its exact through-timestamp and later-sync caveat');
} catch (error) {
  failures.push(`cTrader account cash-flow ledger fixture failed: ${error.message}`);
}

try {
  const cashFlowCacheSource = sourceBetween('function ctraderCashFlowHasExactMoney', 'function ctraderCashFlowAmount');
  const connection = { id: 'connection-1', label: '25K Master', mappedAccountId: 'account-1', accountCashFlowHistoryComplete: true, accountCashFlowSyncedThroughTimestamp: 1786943100000 };
  const status = { accountCashFlowHistoryComplete: true, accountCashFlowSyncedThroughTimestamp: 1786943100000, accountCashFlowMonetaryScaleComplete: true, accountCashFlowTotalRows: 60, accountCashFlowScaledRows: 60, accountCashFlowUnscaledRows: 0, accountCashFlowPendingScaleRetries: 0, latestSyncRun: { id: 'sync-1', status: 'succeeded', finishedAt: '2026-08-17T05:05:00.000Z', counters: { pendingCashFlowMoneyRetries: 0 } } };
  const vpsState = { connections: [connection], statuses: new Map([['connection-1', status]]), cashFlows: { entries: new Map(), loading: new Map(), generations: new Map() } };
  let pageCalls = 0;
  const rows = Array.from({ length: 60 }, (_, index) => ({ balanceHistoryId: String(1000 + index), amount: index % 2 ? '-0.01' : '0.02', currency: 'USD', moneyDigits: 2, moneyDigitsSource: 'cash_flow', scalingStatus: 'exact', category: 'trading_related_adjustment' }));
  const windowStub = { _vpsData: { ctrader: { accountCashFlows: async (id, options) => {
    pageCalls += 1;
    if (id !== 'connection-1') throw new Error('wrong connection');
    return options.cursor === null ? { accountCashFlows: rows.slice(0, 50), nextCursor: 'page-2' } : { accountCashFlows: rows.slice(50), nextCursor: null };
  } } } };
  const { exports: cache } = evaluateSecurityFixture(
    cashFlowCacheSource,
    {
      window: windowStub, vpsCtraderState: vpsState, S: { brokerAccountMap: {} },
      mappedAccountForCTraderConnection: item => String(item?.mappedAccountId || ''),
      ctraderCashFlowCategory: flow => flow.category || 'unknown',
      document: { getElementById: () => null }, updateMetrics() {},
    },
    '{ctraderCashFlowHasExactMoney,fetchCompleteVpsCtraderCashFlows,refreshVpsCtraderCashFlowCache,invalidateVpsCtraderCashFlowCache,loadedAccountCashFlows}',
  );
  const fetched = await cache.fetchCompleteVpsCtraderCashFlows(connection, status);
  if (!fetched.complete || !fetched.dbComplete || fetched.rows.length !== 60 || pageCalls !== 2) failures.push('Dashboard cash-flow cache did not paginate beyond the status LIMIT-50 preview');
  vpsState.cashFlows.entries.set('connection-1', { ...fetched, statusKey: 'fixture' });
  const loaded = cache.loadedAccountCashFlows('account-1');
  if (!loaded.complete || loaded.rows.length !== 60) failures.push('Dashboard adjustment subtotal did not require/use the fully paginated provider-history ledger');
  cache.invalidateVpsCtraderCashFlowCache('connection-1');
  if (vpsState.cashFlows.entries.has('connection-1') || vpsState.cashFlows.generations.get('connection-1') !== 1) failures.push('cTrader sync invalidation did not discard the dashboard cash-flow cache');

  const partial = await cache.fetchCompleteVpsCtraderCashFlows(connection, { ...status, accountCashFlowHistoryComplete: false });
  if (partial.complete || !partial.dbComplete || !/incomplete/.test(partial.error)) failures.push('Fully paginated stored rows were mislabeled complete without provider-history coverage');

  const scalePartial = await cache.fetchCompleteVpsCtraderCashFlows(connection, { ...status, accountCashFlowMonetaryScaleComplete: false, accountCashFlowScaledRows: 59, accountCashFlowUnscaledRows: 1, accountCashFlowPendingScaleRetries: 1 });
  if (scalePartial.complete || !scalePartial.dbComplete || !/money scaling is incomplete/.test(scalePartial.error)) failures.push('Fully paginated cash-flow rows were mislabeled monetarily complete without row-authoritative scale coverage');
  if (cache.ctraderCashFlowHasExactMoney({ amount: null, moneyDigits: 2, moneyDigitsSource: 'cash_flow', scalingStatus: 'exact' }) || cache.ctraderCashFlowHasExactMoney({ amount: '-1.00', moneyDigits: 2, moneyDigitsSource: 'account', scalingStatus: 'exact' }) || cache.ctraderCashFlowHasExactMoney({ amount: '0.001', moneyDigits: 2, moneyDigitsSource: 'cash_flow', scalingStatus: 'exact' })) failures.push('Null, account-inferred, or precision-inconsistent cash-flow money was accepted as exact');

  windowStub._vpsData.ctrader.accountCashFlows = async () => ({ accountCashFlows: [{ balanceHistoryId: 'raw-only', amount: null, rawAmountUnits: '-100', moneyDigits: null, moneyDigitsSource: 'unavailable', scalingStatus: 'money_digits_unavailable' }], nextCursor: null });
  const visibleUnscaled = await cache.fetchCompleteVpsCtraderCashFlows(connection, { ...status, accountCashFlowTotalRows: 1, accountCashFlowScaledRows: 1 });
  if (visibleUnscaled.complete || visibleUnscaled.visibleUnscaledRows !== 1 || visibleUnscaled.rows[0]?.rawAmountUnits !== '-100') failures.push('Visible unscaled cash-flow row did not withhold monetary completeness while retaining raw audit units');

  let repeatedCalls = 0;
  windowStub._vpsData.ctrader.accountCashFlows = async () => ({ accountCashFlows: [{ balanceHistoryId: String(++repeatedCalls) }], nextCursor: 'repeat' });
  const repeated = await cache.fetchCompleteVpsCtraderCashFlows(connection, status);
  if (repeated.complete || repeated.dbComplete || !/repeated a pagination cursor/.test(repeated.error)) failures.push('Repeated cash-flow cursor did not fail closed');

  windowStub._vpsData.ctrader.accountCashFlows = async () => { throw new Error('ledger unavailable'); };
  const failed = await cache.fetchCompleteVpsCtraderCashFlows(connection, status);
  if (failed.complete || failed.dbComplete || !/ledger unavailable/.test(failed.error)) failures.push('Cash-flow pagination error did not fail closed');
  requireMatch(app, /type\.includes\('ctrader'\)\|\|type\.includes\('sync'\)\)\{invalidateVpsCtraderCashFlowCache\(\)/, 'real-time cTrader sync invalidates full dashboard cash-flow cache');
  requireMatch(app, /invalidateVpsCtraderCashFlowCache\(id\);[\s\S]*?_vpsData\.ctrader\.sync\(id\)/, 'manual cTrader sync invalidates its full dashboard cash-flow cache');
} catch (error) {
  failures.push(`Dashboard full cash-flow cache fixture failed: ${error.message}`);
}

// Coaching reports are deterministic and private. Browser code must never
// send trade context directly to a third-party model endpoint.
rejectMatch(allBrowserSource, /https:\/\/(?:api\.)?(?:anthropic\.com|openai\.com)/i, 'direct browser model API endpoint');
requireMatch(app, /buildLocalCoachingReport/, 'local coaching report generator');
requireMatch(app, /Your trade data stays in Edgebook/, 'local coaching privacy message');
requireMatch(app, /const withBreaks=value=>escape\(value\)\.replace/, 'coaching report HTML escaping');
requireMatch(app, /const pdfEscape=value=>/, 'coaching PDF HTML escaping');
rejectMatch(app, /Get AI coaching report/i, 'misleading AI report button label');

// CSV lot conversion must share the same authoritative table as the manual
// calculator so one path cannot quietly drift from another.
requireMatch(app, /['"]FINNIFTY['"]:\s*\{\s*lotSize:\s*60\b/, 'FINNIFTY lot size 60');
requireMatch(app, /['"]BANKEX['"]:\s*\{\s*lotSize:\s*30\b/, 'BANKEX lot size 30');
requireMatch(app, /['"]NIFTYNXT50['"]:\s*\{\s*lotSize:\s*25\b/, 'NIFTYNXT50 lot size 25');
requireMatch(app, /const INDEX_SPEC_KEYS\s*=\s*Object\.keys\(INDEX_INR_SPECS\)\.sort\(\(a,b\)=>b\.length-a\.length/, 'authoritative longest-prefix index lookup');
requireMatch(app, /function csvIndexLotSize\(symbol\)\{\s*return findIndexContractSpec\(symbol\)\?\.lotSize\|\|1;/, 'CSV use of authoritative index contract lookup');
rejectMatch(app, /FINNIFTY[^\n]{0,80}lotSize\s*=\s*65\b/, 'stale FINNIFTY CSV lot size');
rejectMatch(app, /BANKEX[^\n]{0,80}lotSize\s*=\s*15\b/, 'stale BANKEX CSV lot size');

const approximatelyEqual = (actual, expected, tolerance = 1e-6) =>
  Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
const fxRateSource = sourceBetween('const FALLBACK_FX_RATES', 'const DEFAULT_SYMBOLS');
const pnlEngineSource = sourceBetween('const FUTURES_SPECS', 'function sizeLabel');
const dateValidationSource = sourceBetween('function isRealIsoDate', 'function formatDate');
const fnoMetadataSource = sourceBetween('function csvIndexLotSize', 'const BROKER_PROFILES');
const csvParserSource = sourceBetween('function parseCSV', '// Normalise various date formats');
const csvIdentitySource = sourceBetween('function csvFingerprint', '// FIFO-pair raw BUY/SELL fills');
const csvFingerprintSource = sourceBetween('function csvFingerprint', 'function csvImportNaturalKey');
const csvFifoSource = sourceBetween('function csvFifoPair', 'function csvBuildPreview');
const csvDocumentIdSource = sourceBetween('async function csvImportDocumentId', 'function csvMergeImportedTrade');
const csvExportSource = sourceBetween('function csvFormulaSafeText', 'function exportCSV');
const analyticsCalculationSource = sourceBetween('function tradeChronologyKey', 'function renderCharts');
const calendarNavigationSource = sourceBetween('let calYear', 'function buildCalAcctFilter');

let calculationFixture;
try {
  ({ exports: calculationFixture } = evaluateSecurityFixture(
    `${fxRateSource}\n${pnlEngineSource}`,
    { TODAY: '2026-08-09' },
    '{normalizeFxCurrency,fxPairCurrencies,FxRates,FUTURES_SPECS,findIndexContractSpec,calculatePnL}',
  ));
  if (calculationFixture.normalizeFxCurrency('A$') !== 'AUD' || calculationFixture.normalizeFxCurrency('¥') !== 'JPY') {
    failures.push('Exact FX display-currency aliases regressed');
  }
  if (calculationFixture.normalizeFxCurrency('$AUD') !== null || !Number.isNaN(calculationFixture.FxRates.toUSD(5, 'XYZ'))) {
    failures.push('Unsupported FX currencies silently fall through');
  }
  if (!approximatelyEqual(calculationFixture.FxRates.toUSD(149.5, 'JPY'), 1) || !approximatelyEqual(calculationFixture.FxRates.toUSD(1.53, 'A$'), 1)) {
    failures.push('JPY/AUD fallback conversion regressed');
  }
  if (calculationFixture.calculatePnL('eq', 'CL', 'Long', 70, 71, 2) !== 2 || calculationFixture.calculatePnL('eq', 'GLD', 'Long', 100, 101, 2) !== 2) {
    failures.push('Equity ticker collision still triggers a commodity multiplier');
  }
  const clPointValue = calculationFixture.FUTURES_SPECS.CL?.pointValue;
  if (calculationFixture.calculatePnL('cm', 'CL', 'Long', 70, 71, 2, null, 'Futures') !== 2 * clPointValue) {
    failures.push('Explicit commodity futures calculation regressed');
  }
  if (calculationFixture.calculatePnL('eq', 'NIFTY', 'Long', 100, 110, 2) !== 20 ||
      calculationFixture.calculatePnL('ix', 'NIFTY26MAR23000CE', 'Long', 100, 110, 2, 'Long CALL', 'Options') !== 1300) {
    failures.push('Explicit Indian F&O dispatch regressed');
  }
  const usdJpy = calculationFixture.calculatePnL('fx', 'USD/JPY', 'Long', 149, 150, 1);
  if (!approximatelyEqual(usdJpy, Number((100000 / 149.5).toFixed(2)), 0.01) || calculationFixture.calculatePnL('fx', 'EUR/ZZZ', 'Long', 1, 2, 1) !== null) {
    failures.push('FX quote-currency conversion or unsupported-quote safeguard regressed');
  }
} catch (error) {
  failures.push(`P&L calculation fixture failed: ${error.message}`);
}

try {
  const { exports: fno } = evaluateSecurityFixture(
    `${pnlEngineSource}\n${dateValidationSource}\n${sourceBetween('function normCSVDateOrNull', '// Normalise direction from various broker formats')}\n${fnoMetadataSource}`,
    {},
    '{csvIndexLotSize,csvIndianFnoMetadata}',
  );
  if (fno.csvIndexLotSize('NIFTYNXT5026MAR25000CE') !== 25 || fno.csvIndexLotSize('MIDCPNIFTY26MAR12000PE') !== 120) {
    failures.push('CSV longest-prefix lot lookup regressed');
  }
  const weekly = JSON.parse(JSON.stringify(fno.csvIndianFnoMetadata('NIFTY26031223000CE', 'Long', { exchange: 'NFO' })));
  if (weekly.instrument !== 'Options' || weekly.optionType !== 'Long CALL' || weekly.underlying !== 'NIFTY' || weekly.strike !== 23000 || weekly.expiry !== '2026-03-12' || weekly.lotSize !== 65 || weekly.asset !== 'ix') {
    failures.push('Imported weekly Indian option metadata regressed');
  }
  const monthly = JSON.parse(JSON.stringify(fno.csvIndianFnoMetadata('BANKNIFTY26MAR48000PE', 'Short', { expiry: '26/03/2026' })));
  if (monthly.optionType !== 'Short PUT' || monthly.strike !== 48000 || monthly.expiry !== '2026-03-26' || monthly.underlying !== 'BANKNIFTY') {
    failures.push('Imported monthly Indian option metadata was lost or fabricated');
  }
  const noFabricatedExpiry = fno.csvIndianFnoMetadata('NIFTY26MAR23000CE', 'Long', {});
  if (noFabricatedExpiry.expiry !== null) failures.push('Monthly F&O parser fabricated an exact expiry day');
} catch (error) {
  failures.push(`Indian F&O metadata fixture failed: ${error.message}`);
}

try {
  const { exports: fifo } = evaluateSecurityFixture(
    `${fxRateSource}\n${pnlEngineSource}\n${csvFifoSource}`,
    { TODAY: '2026-08-09' },
    '{csvFifoPair}',
  );
  const paired = JSON.parse(JSON.stringify(fifo.csvFifoPair([
    { symbol: 'ABC', asset: 'eq', direction: 'Long', entry: 100, size: 10, date: '2026-01-01', _rawTime: '09:00', _row: 0, _sourceFingerprint: 'open-a' },
    { symbol: 'ABC', asset: 'eq', direction: 'Short', entry: 110, size: 4, date: '2026-01-01', _rawTime: '10:00', _row: 1, _sourceFingerprint: 'close-a' },
    { symbol: 'ABC', asset: 'eq', direction: 'Short', entry: 90, size: 8, date: '2026-01-01', _rawTime: '11:00', _row: 2, _sourceFingerprint: 'reverse-a' },
  ])));
  const closedSlices = paired.filter(trade => !trade.isOpen);
  const residual = paired.find(trade => trade.isOpen);
  if (closedSlices.length !== 2 || closedSlices[0].size !== 4 || closedSlices[0].pnl !== 40 || closedSlices[0]._openSliceIndex !== 0 ||
      closedSlices[1].size !== 6 || closedSlices[1].pnl !== -60 || closedSlices[1]._openSliceIndex !== 1 ||
      !residual || residual.direction !== 'Short' || residual.size !== 2 || residual.entry !== 90) {
    failures.push('Quantity-aware CSV FIFO partial-fill/reversal handling regressed');
  }
} catch (error) {
  failures.push(`CSV FIFO fixture failed: ${error.message}`);
}

try {
  const stableJsonFixture = value => {
    if (Array.isArray(value)) return `[${value.map(stableJsonFixture).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJsonFixture(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  const { exports: identity } = evaluateSecurityFixture(
    `${quantityProjectionSource}\n${csvIdentitySource}\n${csvDocumentIdSource}`,
    { stableJson: stableJsonFixture, crypto: globalThis.crypto, TextEncoder, tradeIsOpen: trade => trade?.isOpen === true },
    '{csvImportNaturalKey,csvMatchesExisting,csvImportDocumentId}',
  );
  const formerOpen = { symbol: 'ABC', date: '2026-01-01', entry: 100, direction: 'Long', _openingFingerprint: 'fill-1', _openSliceIndex: 1 };
  const laterClosed = { ...formerOpen, exit: 110, size: 2 };
  const firstId = await identity.csvImportDocumentId(formerOpen, 'generic', 'acct-a');
  const closedId = await identity.csvImportDocumentId(laterClosed, 'generic', 'acct-a');
  const otherAccountId = await identity.csvImportDocumentId(formerOpen, 'generic', 'acct-b');
  if (firstId !== closedId || firstId === otherAccountId || !/^csv_[a-f0-9]{48}$/.test(firstId)) {
    failures.push('Collision-resistant CSV identity stability/scope regressed');
  }
  const naturalKey = identity.csvImportNaturalKey(formerOpen, 'generic', 'acct-a');
  if (!identity.csvMatchesExisting({ ...formerOpen, id: firstId, accountId: 'acct-a', source: 'csv', broker: 'generic', size: 2, isOpen: true, externalTradeKey: naturalKey }, { ...formerOpen, size: 2, externalTradeKey: naturalKey }, 'acct-a', 'csv', 'generic') ||
      identity.csvMatchesExisting({ ...formerOpen, accountId: 'acct-a', source: 'csv', broker: 'generic', size: 2, isOpen: true, externalTradeKey: 'csv:generic:acct-a:different:1' }, { ...formerOpen, size: 2, externalTradeKey: naturalKey }, 'acct-a', 'csv', 'generic') ||
      identity.csvMatchesExisting({ ...formerOpen, accountId: 'acct-b', source: 'csv', broker: 'generic', size: 2, isOpen: true }, { ...formerOpen, size: 2 }, 'acct-a', 'csv', 'generic')) {
    failures.push('CSV existing-open matching scope regressed');
  }
  const legacyBaseUnitTrade = {
    ...formerOpen,
    accountId: 'acct-a', source: 'ctrader', broker: 'ctrader', size: 2, isOpen: true,
    brokerData: { quantityProjection: { version: 1, value: '2', unit: 'base_units', volumeScale: 'unit_cents', source: 'provider_filled_volume', baseAssetName: 'XAU' } },
  };
  if (identity.csvMatchesExisting(legacyBaseUnitTrade, { ...formerOpen, size: 2 }, 'acct-a', 'ctrader', 'ctrader')) {
    failures.push('CSV field matching compared broker-native size with cTrader base units');
  }
} catch (error) {
  failures.push(`CSV identity fixture failed: ${error.message}`);
}

try {
  const { exports: parser } = evaluateSecurityFixture(csvParserSource, {}, '{parseCSV}');
  const { exports: csvExport } = evaluateSecurityFixture(
    `${quantityProjectionSource}\n${sizeLabelSource}\n${csvExportSource}`,
    {
      ASSET_LABELS: { eq: 'Equities' },
      tradeIsOpen: trade => trade?.isOpen === true,
      tradeHasPnl: trade => trade?.pnl !== null && trade?.pnl !== undefined && Number.isFinite(Number(trade.pnl)),
      acctName: () => '@Desk',
      acctCur: () => '$',
      normalizeFxCurrency: value => value === '$' ? 'USD' : /^[A-Z]{3}$/.test(String(value)) ? String(value) : null,
      cTraderCalculatedGross: trade => trade?.brokerData?.calculatedGrossPnl ? { valueText: String(trade.brokerData.calculatedGrossPnl), currency: 'USD' } : null,
      tradeFinancialPresentation: trade => {
        const hasPnl = trade?.pnl !== null && trade?.pnl !== undefined && trade?.pnl !== '';
        const amount = Number(trade?.pnl);
        if (hasPnl && Number.isFinite(amount)) {
          const exact = String(trade?.source || '').toLowerCase() === 'ctrader' && trade?.brokerData?.pnlAuthority === 'provider' &&
            ['provider_close_detail_money_digits', 'provider_explicit_net_cents', 'provider_mixed_exact_money'].includes(String(trade?.brokerData?.pnlMethod || ''));
          return { kind: exact ? 'broker_exact_net' : 'manual_reported', amount, isEstimate: false, isBrokerNet: exact, breakdown: null };
        }
        return trade?.brokerData?.calculatedGrossPnl ? { kind: 'estimated_gross', isEstimate: true, isBrokerNet: false } : null;
      },
      tradeFeesAndChargesPresentation: () => null,
      tradeJournalDate: trade => String(trade?.date||'').slice(0,10),
    },
    '{tradeJournalCsv}',
  );
  const parsedQuoted = JSON.parse(JSON.stringify(parser.parseCSV('a,"b,b","c""d","multi\r\nline"\r\n')));
  if (JSON.stringify(parsedQuoted) !== JSON.stringify([['a', 'b,b', 'c"d', 'multi\r\nline']])) failures.push('RFC 4180 quoted CSV parsing regressed');
  let unterminatedRejected = false;
  try { parser.parseCSV('a,"broken'); } catch { unterminatedRejected = true; }
  if (!unterminatedRejected) failures.push('CSV parser accepted an unterminated quoted field');
  const journalCsv = csvExport.tradeJournalCsv([{
    date: '2026-01-01', symbol: '=CMD()', asset: 'eq', direction: 'Long', entry: 10, exit: 8, size: 1,
    pnl: -2, strategy: '+SUM(1,1)', custom: { playbook: { setup: '=HYPERLINK("bad")', grade: 'A' } }, emotion: 'Calm', accountId: 'acct-a', notes: 'line 1, "quoted"\nline 2', isOpen: false,
  }, {
    date: '2026-01-02', symbol: 'XAUUSD', asset: 'cm', direction: 'Long', entry: 2000, exit: 2001, size: 0.02,
    entryTime:'10:00',exitTime:'10:37',entryAt:'2026-01-02T04:30:00.000Z',exitAt:'2026-01-02T05:07:20.000Z',durationSeconds:2240,
    pnl: 2, strategy: 'System', custom: { playbook: {} }, emotion: 'Calm', accountId: 'acct-a', notes: '', isOpen: false, source: 'ctrader',
    brokerData: { accountCurrency: 'EUR', pnlAuthority: 'provider', pnlMethod: 'provider_explicit_net_cents', quantityProjection: { version: 1, value: '2', unit: 'base_units', volumeScale: 'unit_cents', source: 'provider_filled_volume', baseAssetName: 'XAU' } },
  }, {
    date: '2026-01-03', symbol: 'XAUUSD', asset: 'cm', direction: 'Short', entry: 2000, exit: 2002, size: 0.02,
    pnl: null, strategy: 'System', custom: { playbook: {} }, emotion: 'Calm', accountId: 'acct-a', notes: '', isOpen: false, source: 'ctrader',
    brokerData: { accountCurrency: 'USD', calculatedGrossPnl: '-4.00' },
  }]);
  const journalRows = JSON.parse(JSON.stringify(parser.parseCSV(journalCsv)));
  if (!journalCsv.includes('\r\n') || journalRows.length !== 4 || journalRows[1].length !== 32 || journalRows[1][5] !== "'=CMD()" ||
      journalRows[1][14] !== '-2.00' || journalRows[1][15] !== 'USD' || journalRows[1][16] !== 'manual_reported' || journalRows[1][21] !== "'+SUM(1,1)" || journalRows[1][22] !== "'=HYPERLINK(\"bad\")" || journalRows[1][30] !== "'@Desk" || journalRows[1][31] !== 'line 1, "quoted"\nline 2') {
    failures.push('RFC 4180 journal export or spreadsheet-injection protection regressed');
  }
  if (journalRows[0][3] !== 'Duration' || journalRows[0][4] !== 'Duration Seconds' || journalRows[2][3] !== '37m' || journalRows[2][4] !== '2240' ||
      journalRows[0][11] !== 'Size Unit' || journalRows[0][15] !== 'P&L Currency' || journalRows[2][10] !== '2' || journalRows[2][11] !== 'XAU base units' || journalRows[2][15] !== 'EUR' || journalRows[2][16] !== 'broker_exact_net') {
    failures.push('Journal CSV export mislabeled a cTrader base-unit quantity as lots');
  }
  if (journalRows[3][14] !== '' || journalRows[3][16] !== 'estimated_gross' || journalRows[3][17] !== '' || journalRows[3][18] !== 'unavailable' || journalRows[3][19] !== '-4.00' || journalRows[3][20] !== 'USD') {
    failures.push('Journal CSV export mixed calculated gross into verified net or lost estimate provenance');
  }
} catch (error) {
  failures.push(`CSV parser/export fixture failed: ${error.message}`);
}

try {
  const { exports: analytics } = evaluateSecurityFixture(
    `${dateValidationSource}\n${csvFingerprintSource}\n${analyticsCalculationSource}`,
    { stableJson: value => JSON.stringify(value) },
    '{compareTradeChronology,signedMoney,analyticsWeekKey,calculateEdgeDiagnostic,calculateAnalyticsDrawdown,bootstrapMonthlyOutcomes}',
  );
  const chronology = [{ id: 3, date: '2026-01-03' }, { id: 1, date: '2026-01-01' }, { id: 2, date: '2026-01-02' }].sort(analytics.compareTradeChronology);
  if (chronology.map(trade => trade.id).join(',') !== '1,2,3') failures.push('Equity/analytics chronology sort regressed');
  if (analytics.signedMoney(-10, '$') !== '-$10' || analytics.signedMoney(0, '$') !== '$0' || analytics.analyticsWeekKey('2026-01-01') !== '2025-12-29') {
    failures.push('Analytics/calendar sign or ISO week calculation regressed');
  }
  const edgeTrades = [
    { date: '2026-01-01', pnl: 100, strategy: 'A' }, { date: '2026-01-02', pnl: -50, strategy: 'A' },
    { date: '2026-01-08', pnl: 100 }, { date: '2026-01-09', pnl: -50 },
  ];
  const edge = analytics.calculateEdgeDiagnostic(edgeTrades, trade => trade.pnl);
  if (edge.winRate !== 0.5 || edge.avgWin !== 100 || edge.avgLoss !== 50 || edge.rrRatio !== 2 || edge.tagCoverage !== 0.5 || !Number.isFinite(edge.score)) {
    failures.push('Transparent edge diagnostic calculation regressed');
  }
  const drawdownTrades = [
    { id: 3, date: '2026-01-03', pnl: 60 }, { id: 1, date: '2026-01-01', pnl: 100 },
    { id: 2, date: '2026-01-02', pnl: -150 }, { id: 4, date: '2026-01-04', pnl: 10 }, { id: 5, date: '2026-01-05', pnl: 100 },
  ];
  const drawdown = analytics.calculateAnalyticsDrawdown(drawdownTrades, trade => trade.pnl, 1000);
  if (drawdown.maxDepth !== 150 || !approximatelyEqual(drawdown.maxPct, 150 / 1100 * 100) || drawdown.troughDate !== '2026-01-02' || drawdown.recoveryDate !== '2026-01-05' || drawdown.recoveryDays !== 3 || drawdown.unrecovered) {
    failures.push('Observed drawdown/recovery calculation regressed');
  }
  const bootstrapA = analytics.bootstrapMonthlyOutcomes([100, -50, 20], 4, 100);
  const bootstrapB = analytics.bootstrapMonthlyOutcomes([100, -50, 20], 4, 100);
  if (bootstrapA.length !== 100 || JSON.stringify(bootstrapA) !== JSON.stringify(bootstrapB) || bootstrapA.some((value, index) => index && value < bootstrapA[index - 1])) {
    failures.push('Deterministic bootstrap analytics regressed');
  }
} catch (error) {
  failures.push(`Analytics calculation fixture failed: ${error.message}`);
}

try {
  const { exports: calendar } = evaluateSecurityFixture(
    calendarNavigationSource,
    { renderCalendar() {} },
    '{calMove,setState:(year,month,view,selected,anchor)=>{calYear=year;calMonth=month;calView=view;calSelectedDay=selected;calWeekAnchor=anchor;},getState:()=>({calYear,calMonth,calSelectedDay,calWeekAnchor})}',
  );
  calendar.setState(2026, 0, 'week', 31, '2026-01-31');
  calendar.calMove(1);
  calendar.calMove(1);
  const moved = calendar.getState();
  if (moved.calYear !== 2026 || moved.calMonth !== 1 || moved.calSelectedDay !== null || moved.calWeekAnchor !== '2026-02-14') {
    failures.push('Calendar week navigation lost its persistent seven-day anchor');
  }
} catch (error) {
  failures.push(`Calendar navigation fixture failed: ${error.message}`);
}

requireMatch(app, /const closed=view\.closedRows\.map\([^;]*?\)\.sort\(compareTradeChronology\)/, 'explicit mixed-provisional analytics trade chronology sort');
requireMatch(app, /deterministic bootstrap/i, 'deterministic bootstrap analytics label');
rejectMatch(app, /Your real edge|Revenge trading|60[–-]70%|trades to 95%/i, 'fabricated analytics claim');

// Stored DOM-XSS regression suite. Every value below represents data that can
// survive a reload (API/import/settings/journal data), so renderers must treat
// it as text even if an older client or migration bypassed today's form UI.
const securityHelperSource = sourceBetween('function escapeHtml', 'function formatCtraderWhen');
const screenshotLookupSource = sourceBetween('function getThumbSrc', 'function formatDate');
const positionSemanticsSource = sourceBetween('function tradeIsOpen', 'const cur');
const securityWindow = {
  location: { origin: 'https://edgebook.trade' },
  _dataMode: 'vps',
};

try {
  const { exports: helpers } = evaluateSecurityFixture(
    securityHelperSource,
    { window: securityWindow },
    '{escapeHtml,inlineStringArg,safeClassToken,safeDomId,safeAccountColor,safeScreenshotSource}',
  );
  for (const unsafeSource of [
    'javascript:alert(1)',
    'data:text/html,<svg onload=alert(1)>',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'https://attacker.example/api/files/stolen',
    '//attacker.example/api/files/stolen',
  ]) {
    if (helpers.safeScreenshotSource(unsafeSource) !== '') {
      failures.push(`Unsafe screenshot source was accepted: ${unsafeSource}`);
    }
  }
  if (helpers.safeScreenshotSource('/api/files/chart_1') !== '/api/files/chart_1') {
    failures.push('Same-origin screenshot API path was rejected');
  }
  if (!helpers.escapeHtml(maliciousMarkup).includes('&lt;img')) failures.push('escapeHtml did not encode persisted markup');
  if (helpers.safeAccountColor('red;background-image:url(javascript:alert(1))') !== '#6c63ff') {
    failures.push('Unsafe persisted account color was accepted');
  }
} catch (error) {
  failures.push(`Security helper runtime failed: ${error.message}`);
}

try {
  const { exports: semantics } = evaluateSecurityFixture(
    positionSemanticsSource,
    {
      isRealIsoDate: value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)),
      tradeFinancialPresentation: trade => Number.isFinite(Number(trade?.pnl)) ? { amount:Number(trade.pnl), isEstimate:false, includeInAnalytics:true } : null,
      financialPresentationDate: (instant,_zone,fallback) => fallback || String(instant||'').slice(0,10),
      tradeJournalDate: trade => trade?.date||'',
      financialPresentationLedgerForTrades: source => source.flatMap(trade => (trade?.brokerData?.realizedEvents||[]).map(event => ({...trade,ledgerDate:event.date,ledgerPnl:Number(event.pnl),realizedEvent:event,financialIsEstimate:false}))),
    },
    '{tradeIsOpen,tradeHasPnl,tradeIsClosedWithPnl,tradeRealizedEvents,realizedLedgerForTrades}',
  );
  const partial = {
    id: 'position-1',
    isOpen: true,
    exit: 1.25,
    pnl: 12.5,
    date: '2026-01-15',
    brokerData: { realizedEvents: [{ executionId: 'close-1', date: '2026-02-02', pnl: '12.5' }] },
  };
  if (!semantics.tradeIsOpen(partial) || !semantics.tradeHasPnl(partial) || semantics.tradeIsClosedWithPnl(partial)) {
    failures.push('Partial cTrader position was classified as a completed trade');
  }
  const ledger = semantics.realizedLedgerForTrades([partial]);
  if (ledger.length !== 1 || ledger[0].ledgerDate !== '2026-02-02' || ledger[0].ledgerPnl !== 12.5) {
    failures.push('Partial-close P&L was not preserved on its close-execution date');
  }
  if (!semantics.tradeIsClosedWithPnl({ isOpen: false, pnl: 10 }) || !semantics.tradeIsOpen({ exit: null, pnl: null })) {
    failures.push('Completed or legacy-open trade semantics regressed');
  }
} catch (error) {
  failures.push(`Position-semantics runtime failed: ${error.message}`);
}

try {
  const currencySource = sourceBetween('function currencySymbol', 'function getThumbSrc');
  const accountCurrencySource = sourceBetween('function acctCur', 'async function addAccount');
  const maliciousAccount = { currency: maliciousMarkup };
  const { exports: currency } = evaluateSecurityFixture(
    `${currencySource}\n${accountCurrencySource}`,
    {
      S: { prefs: { currency: maliciousMarkup } },
      getAccount: id => id === 'malicious-account' ? maliciousAccount : null,
    },
    '{currencySymbol,cur,acctCur}',
  );
  for (const value of [maliciousMarkup, 'USD<img onerror=alert(1)>', '" onmouseover="alert(1)', 'url(javascript:alert(1))']) {
    if (currency.currencySymbol(value) !== '$') failures.push(`Unsafe persisted currency was accepted: ${value}`);
  }
  for (const value of ['$', 'USD', 'INR', 'A$']) {
    if (currency.currencySymbol(value) !== value) failures.push(`Supported currency was rejected: ${value}`);
  }
  if (currency.cur() !== '$') failures.push('Global settings currency bypassed the currency allowlist');
  if (currency.acctCur('malicious-account') !== '$') failures.push('Account currency bypassed the currency allowlist');
} catch (error) {
  failures.push(`Currency allowlist fixture failed: ${error.message}`);
}

try {
  const document = makeFakeDocument();
  const notificationSource = sourceBetween('function relativeTime', 'function updateNotifBadge');
  const { exports: notification } = evaluateSecurityFixture(
    `${securityHelperSource}\n${notificationSource}`,
    { document, window: securityWindow },
    '{renderNotifications}',
  );
  notification.renderNotifications([{
    id: maliciousIdentifier,
    type: 'warning\" onclick=\"globalThis.__edgebookXss=5',
    read: false,
    title: maliciousMarkup,
    message: maliciousMarkup,
    actionLabel: maliciousMarkup,
    actionTarget: maliciousIdentifier,
    createdAt: Date.now(),
  }]);
  const html = document.getElementById('notif-list').innerHTML;
  assertNoExecutablePayload(html, 'Notification renderer');
  assertInlineArgument(html, 'markNotifRead', maliciousIdentifier, 'Notification read action');
  assertInlineArgument(html, 'handleNotifAction', maliciousIdentifier, 'Notification link action');
} catch (error) {
  failures.push(`Notification XSS fixture failed: ${error.message}`);
}

try {
  const duplicateSource = sourceBetween('function _dupFld', 'async function resolveDup');
  const { exports: duplicate } = evaluateSecurityFixture(
    `${securityHelperSource}\n${quantityProjectionSource}\n${sizeLabelSource}\n${duplicateSource}`,
    { window: securityWindow, formatDate: value => value },
    '{dupTradeCard}',
  );
  const html = duplicate.dupTradeCard({
    symbol: maliciousMarkup,
    direction: maliciousMarkup,
    date: maliciousMarkup,
    entry: 1,
    exit: 2,
    size: 1,
    pnl: 1,
    strategy: maliciousMarkup,
    notes: maliciousMarkup,
    source: maliciousMarkup,
  }, null);
  assertNoExecutablePayload(html, 'Duplicate trade renderer');
  const baseUnitHtml = duplicate.dupTradeCard({
    symbol: 'XAUUSD', direction: 'Long', date: '2026-08-13', entry: 2000, exit: 2001, size: 0.02, pnl: 2,
    source: 'ctrader', brokerData: { quantityProjection: { version: 1, value: '2', unit: 'base_units', volumeScale: 'unit_cents', source: 'provider_filled_volume', baseAssetName: 'XAU' } },
  }, null);
  if (!/Size \(XAU base units\)/.test(baseUnitHtml) || !/>2</.test(baseUnitHtml)) failures.push('Duplicate review card mislabeled a cTrader base-unit quantity');
} catch (error) {
  failures.push(`Duplicate-trade XSS fixture failed: ${error.message}`);
}

try {
  const document = makeFakeDocument();
  const accountSource = [
    sourceBetween('function getAccount', 'function selectAccount'),
    sourceBetween('function buildAcctList', 'function updateAccountSelect'),
    sourceBetween('function updateAccountSelect', 'function selectSymbolTab'),
  ].join('\n');
  const account = {
    id: maliciousIdentifier,
    name: maliciousMarkup,
    size: 1000,
    currency: maliciousMarkup,
    color: 'red;background-image:url(javascript:alert(1))',
  };
  const { exports: accountRenderers } = evaluateSecurityFixture(
    `${securityHelperSource}\n${accountSource}`,
    {
      document,
      window: securityWindow,
      S: { accounts: [account] },
      trades: [],
      financialCoverageForTrades: () => ({ overallNet: null }),
      financialCoverageIssueText: () => maliciousMarkup,
      activeAcctId: account.id,
      ACCT_COLORS: ['#6c63ff'],
    },
    '{buildAcctDropdown,buildAcctList,updateAccountSelect}',
  );
  accountRenderers.buildAcctDropdown();
  accountRenderers.buildAcctList();
  accountRenderers.updateAccountSelect();
  for (const [id, label] of [
    ['dd-accounts-list', 'Account switcher'],
    ['acct-list-el', 'Account settings list'],
    ['t-account', 'Trade account selector'],
  ]) assertNoExecutablePayload(document.getElementById(id).innerHTML, label);
  assertInlineArgument(document.getElementById('dd-accounts-list').innerHTML, 'selectAccount', account.id, 'Account switcher');
  assertInlineArgument(document.getElementById('acct-list-el').innerHTML, 'openEditAccount', account.id, 'Account edit action');
  if (document.getElementById('dd-accounts-list').innerHTML.includes('background-image')) {
    failures.push('Account switcher retained an unsafe persisted color');
  }
  if (!/P&L:[\s\S]*— \(incomplete\)/.test(document.getElementById('acct-list-el').innerHTML)) failures.push('Account settings did not render incomplete financial coverage safely');
} catch (error) {
  failures.push(`Account XSS fixture failed: ${error.message}`);
}

try {
  const document = makeFakeDocument();
  const customFieldSource = sourceBetween('function buildCustomFieldsForm', 'async function toggleFormField');
  const { exports: customFields } = evaluateSecurityFixture(
    `${securityHelperSource}\n${customFieldSource}`,
    {
      document,
      window: securityWindow,
      S: { customFields: [{ id: maliciousIdentifier, label: maliciousMarkup, type: 'select', options: `Safe,${maliciousMarkup}`, section: 'trade', order: 0 }] },
      dictationControlHtml: () => '',
      dictationStatusHtml: () => '',
      refreshDictationControls() {},
    },
    '{buildCustomFieldsForm}',
  );
  customFields.buildCustomFieldsForm();
  const html = document.getElementById('custom-fields-trade').innerHTML;
  assertNoExecutablePayload(html, 'Custom-field renderer');
  if (html.includes(`id=\"cf-v-${maliciousIdentifier}`)) failures.push('Custom field used a raw persisted DOM identifier');
} catch (error) {
  failures.push(`Custom-field XSS fixture failed: ${error.message}`);
}

try {
  const account = { id: maliciousIdentifier, name: maliciousMarkup, color: '#6c63ff', currency: maliciousMarkup };
  const tradeSource = sourceBetween('function acctTagCell', 'function getBaseFilteredTrades');
  const { exports: tradeRenderer } = evaluateSecurityFixture(
    `${securityHelperSource}\n${positionSemanticsSource}\n${screenshotLookupSource}\n${quantityProjectionSource}\n${calculatedGrossPresentationSource}\n${tradeSource}`,
    {
      window: securityWindow,
      getAccount: id => id === account.id ? account : null,
      acctCur: () => maliciousMarkup,
      normalizeFxCurrency: () => null,
      pnlBreakdown: () => maliciousMarkup,
      cTraderExactPnlBreakdown: () => null,
      cTraderTradeNeedsReview: () => false,
      FUTURES_SPECS: {},
      ASSET_LABELS: { eq: 'Equity', cx: 'Crypto', fx: 'Forex', cm: 'Commodity', ix: 'Index' },
      fmtDate: value => value,
      formatTime: value => value,
      tradeJournalDate: trade => String(trade?.date||'').slice(0,10),
    },
    '{tradeRow}',
  );
  const persistedTrade = {
    id: maliciousIdentifier,
    accountId: account.id,
    symbol: maliciousMarkup,
    asset: `eq\" onclick=\"globalThis.__edgebookXss=6`,
    direction: maliciousMarkup,
    date: maliciousMarkup,
    entryTime: maliciousMarkup,
    entry: 100,
    exit: 101,
    size: maliciousMarkup,
    sl: 99,
    tp: 102,
    pnl: 1,
    emotion: maliciousMarkup,
    strategy: maliciousMarkup,
    instrument: maliciousMarkup,
    optionType: maliciousMarkup,
    strike: maliciousMarkup,
    source: maliciousMarkup,
    screenshots: [{ src: `/api/files/chart_1?name=${maliciousMarkup}`, name: maliciousMarkup }],
  };
  const html = tradeRenderer.tradeRow(persistedTrade);
  assertNoExecutablePayload(html, 'Trade-row renderer');
  assertInlineArgument(html, 'openTradeModal', maliciousIdentifier, 'Trade edit action');
  assertInlineArgument(html, 'deleteTrade', maliciousIdentifier, 'Trade archive action');
  assertInlineArgument(html, 'openLightbox', maliciousIdentifier, 'Trade screenshot action');
  const unsafeScreenshotHtml = tradeRenderer.tradeRow({ ...persistedTrade, screenshots: [{ src: 'javascript:alert(1)' }] });
  if (/javascript:/i.test(unsafeScreenshotHtml)) failures.push('Trade row retained an unsafe persisted screenshot URL');
  const durationHtml=tradeRenderer.tradeRow({
    ...persistedTrade,id:'duration-trade',date:'2026-08-13',entryAt:'2026-08-13T12:42:09.034Z',exitAt:'2026-08-13T13:19:29.975Z',durationSeconds:2240,
  });
  if (!durationHtml.includes('>37m</td>')) failures.push('Trade row did not show the exact provider entry-to-exit duration');
  const baseUnitHtml = tradeRenderer.tradeRow({
    ...persistedTrade,
    id: 'ctrader-base-units', source: 'ctrader', symbol: 'XAUUSD', asset: 'cm', size: 0.02,
    brokerData: { quantityProjection: { version: 1, value: '2', unit: 'base_units', volumeScale: 'unit_cents', source: 'provider_filled_volume', baseAssetName: 'XAU' } },
  });
  if (!/>2 <[\s\S]*?>XAU base units</.test(baseUnitHtml) || />2 <[\s\S]*?>lots</.test(baseUnitHtml)) failures.push('Trade row mislabeled an unknown-contract cTrader quantity');
  const providerMoneyHtml = tradeRenderer.tradeRow({
    ...persistedTrade,
    id: 'ctrader-provider-currency', source: 'ctrader', pnl: 1,
    brokerData: { accountCurrency: 'EUR' },
  });
  if (!providerMoneyHtml.includes('+€1.00')) failures.push('Trade row did not use authoritative cTrader account currency for provider P&L');
  const calculatedGrossTrade = {
    ...persistedTrade,
    id: 'ctrader-calculated-gross', source: 'ctrader', pnl: null, isOpen: false,
    brokerData: {
      accountCurrency: 'USD', calculatedGrossPnl: '-20.5', calculatedGrossCurrency: 'USD',
      calculatedGrossMethod: 'fill_price_base_units_identity_conversion_v1',
      calculatedGrossProvenance: { version: 1, feesIncluded: false, accountMoneyDigits: 2, quoteCurrency: 'USD', accountCurrency: 'USD', conversionRate: '1' },
      estimatedCommission: '-0.18', estimatedSwap: '0', estimatedConversionFee: '0', estimatedOtherCharges: '0',
      estimatedFeesAndCharges: '-0.18', estimatedNetPnl: '-20.68', estimatedNetCurrency: 'USD',
      estimatedNetMethod: 'remote_mcp_execution_commission_same_currency_v1',
      estimatedNetProvenance: { version: 1, exact: false, accountMoneyDigits: 2, accountCurrency: 'USD' },
    },
  };
  const calculatedGrossHtml = tradeRenderer.tradeRow(calculatedGrossTrade);
  if (!/class="pnl-neg"[^>]*>-\$0\.18<\/span>/.test(calculatedGrossHtml)) failures.push('Estimated combined fees were not rendered as a signed charge');
  if (!/class="pnl-neg">-\$20\.68<\/span>/.test(calculatedGrossHtml)) failures.push('Estimated net loss did not use the same red signed-money treatment as manual P&L');
  if (/Calc\. gross|fa-calculator/.test(calculatedGrossHtml)) failures.push('Calculated gross row kept the noisy legacy label or calculator icon');
  if ((calculatedGrossHtml.match(/class="pnl-estimate-badge"/g)||[]).length<2 || !/observed opening\/closing execution commissions/.test(calculatedGrossHtml)) failures.push('Estimated fees/net row lost its provenance disclosure');
  const calculatedGainHtml = tradeRenderer.tradeRow({
    ...calculatedGrossTrade,
    id: 'ctrader-calculated-gain',
    brokerData: { ...calculatedGrossTrade.brokerData, calculatedGrossPnl: '28', estimatedNetPnl: '27.82' },
  });
  if (!/class="pnl-pos">\+\$27\.82<\/span>/.test(calculatedGainHtml)) failures.push('Estimated net gain did not use the same green signed-money treatment as manual P&L');
} catch (error) {
  failures.push(`Trade-row XSS fixture failed: ${error.message}`);
}

try {
  const document = makeFakeDocument();
  const archivedSource = sourceBetween('function renderDeletedTrades', 'async function restoreTrade');
  const { exports: archived } = evaluateSecurityFixture(
    `${securityHelperSource}\n${archivedSource}`,
    {
      document,
      window: securityWindow,
      _deletedTrades: [{
        id: maliciousIdentifier,
        accountId: maliciousIdentifier,
        date: maliciousMarkup,
        symbol: maliciousMarkup,
        direction: maliciousMarkup,
        entry: maliciousMarkup,
        exit: maliciousMarkup,
        pnl: null,
        source: maliciousMarkup,
        deletedAt: maliciousMarkup,
      }],
      acctName: () => maliciousMarkup,
      tradeFinancialPresentation: () => null,
      calculatedGrossText: () => '',
      tradeMoneyPrefix: () => '$',
      signedMoney: () => '—',
    },
    '{renderDeletedTrades}',
  );
  archived.renderDeletedTrades();
  const html = document.getElementById('archived-trades-wrap').innerHTML;
  assertNoExecutablePayload(html, 'Archived-trade renderer');
  assertInlineArgument(html, 'restoreTrade', maliciousIdentifier, 'Archived trade restore action');
  assertInlineArgument(html, 'permanentDeleteTrade', maliciousIdentifier, 'Archived trade purge action');
} catch (error) {
  failures.push(`Archived-trade XSS fixture failed: ${error.message}`);
}

try {
  const document = makeFakeDocument();
  const moodSource = sourceBetween('function renderMoodHistory', 'function renderExposure');
  const { exports: mood } = evaluateSecurityFixture(
    `${securityHelperSource}\n${moodSource}`,
    {
      document,
      window: securityWindow,
      moods: [{ emotion: maliciousMarkup, type: maliciousMarkup, notes: maliciousMarkup, confidence: maliciousMarkup, date: maliciousMarkup, time: maliciousMarkup }],
      fmtDate: value => value,
    },
    '{renderMoodHistory}',
  );
  mood.renderMoodHistory();
  assertNoExecutablePayload(document.getElementById('mood-history-list').innerHTML, 'Mood-history renderer');
} catch (error) {
  failures.push(`Mood-history XSS fixture failed: ${error.message}`);
}

try {
  const document = makeFakeDocument();
  const exposureSource = sourceBetween('function renderExposure', 'function calcPos');
  const { exports: exposure } = evaluateSecurityFixture(
    `${quantityProjectionSource}\n${exposureSource}`,
    {
      document,
      trades: [
        { source: 'manual', asset: 'eq', entry: 100, size: 2, isOpen: true },
        { source: 'ctrader', asset: 'cm', entry: 2000, size: 0.02, isOpen: true, brokerData: { quantityProjection: { version: 1, value: '2', unit: 'base_units', volumeScale: 'unit_cents', source: 'provider_filled_volume', baseAssetName: 'XAU' } } },
      ],
      tradeIsOpen: trade => trade?.isOpen === true,
      ASSET_LABELS: { eq: 'Equities', cx: 'Crypto', fx: 'Forex', cm: 'Commodity' },
      cur: () => '$',
    },
    '{renderExposure}',
  );
  exposure.renderExposure();
  const html = document.getElementById('exposure-wrap').innerHTML;
  if (!html.includes('Equities (1)') || !html.includes('1 cTrader position is excluded') || html.includes('Commodity (1)')) {
    failures.push('Exposure analytics treated a cTrader base-unit quantity as a broker lot quantity');
  }
} catch (error) {
  failures.push(`cTrader base-unit exposure fixture failed: ${error.message}`);
}

try {
  const document = makeFakeDocument();
  const toastSource = sourceBetween('function showToast', 'function renderScreenshotPreviews');
  const { exports: toast } = evaluateSecurityFixture(
    toastSource,
    {
      document,
      navigator: { clipboard: { writeText: async () => {} } },
      clearTimeout() {},
      setTimeout() { return 1; },
      _tt: null,
    },
    '{showToast}',
  );
  toast.showToast(maliciousMarkup, `success\" onclick=\"globalThis.__edgebookXss=7`);
  const toastElement = document.body.children.at(-1);
  const messageElement = toastElement?.children?.[1];
  if (messageElement?.textContent !== maliciousMarkup) failures.push('Toast did not assign the message through textContent');
  if (document.created.some(element => element._innerHtmlWrites > 0)) failures.push('Toast wrote user-controlled content through innerHTML');
  if (toastElement?.className !== 'toast info') failures.push('Toast accepted an unsafe persisted type as a CSS class');
} catch (error) {
  failures.push(`Toast XSS fixture failed: ${error.message}`);
}

try {
  const document = makeFakeDocument();
  const screenshotSource = sourceBetween('function renderScreenshotPreviews', 'function _setUploadingCount');
  const source = `${securityHelperSource}\nlet currentScreenshots=globalThis.seedScreenshots;\n${screenshotSource}`;
  const { exports: screenshot } = evaluateSecurityFixture(
    source,
    {
      document,
      window: securityWindow,
      seedScreenshots: [
        { src: 'javascript:alert(1)', name: maliciousMarkup },
        { src: '/api/files/chart_1', name: maliciousMarkup },
      ],
    },
    '{renderScreenshotPreviews,getScreenshots:()=>currentScreenshots}',
  );
  screenshot.renderScreenshotPreviews();
  const html = document.getElementById('ss-preview').innerHTML;
  assertNoExecutablePayload(html, 'Screenshot-preview renderer');
  if (/javascript:/i.test(html)) failures.push('Screenshot preview retained an unsafe persisted URL');
  if (screenshot.getScreenshots().length !== 1) failures.push('Screenshot preview did not discard an unsafe persisted URL');
} catch (error) {
  failures.push(`Screenshot-preview XSS fixture failed: ${error.message}`);
}

try {
  // Model the critical create -> attachment failure -> Save retry path without
  // executing the large form reader. The first write creates once, failure
  // keeps the modal/draft open, retry carries canonical version and uploads
  // the same File/key, and only then may the modal close.
  const canonicalTrade = { id: 'draft-trade-1', symbol: 'GOLD', entry: 100, version: 1, screenshots: [] };
  const retainedFile = { name: 'chart.jpg' };
  const retainedKey = '11111111-1111-4111-8111-111111111111';
  let tradeWrites = 0;
  let uploadAttempts = 0;
  let closeCalls = 0;
  let refreshCalls = 0;
  let retryMode = false;
  const draft = { id: 'draft-1', file: retainedFile, previewUrl: 'blob:fixture', idempotencyKey: retainedKey, name: retainedFile.name };
  const fixtureSource = `
    let trades=globalThis.seedTrades;
    let currentScreenshots=[{pendingScreenshotId:'draft-1',src:'blob:fixture',name:'chart.jpg'}];
    let pendingTradeScreenshotDraft=[globalThis.seedDraft];
    let _tradeDraftId='draft-trade-1';
    let _tradeDraftCommittedId=null;
    let editId=null;
    function syncCurrentScreenshotsToTrade(trade){ trade.screenshots=[...currentScreenshots]; const live=trades.find(item=>String(item.id)===String(trade.id)); if(live&&live!==trade)live.screenshots=[...currentScreenshots]; DataStore._knownTrades.set(String(trade.id),JSON.stringify(live||trade)); }
    function revokePendingTradeScreenshot(){}
    ${screenshotDraftUploadSource}
    function restorePendingScreenshotPreviews(canonicalTrade){ currentScreenshots=[...(canonicalTrade.screenshots||[]),...pendingTradeScreenshotDraft.map(item=>({pendingScreenshotId:item.id,src:item.previewUrl,name:item.name}))]; }
    async function reloadCommittedTradeKeepingScreenshotDraft(tradeId){ const committed=trades.find(item=>String(item.id)===String(tradeId)); if(committed)restorePendingScreenshotPreviews(committed); return committed||null; }
    ${newTradeScreenshotPersistenceSource}
  `;
  const { exports: persistence } = evaluateSecurityFixture(
    fixtureSource,
    {
      seedTrades: [],
      seedDraft: draft,
      window: { _dataMode: 'vps', _vpsData: { screenshots: { url: id => `/api/files/${id}` } } },
      crypto: { randomUUID: () => retainedKey },
      DataStore: {
        _uid: 'user-1',
        _knownTrades: new Map(),
        _lastTradeSyncError: null,
        _lastTradeSyncWarning: null,
        async saveTrade(trade) {
          tradeWrites += 1;
          if (tradeWrites === 1) {
            Object.assign(trade, canonicalTrade);
            this._knownTrades.set(String(trade.id), JSON.stringify(trade));
            persistence?.setTrades?.([trade]);
            return true;
          }
          if (trade.version !== 1) throw new Error('retry lost canonical version');
          return true;
        },
        async loadFromFirestore() {},
      },
      async uploadVpsScreenshotFile(tradeId, file, options) {
        uploadAttempts += 1;
        if (tradeId !== canonicalTrade.id || file !== retainedFile || options?.idempotencyKey !== retainedKey) {
          throw new Error('attachment retry changed its target, File, or idempotency key');
        }
        if (!retryMode) throw new Error('temporary upload failure');
        return { id: 'file-1', fileId: 'file-1', src: '/api/files/file-1', name: file.name };
      },
      renderScreenshotPreviews() {},
      refreshAll() { refreshCalls += 1; },
      tradeSaveFailureMessage: () => 'failed',
      showToast() {},
      resetPendingTradeScreenshotDraft() {},
      closeModal(id) { if (id === 'trade-modal') closeCalls += 1; },
      URL: { revokeObjectURL() {} },
    },
    '{persistNewTradeWithScreenshotDraft,finishNewTradeSave,setTrades:value=>{trades=value},getState:()=>({trades,currentScreenshots,pendingTradeScreenshotDraft})}',
  );
  const intended = { id: canonicalTrade.id, symbol: canonicalTrade.symbol, entry: canonicalTrade.entry, screenshots: [{ pendingScreenshotId: 'draft-1', src: 'blob:fixture', name: 'chart.jpg' }] };
  const first = await persistence.persistNewTradeWithScreenshotDraft(intended);
  persistence.finishNewTradeSave(first);
  if (!first.tradeSaved || first.attachmentsSaved || tradeWrites !== 1 || uploadAttempts !== 1 || closeCalls !== 0 || persistence.getState().pendingTradeScreenshotDraft.length !== 1) {
    failures.push('Failed new-trade screenshot upload did not keep one durable trade and a recoverable open draft');
  }
  retryMode = true;
  const retry = { ...intended, screenshots: [...persistence.getState().currentScreenshots] };
  const second = await persistence.persistNewTradeWithScreenshotDraft(retry);
  persistence.finishNewTradeSave(second);
  if (!second.attachmentsSaved || tradeWrites !== 2 || uploadAttempts !== 2 || closeCalls !== 1 || persistence.getState().pendingTradeScreenshotDraft.length !== 0 || refreshCalls < 1) {
    failures.push('New-trade screenshot retry duplicated the trade, changed its upload key, or closed before attachment success');
  }
} catch (error) {
  failures.push(`New-trade screenshot retry fixture failed: ${error.message}`);
}

try {
  // A failed write against a stable ID that belongs to a different trade must
  // not be reclassified as success and must never receive this draft's image.
  let uploadCalls = 0;
  let closeCalls = 0;
  const fixtureSource = `
    let trades=[{id:'occupied-id',symbol:'SILVER',entry:200,version:9,screenshots:[]}];
    let currentScreenshots=[{pendingScreenshotId:'draft-1',src:'blob:fixture',name:'chart.jpg'}];
    let pendingTradeScreenshotDraft=[{id:'draft-1',file:{name:'chart.jpg'},previewUrl:'blob:fixture',idempotencyKey:'22222222-2222-4222-8222-222222222222',name:'chart.jpg'}];
    let _tradeDraftId='occupied-id'; let _tradeDraftCommittedId=null; let editId=null;
    function syncCurrentScreenshotsToTrade(){}
    function revokePendingTradeScreenshot(){}
    ${screenshotDraftUploadSource}
    function restorePendingScreenshotPreviews(){}
    async function reloadCommittedTradeKeepingScreenshotDraft(){ return trades[0]; }
    ${newTradeScreenshotPersistenceSource}
  `;
  const { exports: collision } = evaluateSecurityFixture(
    fixtureSource,
    {
      window: { _dataMode: 'vps', _vpsData: { screenshots: { url: id => `/api/files/${id}` } } },
      DataStore: { _uid: 'user-1', _knownTrades: new Map(), _lastTradeSyncError: { status: 409 }, _lastTradeSyncWarning: null, saveTrade: async () => false },
      uploadVpsScreenshotFile: async () => { uploadCalls += 1; },
      renderScreenshotPreviews() {}, refreshAll() {}, tradeSaveFailureMessage: () => 'conflict', showToast() {},
      resetPendingTradeScreenshotDraft() {}, closeModal() { closeCalls += 1; }, URL: { revokeObjectURL() {} },
    },
    '{persistNewTradeWithScreenshotDraft,finishNewTradeSave}',
  );
  const result = await collision.persistNewTradeWithScreenshotDraft({ id: 'occupied-id', symbol: 'GOLD', entry: 100, screenshots: [] });
  collision.finishNewTradeSave(result);
  if (result.tradeSaved || uploadCalls !== 0 || closeCalls !== 0) failures.push('Same-ID conflicting trade received an unrelated screenshot draft');
} catch (error) {
  failures.push(`Screenshot stable-ID collision fixture failed: ${error.message}`);
}

try {
  // Compression is asynchronous. If modal A closes and modal B opens before
  // it finishes, A's completion must be rejected and never target B's trade.
  let resolveCompression;
  let uploadCalls = 0;
  const compression = new Promise(resolve => { resolveCompression = resolve; });
  const { exports: selection } = evaluateSecurityFixture(
    `let _tradeModalGeneration=1; ${screenshotSelectionSource}`,
    {
      compressImage: () => compression,
      document: { getElementById: () => ({ classList: { contains: () => true } }) },
      File: class FixtureFile { constructor(parts, name, options) { this.parts=parts; this.name=name; this.type=options?.type; } },
      window: { _dataMode: 'vps', _vpsData: {} },
      uploadVpsScreenshotFile: async () => { uploadCalls += 1; },
      queuePendingTradeScreenshotFile: () => { uploadCalls += 1; },
    },
    '{uploadScreenshotFile,setGeneration:value=>{_tradeModalGeneration=value}}',
  );
  const pending = selection.uploadScreenshotFile({ name: 'a.jpg' }, { generation: 1, targetTradeId: 'trade-a' });
  selection.setGeneration(2);
  resolveCompression({ type: 'image/jpeg' });
  let staleError = null;
  try { await pending; } catch (error) { staleError = error; }
  if (staleError?.code !== 'STALE_SCREENSHOT_DRAFT' || uploadCalls !== 0) {
    failures.push('A closed trade modal uploaded its late screenshot into a newer modal');
  }
} catch (error) {
  failures.push(`Screenshot modal-generation fixture failed: ${error.message}`);
}

try {
  const document = makeFakeDocument();
  const heatmapCellSource = sourceBetween('function hmHeatClass', 'function renderHeatmap');
  const { exports: heatmapCell } = evaluateSecurityFixture(
    `${securityHelperSource}\n${positionSemanticsSource}\n${heatmapCellSource}`,
    {
      document,
      window: securityWindow,
      hmSize: 'equal',
      hmSelected: null,
      acctCur: () => '$',
      tradeMoneyPrefix: () => '$',
      tradeFinancialPresentation: trade => trade?.estimated ? { amount: -4, isEstimate: true, gross: { valueText: '-4.00', currency: 'USD' } } : Number.isFinite(Number(trade?.pnl)) ? { amount: Number(trade.pnl), isEstimate: false } : null,
      calculatedGrossText: () => '−$4.00',
      formatDate: value => value,
      hmSelectTrade() {},
    },
    '{makeHmCell}',
  );
  const cell = heatmapCell.makeHmCell({
    id: maliciousIdentifier,
    symbol: maliciousMarkup,
    optionType: maliciousMarkup,
    direction: maliciousMarkup,
    date: maliciousMarkup,
    pnl: 10,
    screenshots: [{ src: '/api/files/chart_1' }],
  }, 10);
  assertNoExecutablePayload(cell.innerHTML, 'Heatmap-cell renderer');
  assertInlineArgument(cell.innerHTML, 'openLightbox', maliciousIdentifier, 'Heatmap screenshot action');
  const estimatedCell = heatmapCell.makeHmCell({ id: 'est-1', symbol: 'XAUUSD', direction: 'Short', date: '2026-08-13', pnl: null, isOpen: false, estimated: true, screenshots: [] }, 10, -4);
  if (!/−\$4\.00[\s\S]*pnl-estimate-badge[\s\S]*est\./.test(estimatedCell.innerHTML) || !/fees and swap are excluded/.test(estimatedCell.innerHTML)) failures.push('Heatmap did not render the shared signed estimated-gross presentation');

  const filterDocument = makeFakeDocument();
  const heatmapFilterSource = sourceBetween('function buildHmAcctFilter', 'function setHmRange');
  const { exports: heatmapFilter } = evaluateSecurityFixture(
    `${securityHelperSource}\n${heatmapFilterSource}`,
    {
      document: filterDocument,
      window: securityWindow,
      S: { accounts: [{ id: maliciousIdentifier, name: maliciousMarkup }] },
    },
    '{buildHmAcctFilter}',
  );
  heatmapFilter.buildHmAcctFilter();
  assertNoExecutablePayload(filterDocument.getElementById('hm-acct').innerHTML, 'Heatmap account filter');

  const groupDocument = makeFakeDocument();
  groupDocument.getElementById('hm-acct').value = 'all';
  const heatmapGroupSource = sourceBetween('function renderHeatmap', 'function buildHmGridWithInsert');
  const maliciousHeatmapTrade = { strategy: maliciousMarkup, pnl: 10, ledgerPnl:10, displayPnl:10, financialIsEstimate:false, accountId: null };
  const { exports: heatmapGroup } = evaluateSecurityFixture(
    `${securityHelperSource}\n${positionSemanticsSource}\n${heatmapGroupSource}`,
    {
      document: groupDocument,
      window: securityWindow,
      hmGroup: 'strategy',
      hmSelected: null,
      trades: [maliciousHeatmapTrade],
      buildHmAcctFilter() {},
      stopDictation() {},
      hmFilteredTrades: () => [maliciousHeatmapTrade],
      buildHmGridWithInsert() {},
      acctCur: () => '$',
      tradeMoneyPrefix: () => '$',
      tradeFinancialPresentation: trade => Number.isFinite(Number(trade?.pnl)) ? { amount: Number(trade.pnl), isEstimate: false } : null,
      tradePnlToUSD: (trade, value = trade?.pnl) => Number(value),
      tradePnlInAccountCurrency: (trade, value = trade?.pnl) => Number(value),
      financialScopeForTrades: source => ({ included: source.map(trade => ({trade,presentation:{amount:Number(trade.pnl)}})) }),
      financialCoverageForTrades: () => ({ overallComplete: true, overallIncompleteCount: 0, disconnectedConnectionCount: 0 }),
      financialDisplayViewForTrades: () => ({ degraded:false,estimatedCount:0,coverage:{overallComplete:true,overallNet:10,overallIncompleteCount:0,disconnectedConnectionCount:0} }),
      financialDisplayViewNotice: () => '',
      financialCoverageIssueText: () => '',
      financialCoverageSnapshotText: () => '',
      FxRates: { toUSD: value => value },
      ASSET_LABELS: {},
      signedMoney: (value, symbol) => `${Number(value) < 0 ? '-' : Number(value) > 0 ? '+' : ''}${symbol}${Math.abs(Number(value)).toFixed(0)}`,
    },
    '{renderHeatmap}',
  );
  heatmapGroup.renderHeatmap();
  const groupLabel = groupDocument.getElementById('hm-grid-wrap').children[0];
  assertNoExecutablePayload(groupLabel?.innerHTML, 'Heatmap group renderer');
} catch (error) {
  failures.push(`Heatmap XSS fixture failed: ${error.message}`);
}

try {
  const document = makeFakeDocument();
  const journalEntrySource = sourceBetween('function renderDjEntry', 'function djScoreRow');
  const journalEntry = {
    mistake: maliciousMarkup,
    keyLesson: maliciousMarkup,
    woulddoDiff: maliciousMarkup,
    tomorrowIntentions: maliciousMarkup,
    notes: maliciousMarkup,
    preMoods: [maliciousMarkup],
    sessionMoods: [maliciousMarkup],
  };
  const { exports: journal } = evaluateSecurityFixture(
    `${securityHelperSource}\n${journalEntrySource}`,
    {
      document,
      window: securityWindow,
      djDate: '2026-08-09',
      TODAY: '2026-08-09',
      DJ_MOODS_PRE: ['Focused'],
      DJ_MOODS_EOD: ['Calm'],
      djGetEntry: () => journalEntry,
      djDayStats: () => ({ net: 0, count: 0, wr: null, best: null }),
      djFmtDate: value => value,
      djScoreRow: () => '',
      djYnRow: () => '',
      djRefreshVoiceControls() {},
      dictationControlHtml: () => '',
      dictationStatusHtml: () => '',
      refreshDictationControls() {},
      cur: () => '$',
      acctCur: () => '$',
    },
    '{renderDjEntry}',
  );
  journal.renderDjEntry();
  assertNoExecutablePayload(document.getElementById('dj-entry-wrap').innerHTML, 'Daily-journal entry renderer');

  const feedDocument = makeFakeDocument();
  const journalFeedSource = sourceBetween('function renderDjFeed', 'function djOpenEntry');
  const { exports: feed } = evaluateSecurityFixture(
    `${securityHelperSource}\n${journalFeedSource}`,
    {
      document: feedDocument,
      window: securityWindow,
      djDate: '2026-08-09',
      djLoadAll: () => ({ unsafe: { date: maliciousIdentifier, notes: maliciousMarkup, sessionMoods: [maliciousMarkup], sessionRating: 10 } }),
      djDayStats: () => ({ net: 0, count: 0 }),
      djFmtDateShort: value => value,
    },
    '{renderDjFeed}',
  );
  feed.renderDjFeed();
  const html = feedDocument.getElementById('dj-feed-list').innerHTML;
  assertNoExecutablePayload(html, 'Daily-journal feed renderer');
  assertInlineArgument(html, 'djOpenEntry', maliciousIdentifier, 'Daily-journal feed action');
} catch (error) {
  failures.push(`Daily-journal XSS fixture failed: ${error.message}`);
}

try {
  const classSet = values => {
    const set = new Set(values);
    return {
      add: (...items) => items.forEach(item => set.add(item)),
      remove: (...items) => items.forEach(item => set.delete(item)),
      toggle: (item, force) => {
        if (force === true) { set.add(item); return true; }
        if (force === false) { set.delete(item); return false; }
        if (set.has(item)) { set.delete(item); return false; }
        set.add(item); return true;
      },
      contains: item => set.has(item),
    };
  };
  const voiceIcon={className:''};
  const voiceBars=Array.from({length:4},()=>({style:{}}));
  const voiceButton={
    dataset:{dictationTarget:'dj-notes'},disabled:false,title:'',classList:classSet(['trade-voice-btn']),attributes:{},
    setAttribute(name,value){this.attributes[name]=String(value);},
    querySelector(selector){return selector==='i'?voiceIcon:null;},
    querySelectorAll(selector){return selector==='.trade-voice-wave b'?voiceBars:[];},
  };
  const voiceStatus={textContent:'',classList:classSet(['dictation-status'])};
  const listeners={};
  const voiceNotes={value:'Existing note.',readOnly:false,addEventListener(type,fn){listeners[type]=fn;},removeEventListener(type,fn){if(listeners[type]===fn)delete listeners[type];}};
  const voiceElements=new Map([['dj-notes',voiceNotes],['voice-status-dj-notes',voiceStatus]]);
  const voiceDocument={
    getElementById:id=>voiceElements.get(id)||null,
    querySelectorAll:selector=>selector==='[data-dictation-target]'?[voiceButton]:[],
  };
  const workers=[];
  class FakeWorker {
    constructor(url,options){this.url=url;this.options=options;this.messages=[];this.listeners={};workers.push(this);}
    addEventListener(type,fn){this.listeners[type]=fn;}
    postMessage(message){this.messages.push(message);}
    emit(message){this.listeners.message?.({data:message});}
    terminate(){this.terminated=true;}
  }
  const node=()=>({connect(){},disconnect(){}});
  let processor=null;
  class FakeAudioContext {
    constructor(){this.sampleRate=16000;this.destination={};}
    async resume(){}
    createMediaStreamSource(){return node();}
    createAnalyser(){return {...node(),fftSize:0,smoothingTimeConstant:0};}
    createScriptProcessor(){processor={...node(),onaudioprocess:null};return processor;}
    createGain(){return {...node(),gain:{value:1}};}
    close(){this.closed=true;}
  }
  let trackStopped=false,microphoneCalls=0,clock=0,activeSession=null,autosaveCancels=0;
  const stream={getTracks:()=>[{stop(){trackStopped=true;}}]};
  const fixtureRoot={isSecureContext:true,setTimeout,clearTimeout};
  const fixtureContext=vm.createContext({console,setTimeout,clearTimeout,globalThis:null});
  fixtureContext.globalThis=fixtureContext;
  vm.runInContext(dictationControllerSource,fixtureContext,{timeout:500});
  const controller=fixtureContext.createEdgebookDictationController({
    root:fixtureRoot,
    document:voiceDocument,
    navigator:{mediaDevices:{async getUserMedia(){microphoneCalls+=1;return stream;}}},
    performance:{now:()=>clock},
    WorkerClass:FakeWorker,
    AudioContextClass:FakeAudioContext,
    escapeHtml:value=>String(value),
    showToast(){},
    onSessionChange(value){activeSession=value;},
    cancelDailyAutosave(){autosaveCancels+=1;},
  });
  await controller.toggle('dj-notes');
  const worker=workers[0];
  if(!worker||worker.url!=='./client/on-device-whisper-worker.js'||worker.options?.type!=='module'||microphoneCalls!==0)failures.push('On-device dictation did not isolate model loading in its module worker before microphone capture');
  worker.emit({type:'model-loading',progress:42});
  if(!/42%/.test(voiceStatus.textContent)||!/95 MB/.test(voiceStatus.textContent))failures.push('On-device model download does not show finite progress and first-use size');
  worker.emit({type:'model-ready',model:'onnx-community/whisper-tiny.en'});
  await new Promise(resolve=>setImmediate(resolve));
  if(microphoneCalls!==1||!processor?.onaudioprocess||voiceButton.attributes['aria-pressed']!=='true'||autosaveCancels!==1)failures.push('On-device dictation did not start one microphone stream after the cached model became ready');
  const loud=new Float32Array(4096).fill(.08);
  clock=260;processor.onaudioprocess({inputBuffer:{getChannelData:()=>loud}});
  clock=520;processor.onaudioprocess({inputBuffer:{getChannelData:()=>loud}});
  const interimRequest=worker.messages.findLast(message=>message.type==='transcribe'&&!message.final);
  if(!interimRequest)failures.push('Live microphone audio was not submitted for an interim on-device transcript');
  else worker.emit({type:'transcript',sessionId:interimRequest.sessionId,requestId:interimRequest.requestId,segmentId:interimRequest.segmentId,final:false,text:'Waited for'});
  if(voiceNotes.value!=='Existing note.\nWaited for'||!voiceBars.some(bar=>Number.parseInt(bar.style.height,10)>2))failures.push('On-device Whisper did not render the live transcript or audio-level waveform');
  const quiet=new Float32Array(4096);
  clock=1600;processor.onaudioprocess({inputBuffer:{getChannelData:()=>quiet}});
  const finalRequest=worker.messages.findLast(message=>message.type==='transcribe'&&message.final);
  if(!finalRequest)failures.push('Silence did not commit the current on-device utterance');
  else worker.emit({type:'transcript',sessionId:finalRequest.sessionId,requestId:finalRequest.requestId,segmentId:finalRequest.segmentId,final:true,text:'Waited for confirmation'});
  if(voiceNotes.value!=='Existing note.\nWaited for confirmation')failures.push('Final on-device transcript did not replace its interim text without duplication');
  controller.stop({immediate:true});
  if(!trackStopped||activeSession!==null||voiceButton.attributes['aria-pressed']!=='false'||!/review it.*saving/i.test(voiceStatus.textContent))failures.push('On-device dictation did not stop microphone capture and return to review-before-save');
  voiceNotes.value='Manual edit';
  await controller.toggle('dj-notes');
  await new Promise(resolve=>setImmediate(resolve));
  listeners.input?.();
  if(activeSession!==null||voiceNotes.value!=='Manual edit')failures.push('Direct user input did not stop dictation while preserving the edit');
  if(!/permission/i.test(controller.errorMessage('not-allowed')))failures.push('On-device dictation does not explain blocked microphone permission');
  if(controller.capability().available!==true)failures.push('Supported secure browser was incorrectly rejected by on-device dictation');
  const insecure=fixtureContext.createEdgebookDictationController({
    root:{...fixtureRoot,isSecureContext:false},document:voiceDocument,navigator:{mediaDevices:{getUserMedia(){}}},WorkerClass:FakeWorker,AudioContextClass:FakeAudioContext,
  });
  if(insecure.capability().available||!/HTTPS/i.test(insecure.capability().message))failures.push('Insecure origins are not rejected before microphone/model access');
  controller.destroy();
} catch (error) {
  failures.push(`On-device dictation fixture failed: ${error.message}`);
}

try {
  let queuedTimer=null,saveCalls=0;
  const autoSaveSource=sourceBetween('let djAutoSaveTimer', 'async function djSaveForm');
  const {context,exports:autoSave}=evaluateSecurityFixture(
    autoSaveSource,
    {
      dictationSession:{spec:{context:'dailyjournal'}},
      clearTimeout(){},setTimeout(fn){queuedTimer=fn;return 7;},
      djDate:'2026-08-09',djCollectForm:()=>({notes:'draft'}),
      async djSaveEntry(){saveCalls+=1;return true;},
      document:{getElementById:()=>null},renderDjFeed(){},
    },
    '{djAutoSave,getTimer:()=>djAutoSaveTimer}',
  );
  autoSave.djAutoSave();await queuedTimer();
  if(saveCalls!==0||autoSave.getTimer()!==null)failures.push('Daily Journal autosave did not drop a pending callback while dictation was active');
  context.dictationSession=null;autoSave.djAutoSave();await queuedTimer();
  if(saveCalls!==1)failures.push('Daily Journal autosave did not resume after dictation ended and the user blurred again');
} catch(error){
  failures.push(`Daily-journal autosave/dictation fixture failed: ${error.message}`);
}

const coachingFunctions = app.match(/function coachingLabel[\s\S]*?(?=\nasync function openAIReport)/)?.[0];
if (!coachingFunctions) {
  failures.push('Local coaching functions could not be isolated for runtime verification');
} else {
  let coachingDegraded = false;
  const coachingContext = {
    tradesForContext: () => [
      { date: '2026-08-01', entryTime: '09:30', pnl: 120, accountId: 'acct_1', strategy: 'Breakout', emotion: 'Calm' },
      { date: '2026-08-02', entryTime: '13:15', pnl: -50, accountId: 'acct_1', strategy: 'Pullback', emotion: 'Anxious' },
      { date: '2026-08-03', entryTime: '09:45', pnl: 80, accountId: 'acct_1', strategy: 'Breakout', emotion: 'Calm' },
    ],
    activePageAcct: { analytics: 'all' },
    FxRates: { toUSD: amount => amount },
    acctCur: () => '$',
    tradePnlInAccountCurrency: (trade, value = trade?.pnl) => Number(value),
    tradePnlToUSD: (trade, value = trade?.pnl) => Number(value),
    getAccount: () => null,
    compareTradeChronology: (left, right) => `${left?.date || ''}T${left?.entryTime || ''}`.localeCompare(`${right?.date || ''}T${right?.entryTime || ''}`),
    tradeIsOpen: trade => trade?.isOpen === true || (trade?.isOpen == null && trade?.exit == null && trade?.pnl == null),
    tradeHasPnl: trade => trade?.pnl !== null && trade?.pnl !== undefined && Number.isFinite(Number(trade.pnl)),
    tradeIsClosedWithPnl: trade => !(trade?.isOpen === true || (trade?.isOpen == null && trade?.exit == null && trade?.pnl == null)) && trade?.pnl !== null && trade?.pnl !== undefined && Number.isFinite(Number(trade.pnl)),
    financialCoverageForTrades: () => ({ overallComplete: true, conversionUnavailableCount: 0 }),
    financialCoverageIssueText: coverage => coverage.overallComplete ? '' : 'one broker value is unavailable',
    financialScopeForTrades: source => ({ included: source.map(trade => ({ trade, presentation: { amount:Number(trade.pnl) } })) }),
    financialDisplayViewForTrades: source => ({
      degraded: coachingDegraded,
      estimatedCount: coachingDegraded ? 1 : 0,
      conversionUnavailableCount: 0,
      coverage: { overallComplete: !coachingDegraded },
      closedRows: source.map(trade => ({ trade, displayPnl: Number(trade.pnl), financialDisplayKind: coachingDegraded ? 'estimated_gross' : 'manual_reported' })),
    }),
    financialDisplayViewNotice: () => 'Exact broker Overall P&L remains withheld; mixed provisional values are shown.',
  };
  vm.createContext(coachingContext);
  try {
    vm.runInContext(`${coachingFunctions}
      globalThis.reports = ['edge','time','behaviour','setup','drawdown','montecarlo'].map(buildLocalCoachingReport);
      globalThis.repeatReport = buildLocalCoachingReport('edge');`, coachingContext);
    if (coachingContext.reports.some(report => typeof report !== 'string' || !report.includes('## KEY INSIGHT'))) {
      failures.push('A local coaching report did not produce its required key-insight section');
    }
    if (coachingContext.reports[0] !== coachingContext.repeatReport) {
      failures.push('Local coaching report generation is not deterministic');
    }
    coachingDegraded = true;
    vm.runInContext(`globalThis.incompleteReport=buildLocalCoachingReport('edge');`, coachingContext);
    if (!/mixed provisional[\s\S]*exact broker Overall P&L remains withheld/i.test(coachingContext.incompleteReport)) failures.push('Local coaching report did not label degraded metrics while keeping exact Overall withheld');
  } catch (error) {
    failures.push(`Local coaching report runtime failed: ${error.message}`);
  }
}

// No active Zerodha integration may remain in the app. Historical source
// labels and CSV import support intentionally stay available.
for (const identifier of [
  'ZERODHA_FN',
  'connectZerodha',
  'syncZerodha',
  'disconnectZerodha',
  'checkZerodha',
  'restoreZerodha',
  'reconcileZerodha',
]) {
  rejectMatch(app, new RegExp(`\\b${identifier}\\b`), `live Zerodha hook ${identifier}`);
}
requireMatch(app, /badge-src-zerodha/, 'historical Zerodha source badge');
requireMatch(app, /BROKER_PROFILES\s*=\s*\{[\s\S]*?zerodha\s*:/, 'Zerodha CSV profile');
requireMatch(app, /const source\s*=\s*csvState\.selectedBroker\s*===\s*['"]zerodha['"]\s*\?\s*['"]zerodha['"]\s*:\s*['"]csv['"]/, 'historical Zerodha import provenance');

rejectMatch(marketing, /Works with Zerodha/i, 'live Zerodha compatibility claim');
rejectMatch(marketing, /Import directly from Zerodha/i, 'direct Zerodha import claim');
requireMatch(marketing, /Import broker CSV exports/i, 'CSV import marketing copy');

// Exercise cursor traversal so a future adapter edit cannot quietly return
// only the first page of a larger journal.
const requestedTradePages = [];
const pagedData = createVpsDataAdapter({
  async get(requestPath) {
    requestedTradePages.push(requestPath);
    return requestedTradePages.length === 1
      ? { trades: [{ id: 'one' }], nextCursor: 'page-2' }
      : { trades: [{ id: 'two' }], nextCursor: null };
  },
});
const pagedTrades = await pagedData.trades.list();
if (pagedTrades.map(trade => trade.id).join(',') !== 'one,two') {
  failures.push('Trade pagination did not combine every page');
}
if (!requestedTradePages[1]?.includes('cursor=page-2')) {
  failures.push('Trade pagination did not send nextCursor to the API');
}

let repeatedCursorRejected = false;
try {
  const repeatedCursorData = createVpsDataAdapter({
    get: async () => ({ trades: [], nextCursor: 'same-cursor' }),
  });
  await repeatedCursorData.trades.list();
} catch (error) {
  repeatedCursorRejected = /repeated trade cursor/.test(error.message);
}
if (!repeatedCursorRejected) failures.push('Repeated trade cursors are not rejected');

// The healthy path creates a VPS adapter, while an unavailable VPS API fails
// closed without accepting obsolete fallback options.
const healthyVpsAuth = await createAuthAdapter({
  api: {
    setCsrfToken() {},
    async get(requestPath) {
      if (requestPath === '/config') return { dataApiReady: true, googleClientId: 'google-client' };
      if (requestPath === '/auth/session') return { user: null, csrfToken: 'csrf' };
      throw new Error(`Unexpected auth request ${requestPath}`);
    },
  },
  config: { googleClientId: 'override-client' },
});
if (healthyVpsAuth.mode !== 'vps') failures.push('Healthy VPS auth did not select the sole VPS mode');

let unavailableVpsRejected = false;
try {
  await createAuthAdapter({
    api: { get: async () => ({ dataApiReady: false }) },
    config: { enableFirebaseFallback: true },
  });
} catch (error) {
  unavailableVpsRejected = /VPS data API is not marked ready/.test(error.message);
}
if (!unavailableVpsRejected) failures.push('VPS-only auth did not fail closed when the data API was unavailable');

// Exercise every frontend cTrader contract, including the legacy account ID
// mapping. This intentionally contains no absolute broker/Firebase URLs.
const ctraderCalls = [];
const ctraderApi = {
  async get(requestPath) {
    ctraderCalls.push({ method: 'GET', path: requestPath });
    if (requestPath === '/config') return { ctraderEnabled: true, ctraderOAuthEnabled: false, ctraderMcpEnabled: true };
    if (requestPath === '/ctrader/oauth/pending') return { grantId: 'grant-1', accounts: [{ ctidTraderAccountId: '42' }] };
    if (requestPath === '/ctrader/connections') return { connections: [{ id: 'connection-1', lastSyncStatus: 'succeeded' }] };
    if (requestPath.endsWith('/status')) return { connection: { id: 'connection-1', lastSyncStatus: 'running' } };
    if (requestPath.endsWith('/live-reconciliation')) return { candidates: [] };
    return {};
  },
  async post(requestPath, body, options) {
    ctraderCalls.push({ method: 'POST', path: requestPath, body, options });
    if (requestPath === '/ctrader/oauth/start') return { authorizationUrl: 'https://id.ctrader.com/my/settings/openapi/grantingaccess/', expiresAt: '2026-08-09T00:00:00Z' };
    if (requestPath === '/ctrader/mcp/connect') return { connection: { id: 'mcp-connection-1', authMode: 'remote_mcp' } };
    if (requestPath === '/ctrader/connections') return { connection: { id: 'connection-1' } };
    if (requestPath.endsWith('/sync')) return { syncRunId: 'sync-1', status: 'queued' };
    if (requestPath.endsWith('/live-reconciliation/00000000-0000-4000-8000-000000000075/resolve')) return { candidate: { id: '00000000-0000-4000-8000-000000000075', status: 'linked' } };
    return null;
  },
};
const ctraderData = createVpsDataAdapter(ctraderApi);
const ctraderConfig = await ctraderData.ctrader.config();
await ctraderData.ctrader.startOAuth();
await ctraderData.ctrader.connectMcp({
  configuration: '{"mcpServers":{"ctrader":{"token":"fixture-secret"}}}',
  accountId: '42',
  environment: 'live',
  mappedLegacyAccountId: 'acct_1',
  label: 'The5ers',
  acknowledgeTradingCredentialRisk: true,
  acknowledgeNoOpenPositionsAtConnect: true,
});
await ctraderData.ctrader.pendingOAuth();
await ctraderData.ctrader.list();
await ctraderData.ctrader.create({ grantId: 'grant-1', ctidTraderAccountId: '42', mappedLegacyAccountId: 'acct_1', label: 'Demo' });
await ctraderData.ctrader.status('connection-1');
await ctraderData.ctrader.sync('connection-1');
await ctraderData.ctrader.listLiveReconciliation('connection-1');
await ctraderData.ctrader.resolveLiveCandidate('connection-1', '00000000-0000-4000-8000-000000000075', {
  action: 'link_manual',
  version: 3,
  clientRequestId: '77777777-7777-4777-8777-777777777777',
  manualTradeId: '00000000-0000-4000-8000-000000000076',
});
await ctraderData.ctrader.disconnect('connection-1');
const ctraderCreate = ctraderCalls.find(call => call.method === 'POST' && call.path === '/ctrader/connections');
if (ctraderCreate?.body?.mappedLegacyAccountId !== 'acct_1') failures.push('cTrader legacy account mapping was not forwarded');
if (ctraderConfig?.enabled !== false || ctraderConfig?.mcpEnabled !== true) failures.push('cTrader OAuth and MCP capabilities were not normalized independently');
const ctraderMcpConnect = ctraderCalls.find(call => call.method === 'POST' && call.path === '/ctrader/mcp/connect');
if (ctraderMcpConnect?.body?.accountId !== '42' || ctraderMcpConnect?.body?.environment !== 'live' || ctraderMcpConnect?.body?.mappedLegacyAccountId !== 'acct_1' || ctraderMcpConnect?.body?.label !== 'The5ers' || ctraderMcpConnect?.body?.acknowledgeTradingCredentialRisk !== true || ctraderMcpConnect?.body?.acknowledgeNoOpenPositionsAtConnect !== true || !ctraderMcpConnect?.body?.configuration) {
  failures.push('cTrader Remote MCP connection payload was not forwarded exactly');
}
const liveResolve = ctraderCalls.find(call => call.method === 'POST' && call.path.endsWith('/live-reconciliation/00000000-0000-4000-8000-000000000075/resolve'));
if (liveResolve?.body?.manualTradeId !== '00000000-0000-4000-8000-000000000076' || liveResolve?.body?.version !== 3 ||
    liveResolve?.options?.headers?.['if-match'] !== '"3"' || liveResolve?.options?.headers?.['idempotency-key'] !== '77777777-7777-4777-8777-777777777777') {
  failures.push('Live cTrader reconciliation decision did not send exact manual choice, version, and idempotency preconditions');
}
for (const expectedPath of [
  '/ctrader/oauth/start',
  '/ctrader/mcp/connect',
  '/ctrader/oauth/pending',
  '/ctrader/connections',
  '/ctrader/connections/connection-1/status',
  '/ctrader/connections/connection-1/sync',
  '/ctrader/connections/connection-1/live-reconciliation',
  '/ctrader/connections/connection-1/live-reconciliation/00000000-0000-4000-8000-000000000075/resolve',
  '/ctrader/connections/connection-1/disconnect',
]) {
  if (!ctraderCalls.some(call => call.path === expectedPath)) failures.push(`Missing cTrader adapter call ${expectedPath}`);
}

// A lost live-resolution response is accepted only when the canonical row
// carries the exact action and client request identity from this attempt.
const liveCandidateId = '00000000-0000-4000-8000-000000000077';
const liveRequestId = '88888888-8888-4888-8888-888888888888';
let canonicalLiveCandidate = {
  id: liveCandidateId,
  version: 4,
  status: 'pending',
  allowedActions: ['link_manual'],
  resolutionAction: null,
  resolutionClientRequestId: null,
};
let proveLiveResolution = true;
const liveRecoveryCalls = [];
const liveRecoveryData = createVpsDataAdapter({
  async get(requestPath) {
    liveRecoveryCalls.push({ method: 'GET', path: requestPath });
    return { candidate: canonicalLiveCandidate };
  },
  async post(requestPath, body, options) {
    liveRecoveryCalls.push({ method: 'POST', path: requestPath, body, options });
    canonicalLiveCandidate = {
      ...canonicalLiveCandidate,
      version: 5,
      status: 'linked',
      resolutionAction: body.action,
      resolutionClientRequestId: proveLiveResolution ? body.clientRequestId : null,
    };
    const error = new Error('live decision response lost after commit');
    error.code = 'NETWORK_ERROR';
    throw error;
  },
});
const recoveredLive = await liveRecoveryData.ctrader.resolveLiveCandidate('connection-1', liveCandidateId, {
  action: 'link_manual',
  version: 4,
  clientRequestId: liveRequestId,
  manualTradeId: '00000000-0000-4000-8000-000000000078',
});
if (!recoveredLive?.recoveredAfterAmbiguousResponse || recoveredLive?.candidate?.resolutionClientRequestId !== liveRequestId) {
  failures.push('Live cTrader decision did not recover a lost response from the exact canonical request identity');
}
if (!liveRecoveryCalls.some(call => call.method === 'GET'
  && call.path.endsWith(`/live-reconciliation/${liveCandidateId}`))) {
  failures.push('Live cTrader lost-response recovery did not use the exact tenant-scoped candidate detail route');
}
proveLiveResolution = false;
let rejectedUnprovenLiveResolution = false;
try {
  await liveRecoveryData.ctrader.resolveLiveCandidate('connection-1', liveCandidateId, {
    action: 'link_manual',
    version: 5,
    clientRequestId: '99999999-9999-4999-8999-999999999999',
    manualTradeId: '00000000-0000-4000-8000-000000000078',
  });
} catch (error) {
  rejectedUnprovenLiveResolution = error?.latestCandidate?.resolutionClientRequestId === null;
}
if (!rejectedUnprovenLiveResolution) failures.push('Live cTrader decision recovery accepted a row without the exact request identity');
let rejectedMissingLiveVersion = false;
try {
  await liveRecoveryData.ctrader.resolveLiveCandidate('connection-1', liveCandidateId, {
    action: 'reject', version: null, clientRequestId: liveRequestId,
  });
} catch (error) { rejectedMissingLiveVersion = error?.code === 'VERSION_REQUIRED'; }
if (!rejectedMissingLiveVersion) failures.push('Live cTrader decision did not fail closed without a positive candidate version');

// Historical preview and per-candidate decisions retain one idempotency key
// across a lost response, then accept only the matching canonical server row.
const historicalCalls = [];
let canonicalHistoricalImport = null;
let omitCanonicalHistoricalRequestId = false;
let canonicalHistoricalCandidate = {
  id: 'candidate-1',
  version: 3,
  status: 'pending',
  allowedActions: ['link_manual'],
};
let omitCanonicalResolutionRequestId = false;
const historicalApi = {
  async get(requestPath) {
    historicalCalls.push({ method: 'GET', path: requestPath });
    if (requestPath.endsWith('/historical-imports/current')) return { historicalImport: canonicalHistoricalImport };
    if (requestPath.includes('/reconciliation?')) return { historicalImport: canonicalHistoricalImport, candidates: [canonicalHistoricalCandidate] };
    return {};
  },
  async post(requestPath, body, options) {
    historicalCalls.push({ method: 'POST', path: requestPath, body: JSON.parse(JSON.stringify(body)), options });
    if (requestPath.endsWith('/historical-imports')) {
      canonicalHistoricalImport = {
        id: 'import-1',
        status: 'queued',
        ...body,
        clientRequestId: omitCanonicalHistoricalRequestId ? null : body.clientRequestId,
      };
      const error = new Error('historical preview response lost after commit');
      error.code = 'NETWORK_ERROR';
      throw error;
    }
    if (requestPath.endsWith('/candidate-1/resolve')) {
      canonicalHistoricalCandidate = {
        ...canonicalHistoricalCandidate,
        status: 'linked',
        version: 4,
        resolutionAction: body.action,
        resolutionClientRequestId: omitCanonicalResolutionRequestId ? null : body.clientRequestId,
      };
      const error = new Error('historical decision response lost after commit');
      error.status = 500;
      throw error;
    }
    return {};
  },
};
const historicalData = createVpsDataAdapter(historicalApi);
const historyRequestId = '11111111-1111-4111-8111-111111111111';
const historyBoundary = {
  boundaryLocal: '2026-08-11T00:00',
  timeZone: 'Asia/Kolkata',
  boundaryAt: '2026-08-10T18:30:00.000Z',
  acknowledgeNoOpenPositionsAtBoundary: true,
  clientRequestId: historyRequestId,
};
const recoveredHistory = await historicalData.ctrader.startHistoricalPreview('connection-1', historyBoundary);
const resolutionRequestId = '22222222-2222-4222-8222-222222222222';
const recoveredResolution = await historicalData.ctrader.resolveHistoricalCandidate('connection-1', 'candidate-1', {
  action: 'link_manual',
  version: 3,
  importId: 'import-1',
  clientRequestId: resolutionRequestId,
});
const historyPost = historicalCalls.find(call => call.method === 'POST' && call.path.endsWith('/historical-imports'));
const resolutionPost = historicalCalls.find(call => call.method === 'POST' && call.path.endsWith('/candidate-1/resolve'));
if (!recoveredHistory?.recoveredAfterAmbiguousResponse || recoveredHistory?.historicalImport?.clientRequestId !== historyRequestId ||
    historyPost?.options?.headers?.['idempotency-key'] !== historyRequestId || historyPost?.body?.boundaryAt !== historyBoundary.boundaryAt ||
    historyPost?.body?.acknowledgeNoOpenPositionsAtBoundary !== true) {
  failures.push('Lost historical-preview response was not reconciled by exact boundary, acknowledgement, and idempotency key');
}
if (!recoveredResolution?.recoveredAfterAmbiguousResponse || recoveredResolution?.candidate?.status !== 'linked' ||
    resolutionPost?.options?.headers?.['idempotency-key'] !== resolutionRequestId || resolutionPost?.options?.headers?.['if-match'] !== '"3"' ||
    resolutionPost?.body?.action !== 'link_manual') {
  failures.push('Lost historical decision response was not reconciled with idempotency and optimistic concurrency');
}

// A canonical row without the exact resolution request ID is not proof that
// this ambiguous write committed; it may be an older decision from elsewhere.
canonicalHistoricalCandidate = {
  ...canonicalHistoricalCandidate,
  status: 'linked',
  resolutionAction: 'link_manual',
  resolutionClientRequestId: null,
};
omitCanonicalResolutionRequestId = true;
let rejectedUnprovenResolution = false;
try {
  await historicalData.ctrader.resolveHistoricalCandidate('connection-1', 'candidate-1', {
    action: 'link_manual',
    version: 3,
    importId: 'import-1',
    clientRequestId: '33333333-3333-4333-8333-333333333333',
  });
} catch (error) {
  rejectedUnprovenResolution = error?.latestCandidate?.resolutionClientRequestId === null;
}
if (!rejectedUnprovenResolution) {
  failures.push('Historical decision recovery accepted a canonical row without the exact client request ID');
}

// Matching boundary data alone cannot prove which historical-start request
// committed after a lost response; only the server's exact request ID can.
canonicalHistoricalImport = {
  ...canonicalHistoricalImport,
  clientRequestId: null,
};
omitCanonicalHistoricalRequestId = true;
let rejectedUnprovenHistoricalStart = false;
try {
  await historicalData.ctrader.startHistoricalPreview('connection-1', {
    ...historyBoundary,
    clientRequestId: '44444444-4444-4444-8444-444444444444',
  });
} catch (error) {
  rejectedUnprovenHistoricalStart = error?.latestHistoricalImport?.clientRequestId === null;
}
if (!rejectedUnprovenHistoricalStart) {
  failures.push('Historical-preview recovery accepted a canonical row without the exact client request ID');
}

// Screenshot uploads replay the exact multipart request after an ambiguous
// response. The stable UUID survives the retry so the server can return its
// already-owned file instead of creating a second row/object.
const screenshotCalls = [];
const screenshotRequestId = '55555555-5555-4555-8555-555555555555';
const screenshotFile = new Blob(['chart-fixture'], { type: 'image/png' });
let loseScreenshotResponse = true;
const screenshotData = createVpsDataAdapter({
  async post(requestPath, body, options) {
    screenshotCalls.push({ requestPath, body, options });
    if (loseScreenshotResponse) {
      loseScreenshotResponse = false;
      const error = new Error('screenshot response lost after commit');
      error.code = 'NETWORK_ERROR';
      throw error;
    }
    return { file: { id: 'file-1', tradeRecordId: 'trade-1' } };
  },
});
const recoveredScreenshot = await screenshotData.screenshots.upload('trade-1', screenshotFile, {
  idempotencyKey: screenshotRequestId,
});
if (recoveredScreenshot?.file?.id !== 'file-1' || screenshotCalls.length !== 2 ||
    screenshotCalls.some(call => call.options?.headers?.['idempotency-key'] !== screenshotRequestId) ||
    screenshotCalls.some(call => !(call.body instanceof FormData))) {
  failures.push('Lost screenshot response did not replay the exact stable idempotency request');
}

// Verify exact response wrappers and optimistic concurrency propagation.
const contractCalls = [];
const contractApi = {
  async get(requestPath) {
    contractCalls.push({ method: 'GET', path: requestPath });
    if (requestPath === '/settings') return { settings: { theme: 'dark' }, version: 4 };
    if (requestPath.startsWith('/journals?')) return { entries: [{ id: '2026-08-08', date: '2026-08-08', entry: { note: 'x' }, version: 2 }] };
    return {};
  },
  async put(requestPath, body, options) {
    contractCalls.push({ method: 'PUT', path: requestPath, body, options });
    if (requestPath === '/settings') return { settings: body.settings, version: 5 };
    return { journal: { date: '2026-08-08', entry: body.entry, version: 3 } };
  },
  async delete(requestPath, options) {
    contractCalls.push({ method: 'DELETE', path: requestPath, options });
    return requestPath.endsWith('/permanent') ? null : { trade: { id: 'trade-1', version: 8 } };
  },
  async post(requestPath, body, options) {
    contractCalls.push({ method: 'POST', path: requestPath, body, options });
    return { trade: { id: 'trade-1', version: 8 } };
  },
  async patch(requestPath, body, options) {
    contractCalls.push({ method: 'PATCH', path: requestPath, body, options });
    return { trade: { ...body.trade, id: 'trade-1', version: 8 } };
  },
};
const contractData = createVpsDataAdapter(contractApi);
await contractData.settings.get();
await contractData.settings.put({ theme: 'light' });
const journals = await contractData.journals.list();
await contractData.journals.put('2026-08-08', { note: 'updated' });
await contractData.trades.patch('trade-1', { notes: 'updated', version: 7 });
await contractData.trades.softDelete('trade-1', 7);
await contractData.trades.restore('trade-1', 7);
await contractData.trades.permanentDelete('trade-1', 7);

if (journals[0]?.entry?.note !== 'x') failures.push('Journal entries wrapper is not consumed');
const settingsPut = contractCalls.find(call => call.method === 'PUT' && call.path === '/settings');
if (settingsPut?.body?.version !== 4) failures.push('Settings version is not propagated');
const journalPut = contractCalls.find(call => call.method === 'PUT' && call.path.startsWith('/journals/'));
if (journalPut?.body?.version !== 2) failures.push('Journal version is not propagated');
const versionedMutations = contractCalls.filter(call =>
  (call.method === 'PATCH' && call.path.includes('/trades/')) ||
  (call.method === 'DELETE' && call.path.includes('/trades/')) ||
  (call.method === 'POST' && call.path.endsWith('/restore'))
);
if (versionedMutations.some(call => call.options?.headers?.['if-match'] !== '"7"')) {
  failures.push('Trade mutation If-Match headers are missing');
}
const permanentDelete = contractCalls.find(call => call.path.endsWith('/permanent'));
if (permanentDelete?.options?.headers?.['x-confirm-permanent-delete'] !== 'trade-1') {
  failures.push('Permanent-delete confirmation header is missing');
}

// A create response can disappear after commit. The adapter must reconcile by
// the stable browser ID instead of telling the user to submit a new trade.
let tradeCreatePosts = 0;
let tradeCreateRecoveryReads = 0;
let tradeCreateHeader = null;
const lostResponseTrade = {
  id: 'browser-draft-1', date: '2026-08-09', symbol: 'GOLD', asset: 'cm',
  direction: 'Long', entry: 4144, exit: 4150, size: 0.1,
  accountId: null, instrument: null, optionType: null,
};
const recoveredTradeCreate = createVpsDataAdapter({
  async post(requestPath, body, options) {
    tradeCreatePosts += 1;
    tradeCreateHeader = options?.headers?.['idempotency-key'];
    const error = new Error('response lost after commit');
    error.code = 'NETWORK_ERROR';
    throw error;
  },
  async get(requestPath) {
    if (requestPath !== '/trades/browser-draft-1') return {};
    tradeCreateRecoveryReads += 1;
    return { trade: { ...lostResponseTrade, version: 1 } };
  },
});
const recoveredTrade = await recoveredTradeCreate.trades.create(lostResponseTrade);
if (recoveredTrade?.trade?.id !== 'browser-draft-1' || tradeCreatePosts !== 1 || tradeCreateRecoveryReads !== 1 || tradeCreateHeader !== 'trade:browser-draft-1') {
  failures.push('Lost trade-create response was not reconciled with the stable idempotency ID');
}

// Recovery must compare every normalized outbound user field. A same-ID row
// that differs only in a previously omitted financial, journal, timing,
// provenance, or broker field is not proof that this request committed.
const richLostTrade = {
  ...lostResponseTrade,
  pnl: 600,
  entryTime: '10:05:30',
  exitTime: '10:25:45',
  source: 'manual',
  sourceSystem: 'manual',
  ingestionMethod: 'manual',
  psychology: { confidence: 8, preTradeThought: 'patient' },
  custom: { setupGrade: 'A' },
  brokerData: { providerRef: 'verified-1' },
};
for (const [label, canonicalChange] of [
  ['P&L', { pnl: 601 }],
  ['psychology', { psychology: { confidence: 2, preTradeThought: 'patient' } }],
  ['time', { entryTime: '10:06' }],
  ['source', { source: 'csv', sourceSystem: 'csv', ingestionMethod: 'csv' }],
  ['broker data', { brokerData: { providerRef: 'different' } }],
]) {
  let recoveryReads = 0;
  const data = createVpsDataAdapter({
    async post() {
      const error = new Error('create response lost after commit');
      error.code = 'NETWORK_ERROR';
      throw error;
    },
    async get() {
      recoveryReads += 1;
      return { trade: { ...richLostTrade, ...canonicalChange, version: 1 } };
    },
  });
  let rejected = false;
  try { await data.trades.create(richLostTrade); }
  catch (error) { rejected = error?.latestTrade != null; }
  if (!rejected || recoveryReads !== 1) {
    failures.push(`Lost trade-create recovery accepted a same-ID row with different ${label}`);
  }
}

let conflictRecoveryReads = 0;
const conflictingTradeCreate = createVpsDataAdapter({
  async post() {
    const error = new Error('idempotency conflict');
    error.status = 409;
    throw error;
  },
  async get() { conflictRecoveryReads += 1; return { trade: lostResponseTrade }; },
});
let createConflictRejected = false;
try { await conflictingTradeCreate.trades.create(lostResponseTrade); }
catch (error) { createConflictRejected = error?.status === 409; }
if (!createConflictRejected || conflictRecoveryReads !== 0) {
  failures.push('Trade-create recovery treated a deterministic 409 conflict as an ambiguous commit');
}

// The first journal-date edit of an older cTrader row may atomically backfill
// locked providerTradeDate metadata. A lost PATCH response must compare only
// user-owned journal fields, while still rejecting a different canonical date.
const cTraderDatePatch = {
  id: 'ctrader-trade-1', version: 4, source: 'ctrader', sourceSystem: 'ctrader',
  brokerConnectionId: '00000000-0000-4000-8000-000000000099',
  date: '2026-08-12', sl: 4135, tp: 4170, notes: 'reviewed',
  psychology: { review: 'patient exit' }, custom: { setupGrade: 'A' },
  symbol: 'XAUUSD', entry: 4144, exit: 4150, size: 0.02,
  brokerData: { provider: 'ctrader', positionId: '4556640' },
};
const cTraderPatchAdapter = canonicalDate => createVpsDataAdapter({
  async patch() {
    const error = new Error('PATCH response lost after commit');
    error.code = 'NETWORK_ERROR';
    throw error;
  },
  async get() {
    return { trade: {
      ...cTraderDatePatch,
      date: canonicalDate,
      version: 5,
      entry: 4144.5,
      brokerData: { ...cTraderDatePatch.brokerData, providerTradeDate: '2026-08-11' },
    } };
  },
});
const recoveredCTraderDate = await cTraderPatchAdapter('2026-08-12').trades.patch('ctrader-trade-1', cTraderDatePatch);
if (recoveredCTraderDate?.trade?.date !== '2026-08-12' || recoveredCTraderDate?.trade?.brokerData?.providerTradeDate !== '2026-08-11') {
  failures.push('Lost cTrader journal-date PATCH did not accept canonical provider metadata backfill');
}
let mismatchedCTraderDateRejected = false;
try { await cTraderPatchAdapter('2026-08-13').trades.patch('ctrader-trade-1', cTraderDatePatch); }
catch (error) { mismatchedCTraderDateRejected = error?.latestTrade?.date === '2026-08-13'; }
if (!mismatchedCTraderDateRejected) failures.push('Lost cTrader journal-date PATCH accepted a different canonical journal date');

// A network error after commit is reconciled by reading the authoritative
// settings value. This avoids retrying with a stale version and reporting a
// false failure for a write PostgreSQL already accepted.
let settingsRecoveryReads = 0;
const recoveredSettings = createVpsDataAdapter({
  async get(requestPath) {
    if (requestPath !== '/settings') return {};
    settingsRecoveryReads += 1;
    return settingsRecoveryReads === 1
      ? { settings: { theme: 'dark' }, version: 1 }
      : { settings: { theme: 'light' }, version: 2 };
  },
  async put() {
    const error = new Error('response lost');
    error.code = 'NETWORK_ERROR';
    throw error;
  },
});
await recoveredSettings.settings.get();
const reconciled = await recoveredSettings.settings.put({ theme: 'light' });
if (reconciled?.theme !== 'light' || settingsRecoveryReads !== 2) {
  failures.push('Lost settings response was not reconciled against the server');
}

// A failed initial settings read must never be followed by a lazy version read
// that stamps the newest version onto a stale browser snapshot.
let unsafeSettingsPuts = 0;
const unbasedSettings = createVpsDataAdapter({
  async get() { throw new Error('initial settings read failed'); },
  async put() { unsafeSettingsPuts += 1; return {}; },
});
try { await unbasedSettings.settings.get(); } catch {}
let baselineError = null;
try { await unbasedSettings.settings.put({ theme: 'stale-cache' }); }
catch (error) { baselineError = error; }
if (baselineError?.code !== 'SETTINGS_BASELINE_REQUIRED' || unsafeSettingsPuts !== 0) {
  failures.push('Settings write proceeded without a verified remote baseline');
}

// Journal writes use the same canonical-read reconciliation, then carry the
// refreshed optimistic-concurrency version into a later edit.
let journalCanonical = { date: '2026-08-09', entry: { notes: 'before' }, version: 1 };
let journalRecoveryReads = 0;
const journalRecoveryPuts = [];
const recoveredJournals = createVpsDataAdapter({
  async get(requestPath) {
    if (requestPath.startsWith('/journals?')) return { entries: [journalCanonical] };
    if (requestPath === '/journals/2026-08-09') {
      journalRecoveryReads += 1;
      return { journal: journalCanonical };
    }
    return {};
  },
  async put(requestPath, body) {
    journalRecoveryPuts.push({ requestPath, body: JSON.parse(JSON.stringify(body)) });
    journalCanonical = { date: '2026-08-09', entry: body.entry, version: journalCanonical.version + 1 };
    if (journalRecoveryPuts.length === 1) {
      const error = new Error('journal response lost after commit');
      error.code = 'NETWORK_ERROR';
      throw error;
    }
    return { journal: journalCanonical };
  },
});
await recoveredJournals.journals.list();
const recoveredJournal = await recoveredJournals.journals.put('2026-08-09', { notes: 'committed despite lost response' });
const laterJournal = await recoveredJournals.journals.put('2026-08-09', { notes: 'later edit' });
if (recoveredJournal?.notes !== 'committed despite lost response' || laterJournal?.notes !== 'later edit' || journalRecoveryReads !== 1 || journalRecoveryPuts[1]?.body?.version !== 2) {
  failures.push('Lost journal response was not reconciled before a later edit');
}

try {
  const exactBreakdownSource = sourceBetween('function cTraderExactPnlBreakdown', 'function cTraderProviderMoney');
  const vpsState = { connections: [], statuses: new Map(), live: { reviews: new Map(), errors: new Map(), loading: new Set() } };
  const { exports: financial } = evaluateSecurityFixture(
    `${positionSemanticsSource}\n${quantityProjectionSource}\n${calculatedGrossPresentationSource}\n${exactBreakdownSource}`,
    {
      vpsCtraderState: vpsState,
      S: { brokerAccountMap: {} },
      mappedAccountForCTraderConnection: connection => String(connection?.mappedAccountId || ''),
      acctCur: () => '$',
      normalizeFxCurrency: value => value === '$' || value === 'USD' ? 'USD' : /^[A-Z]{3}$/.test(String(value)) ? String(value) : null,
      FxRates: { toUSD: (amount, currency) => currency === 'USD' ? Number(amount) : Number.NaN },
      isRealIsoDate: value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)),
      tradeJournalDate: trade => String(trade?.date || '').slice(0, 10),
    },
    '{tradeFinancialPresentation,financialScopeForTrades,financialPresentationLedgerForTrades,financialCoverageForTrades,financialCoverageIssueText,financialDisplayViewForTrades,financialDisplayViewNotice,cTraderExactPnlBreakdown}',
  );
  const baseExact = {
    id: 'provider-exact', accountId: 'broker-account', source: 'ctrader', symbol: 'XAUUSD', pnl: 12.5, isOpen: false,
    date: '2026-08-17', exitAt: '2026-08-17T05:00:00.000Z', exact: { pnl: '12.50' },
    brokerData: { accountCurrency: 'USD', accountMoneyDigits: 2, pnlAuthority: 'provider', pnlMethod: 'provider_close_detail_money_digits', grossProfit: '14.00', commission: '-1.00', swap: '-0.25', pnlConversionFee: '0.25', pnlComponentsCoverage: { version: 1, source: 'ProtoOAClosePositionDetail', tradeLevelExact: true, grossProfit: true, brokerCommission: true, swap: true, pnlConversionFee: true, otherAccountCashFlowsIncluded: false, otherAccountCashFlowsAttribution: 'not_provided_by_position' }, realizedEvents: [{ executionId: 'close-a', executedAt: '2026-08-17T04:45:00.000Z', date: '2026-08-17', pnl: '5.00' }, { executionId: 'close-b', executedAt: '2026-08-17T05:00:00.000Z', date: '2026-08-17', pnl: '7.50' }] },
  };
  const exactPresentation = financial.tradeFinancialPresentation(baseExact);
  if (exactPresentation?.kind !== 'broker_exact_net' || !exactPresentation?.breakdown || exactPresentation.breakdown.net !== '12.50') failures.push('Complete provider close-detail net/breakdown was not accepted canonically');
  for (const method of ['provider_explicit_net_cents', 'provider_mixed_exact_money']) {
    const trade = { ...baseExact, id: method, brokerData: { ...baseExact.brokerData, pnlMethod: method, pnlComponentsCoverage: {}, grossProfit: null, commission: null, swap: null, pnlConversionFee: null } };
    const presentation = financial.tradeFinancialPresentation(trade);
    if (presentation?.kind !== 'broker_exact_net' || presentation.breakdown !== null) failures.push(`Provider exact-net-only method ${method} lost authority or fabricated components`);
  }
  const unavailableProvider = { ...baseExact, id: 'provider-unavailable', brokerData: { ...baseExact.brokerData, pnlAuthority: 'provider_unavailable' } };
  if (financial.tradeFinancialPresentation(unavailableProvider)?.kind !== 'manual_reported') failures.push('Provider-unavailable value was mislabeled broker-exact');
  const manual = { id: 'manual-1', accountId: 'broker-account', source: 'manual', pnl: -3, isOpen: false, date: '2026-08-17', exitAt: '2026-08-17T06:00:00.000Z', brokerData: { realizedEvents: [{ executionId: 'untrusted', date: '2020-01-01', pnl: -3 }] } };
  vpsState.connections = [{ id: 'connection-1', mappedAccountId: 'broker-account' }];
  let scope = financial.financialScopeForTrades([manual]);
  if (scope.included.length || scope.manualExcluded.length !== 1) failures.push('Mapped account with only withheld/manual rows leaked journal P&L into broker Overall');
  vpsState.connections = [];
  scope = financial.financialScopeForTrades([manual]);
  if (scope.included.length !== 1 || scope.included[0].presentation.kind !== 'manual_reported') failures.push('Manual-only journal account lost its journal-reported P&L');
  const manualLedger = financial.financialPresentationLedgerForTrades([manual]);
  if (manualLedger.length !== 1 || manualLedger[0].ledgerDate !== '2026-08-17' || manualLedger[0].realizedEvent?.ledgerFallback !== true) failures.push('Untrusted manual realized-event timing moved canonical journal P&L');
  const setHealthyConnection = () => {
    const connection = { id: 'connection-1', mappedAccountId: 'broker-account', connected: true, tradeHistoryComplete: true, tradeHistoryStartTimestamp: 1786930000000, tradeHistorySyncedThroughTimestamp: 1786943100000, lastSyncStatus: 'succeeded' };
    vpsState.connections = [connection];
    vpsState.statuses = new Map([['connection-1', { connection, tradeHistoryComplete: true, tradeHistoryStartTimestamp: 1786930000000, tradeHistorySyncedThroughTimestamp: 1786943100000, latestSyncRun: { status: 'succeeded', counters: {} } }]]);
    vpsState.live = { reviews: new Map([['connection-1', { candidates: [] }]]), errors: new Map(), loading: new Set() };
  };
  setHealthyConnection();
  const openPartial = { ...baseExact, id: 'open-partial', isOpen: true };
  const openLedger = financial.financialPresentationLedgerForTrades([openPartial]);
  const openCoverage = financial.financialCoverageForTrades([openPartial], { allAccounts: true });
  if (openLedger.length !== 2 || openLedger.reduce((sum, row) => sum + row.ledgerPnl, 0) !== 12.5 || openCoverage.overallNet !== 12.5) failures.push(`Open position partial closes do not tie between realized ledger and Overall P&L (${JSON.stringify({overall:openCoverage.overallNet,pending:openCoverage.pending})})`);
  const mismatched = { ...baseExact, id: 'mismatch', brokerData: { ...baseExact.brokerData, realizedEvents: [{ executionId: 'bad', date: '2026-08-16', pnl: '1.00' }] } };
  const mismatchLedger = financial.financialPresentationLedgerForTrades([mismatched]);
  if (mismatchLedger.length !== 1 || mismatchLedger[0].realizedEvent?.ledgerFallback !== true || mismatchLedger[0].ledgerPnl !== 12.5) failures.push('Non-reconciling provider events did not fall back to canonical exact net');
  const unsupported = { ...baseExact, id: 'unsupported-currency', brokerData: { ...baseExact.brokerData, accountCurrency: 'XYZ' } };
  const unsupportedCoverage = financial.financialCoverageForTrades([unsupported], { allAccounts: true });
  if (unsupportedCoverage.overallNet !== null || unsupportedCoverage.overallComplete || unsupportedCoverage.conversionUnavailableCount !== 1) failures.push('Unsupported currency silently disappeared into a partial/zero Overall P&L');

  const unavailable = { ...baseExact, id: 'missing-exact', pnl: null, exact: { ...baseExact.exact, pnl: null }, brokerData: { ...baseExact.brokerData, pnlAuthority: 'provider_unavailable' } };
  let coverage = financial.financialCoverageForTrades([baseExact, unavailable], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.overallNet !== null || coverage.unavailableCount !== 1 || !/no accepted broker or journal P&L/.test(financial.financialCoverageIssueText(coverage))) failures.push('Mixed exact and unavailable broker rows produced a known-only Overall P&L');
  coverage = financial.financialCoverageForTrades([unavailable], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.overallNet !== null || coverage.unavailableCount !== 1) failures.push('All-unavailable broker rows masqueraded as zero Overall P&L');

  coverage = financial.financialCoverageForTrades([baseExact, manual], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.excludedManualCount !== 1) failures.push('Manual/unreconciled broker-account row did not withhold Overall P&L');

  const healthyStatus = vpsState.statuses.get('connection-1');
  healthyStatus.latestSyncRun.counters.pendingExactMoneyRetries = 1;
  coverage = financial.financialCoverageForTrades([baseExact], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.pendingExactMoneyRetries !== 1) failures.push(`Pending exact-money recovery did not withhold Overall P&L (${JSON.stringify({complete:coverage.overallComplete,pending:coverage.pending})})`);
  healthyStatus.latestSyncRun.counters.pendingExactMoneyRetries = 0;
  healthyStatus.latestSyncRun.counters.positionsAwaitingReview = 2;
  coverage = financial.financialCoverageForTrades([baseExact], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.pendingPositionReviewCount !== 2) failures.push('Broker positions awaiting verified-data review did not withhold Overall P&L');
  healthyStatus.latestSyncRun.counters.positionsAwaitingReview = 0;
  healthyStatus.historicalImport = { status: 'review', counters: { pending: 1 } };
  coverage = financial.financialCoverageForTrades([baseExact], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.pendingHistoricalReviewCount !== 1) failures.push('Pending historical reconciliation did not withhold Overall P&L');
  healthyStatus.historicalImport = { status: 'cancelled', counters: { pending: 9, awaitingReview: 9 } };
  coverage = financial.financialCoverageForTrades([baseExact], { allAccounts: true, accountId: 'all' });
  if (!coverage.overallComplete || coverage.pendingHistoricalReviewCount !== 0) failures.push('Cancelled historical import retained stale actionable-pending counters and withheld a complete official scope');
  healthyStatus.historicalImport = null;
  healthyStatus.tradeHistoryComplete = false;
  coverage = financial.financialCoverageForTrades([baseExact], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.tradeHistoryIncompleteCount !== 1) failures.push(`Incomplete provider trade history did not withhold Overall P&L (${JSON.stringify({complete:coverage.overallComplete,pending:coverage.pending})})`);
  healthyStatus.tradeHistoryComplete = true;

  vpsState.live.reviews.set('connection-1', { candidates: [{ id: 'live-1', status: 'pending' }] });
  coverage = financial.financialCoverageForTrades([baseExact], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.pendingLiveReconciliationCount !== 1) failures.push(`Pending live reconciliation did not withhold Overall P&L (${JSON.stringify({complete:coverage.overallComplete,pending:coverage.pending})})`);
  vpsState.live.reviews.delete('connection-1');
  coverage = financial.financialCoverageForTrades([baseExact], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.liveReviewUnavailableCount !== 1) failures.push('Missing live-reconciliation payload was treated as zero pending candidates');
  vpsState.live.errors.set('connection-1', 'review endpoint unavailable');
  coverage = financial.financialCoverageForTrades([baseExact], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.liveReviewUnavailableCount !== 1) failures.push('Failed live-reconciliation load did not fail closed');
  vpsState.live.errors.clear();vpsState.live.reviews.set('connection-1', { candidates: [] });vpsState.live.loading.add('connection-1');
  coverage = financial.financialCoverageForTrades([baseExact], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.liveReviewUnavailableCount !== 1) failures.push('Loading live-reconciliation state was treated as zero pending candidates');
  vpsState.live.loading.clear();
  healthyStatus.latestSyncRun.status = 'failed';
  coverage = financial.financialCoverageForTrades([baseExact], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.syncIncompleteCount !== 1) failures.push('Failed latest broker sync was mislabeled currently complete');
  healthyStatus.latestSyncRun.status = 'succeeded';

  const estimateOnly = { ...baseExact, id: 'estimate-only', pnl: null, exact: { ...baseExact.exact, pnl: null }, brokerData: { ...baseExact.brokerData, pnlAuthority: 'provider_unavailable', calculatedGrossPnl: '3.00', calculatedGrossCurrency: 'USD', calculatedGrossMethod: 'fill_price_base_units_identity_conversion_v1', calculatedGrossProvenance: { version: 1, accountMoneyDigits: 2, feesIncluded: false, quoteCurrency: 'USD', accountCurrency: 'USD', conversionRate: '1' }, calculatedGrossEvents: [{ executionId: 'estimate-close', executedAt: '2026-08-17T05:00:00.000Z', grossPnl: '3.00' }] } };
  coverage = financial.financialCoverageForTrades([baseExact, estimateOnly], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.estimatedCount !== 1) failures.push('Mixed exact and estimate-only broker rows presented Overall P&L as complete');
  coverage = financial.financialCoverageForTrades([estimateOnly], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.overallNet !== null || coverage.estimatedCount !== 1) failures.push('All-estimate broker rows masqueraded as zero Overall P&L');

  // Production-incident regression: the 25K account has five journal values
  // and eight calculated-gross values while exact provider net is unavailable.
  // Every visible trade must contribute one best-available value to labelled
  // provisional views, without relaxing the exact Overall P&L gate.
  setHealthyConnection();
  const incidentManualValues = [20, 10, -30, -25, -27.5];
  const incidentEstimateValues = [-5, -6, -7, -8, -9, -4, -3, -6.34];
  const incidentManual = incidentManualValues.map((pnl, index) => ({
    ...manual,
    id: `incident-manual-${index + 1}`,
    pnl,
    exact: { pnl: pnl.toFixed(2) },
    exitAt: `2026-08-${String(index + 1).padStart(2, '0')}T06:00:00.000Z`,
    date: `2026-08-${String(index + 1).padStart(2, '0')}`,
  }));
  const incidentEstimates = incidentEstimateValues.map((gross, index) => ({
    ...estimateOnly,
    id: `incident-estimate-${index + 1}`,
    exitAt: `2026-08-${String(index + 6).padStart(2, '0')}T06:00:00.000Z`,
    date: `2026-08-${String(index + 6).padStart(2, '0')}`,
    brokerData: {
      ...estimateOnly.brokerData,
      calculatedGrossPnl: gross.toFixed(2),
      calculatedGrossEvents: [{ executionId: `incident-close-${index + 1}`, executedAt: `2026-08-${String(index + 6).padStart(2, '0')}T06:00:00.000Z`, grossPnl: gross.toFixed(2) }],
      estimatedCommission: '-0.18', estimatedSwap: '0', estimatedConversionFee: '0', estimatedOtherCharges: '0',
      estimatedFeesAndCharges: '-0.18', estimatedNetPnl: (gross-0.18).toFixed(2), estimatedNetCurrency: 'USD',
      estimatedNetMethod: 'remote_mcp_execution_commission_same_currency_v1',
      estimatedNetProvenance: { version: 1, exact: false, accountMoneyDigits: 2, accountCurrency: 'USD' },
    },
  }));
  const incidentSource = [...incidentManual, ...incidentEstimates];
  const incidentCoverage = financial.financialCoverageForTrades(incidentSource, { allAccounts: true, accountId: 'all' });
  const incidentView = financial.financialDisplayViewForTrades(incidentSource, { allAccounts: true, accountId: 'all' });
  const incidentNotice = financial.financialDisplayViewNotice(incidentView);
  const incidentNet = incidentView.analysisRows.reduce((sum, row) => sum + row.displayPnl, 0);
  const incidentLedgerNet = incidentView.analysisLedger.reduce((sum, row) => sum + row.displayPnl, 0);
  const incidentWins = incidentView.closedRows.filter(row => row.displayPnl > 0).length;
  const incidentLosses = incidentView.closedRows.filter(row => row.displayPnl < 0).length;
  const incidentRowIds = new Set(incidentView.analysisRows.map(row => row.trade.id));
  const incidentLedgerIds = new Set(incidentView.analysisLedger.map(row => row.id));
  if (incidentCoverage.overallComplete || incidentCoverage.overallNet !== null) failures.push('Incident fixture relaxed exact Overall P&L authority');
  if (incidentView.analysisLabel !== 'Mixed provisional net P&L' || incidentView.analysisRows.length !== 13 || incidentView.analysisLedger.length !== 13 || incidentView.closedRows.length !== 13) failures.push(`Incident fixture did not expose all 13 visible trades once (${JSON.stringify({label:incidentView.analysisLabel,rows:incidentView.analysisRows.length,ledger:incidentView.analysisLedger.length,closed:incidentView.closedRows.length})})`);
  if (incidentRowIds.size !== 13 || incidentLedgerIds.size !== 13) failures.push('Incident provisional view double-counted a visible trade');
  if (Math.abs(incidentManualValues.reduce((sum, value) => sum + value, 0) - -52.5) > 1e-9 || Math.abs(incidentEstimateValues.reduce((sum, value) => sum + value, 0) - -48.34) > 1e-9 || Math.abs(incidentNet - -102.28) > 1e-9 || Math.abs(incidentLedgerNet - -102.28) > 1e-9) failures.push(`Incident provisional sums did not reconcile (${JSON.stringify({incidentNet,incidentLedgerNet})})`);
  if (incidentWins !== 2 || incidentLosses !== 11 || incidentView.journalCount !== 5 || incidentView.estimatedCount !== 8) failures.push(`Incident provisional outcomes/provenance did not reconcile (${JSON.stringify({incidentWins,incidentLosses,journal:incidentView.journalCount,estimated:incidentView.estimatedCount})})`);
  if (!/Exact broker Overall P&L remains withheld/.test(incidentNotice) || !/observed execution commissions/.test(incidentNotice) || !/may overlap unresolved broker rows/.test(incidentNotice)) failures.push('Incident provisional notice omitted exact-authority, fee, or overlap disclosure');

  vpsState.connections = [];vpsState.statuses = new Map();vpsState.live = { reviews: new Map(), errors: new Map(), loading: new Set() };
  coverage = financial.financialCoverageForTrades([baseExact], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.accountStatusUnknownCount !== 1) failures.push('Existing broker row with unloaded connection/status state presented Overall P&L as complete');
  vpsState.connections = [{ id: 'connection-1', mappedAccountId: 'broker-account', connected: false, tradeHistoryComplete: true, tradeHistorySyncedThroughTimestamp: 1786943100000 }];
  coverage = financial.financialCoverageForTrades([baseExact], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.overallNet !== null || coverage.disconnectedConnectionCount !== 1 || !/unresolved candidates or exact-money recovery cannot be proven clear/.test(financial.financialCoverageIssueText(coverage))) failures.push('Disconnected mapped account exposed a potentially partial stored snapshot as Overall P&L');
  vpsState.connections = [{ id: 'connection-1', mappedAccountId: 'broker-account', connected: false, tradeHistoryComplete: false, tradeHistorySyncedThroughTimestamp: null }];
  coverage = financial.financialCoverageForTrades([baseExact], { allAccounts: true, accountId: 'all' });
  if (coverage.overallComplete || coverage.tradeHistoryIncompleteCount !== 1) failures.push('Never-completed disconnected broker history was mislabeled a complete historical snapshot');
} catch (error) {
  failures.push(`Canonical financial-scope fixture failed: ${error.message}`);
}

try {
  const djStatsSource = sourceBetween('function djDayStats', '/* Format date nicely */');
  const { exports: djStats } = evaluateSecurityFixture(
    djStatsSource,
    {
      trades: [
        { id: 'usd', date: '2026-08-17', currency: 'USD' },
        { id: 'unsupported', date: '2026-08-17', currency: 'XYZ' },
      ],
      financialDisplayViewForTrades: () => ({
        analysisLedger: [{ id: 'usd', ledgerDate: '2026-08-17', ledgerPnl: 10, displayPnl: 10, financialIsEstimate: false, financialKind: 'manual_reported', currency: 'USD' }],
        coverage: { overallComplete: false, overallNet: null, overallIncompleteCount: 1 },
        degraded: true,
        conversionUnavailableCount: 1,
        analysisLabel: 'Available provisional subtotal',
      }),
      financialPresentationDate: (instant, timeZone, fallback) => fallback || null,
      tradeJournalDate: trade => trade?.date || '',
      financialDisplayViewNotice: () => 'Exact broker Overall P&L remains withheld; one conversion is unavailable.',
      financialCoverageSnapshotText: () => '',
    },
    '{djDayStats}',
  );
  const stats = djStats.djDayStats('2026-08-17');
  if (!stats.incomplete || stats.unavailableCount < 1 || stats.net !== 10 || stats.wr !== 100 || stats.best?.id !== 'usd' || stats.count !== 2 || !/Exact broker Overall P&L remains withheld/.test(stats.issue)) failures.push('Daily Journal did not expose a labelled available subtotal while preserving conversion incompleteness');
  requireMatch(app, /renderDashboardInsights\(equityRows,closed,displayC,palette,view\)/, 'dashboard insight charts consume the shared provisional ledger');
  requireMatch(app, /const completedPnlVals = completed\.map\(pnlInDisplay\)\.filter\(Number\.isFinite\)/, 'dashboard outcome cards consume valued provisional outcomes');
  rejectMatch(app, /dashboard-financial-summary|renderDashboardFinancialSummary/, 'dashboard financial-breakdown strip remains removed while provisional views render');
} catch (error) {
  failures.push(`Financial conversion fail-closed fixture failed: ${error.message}`);
}

// The production XLSX writer and the actual detailed-workbook builder are
// exercised together. This catches ZIP/OOXML regressions, unsafe spreadsheet
// text, precision-loss audit gaps, and schema drift without depending on Excel.
const readStoredZipEntries = bytes => {
  const entries = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (method !== 0) throw new Error('production writer emitted an unexpected compressed ZIP entry');
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
};
try {
  requireMatch(app, /<script src=["']\.\/client\/xlsx-export\.js["']><\/script>/, 'production XLSX writer script');
  requireMatch(read('deploy/vps/scripts/build-public.sh'), /client\/xlsx-export\.js/, 'XLSX writer copied into production artifact');
  requireMatch(read('deploy/vps/verify-deployment.mjs'), /xlsx-export\.js/, 'XLSX writer deployment contract');

  const xlsxHelpersSource = sourceBetween('function xlsxCell', 'async function fetchAllAccountCashFlowsForExport');
  const workbookBuilderSource = sourceBetween('function edgebookDetailedWorkbook', 'let _excelExportInFlight');
  const exactTrade = {
    id: 'trade-1', recordId: 'record-1', externalTradeKey: 'ctrader:position:9001', brokerTradeId: '9001', brokerConnectionId: 'connection-1',
    accountId: 'account-1', source: 'ctrader', sourceSystem: 'ctrader', symbol: 'XAUUSD', direction: 'Long', entry: 2320.1, exit: 2321.4, size: 0.02,
    exact: { entry: '2320.100000000000001', exit: '2321.400000000000001', size: '0.020000000000000001', pnl: '12.3400' },
    date: '2026-08-17', entryAt: '2026-08-17T04:30:00.000Z', exitAt: '2026-08-17T05:00:00.000Z', durationSeconds: 1800, pnl: 12.34,
    notes: '=HYPERLINK("https://bad.example") & ₹ <tag>', strategy: 'Breakout', emotion: 'Calm', custom: { playbook: { setup: 'Opening range', grade: 'A' } },
    brokerData: {
      positionId: '9001', accountCurrency: 'USD', accountMoneyDigits: 4, pnlAuthority: 'provider', pnlMethod: 'provider_close_detail_money_digits',
      quantityProjection: { unit: 'base_units', value: '2.000000000000000001', lots: null, baseUnits: '2.000000000000000001' },
    },
  };
  exactTrade._presentation = { kind: 'broker_exact_net', amount: 12.34, currency: 'USD', isEstimate: false, isBrokerNet: true, authority: 'provider', breakdown: { net: '12.3400', gross: '14.0000', commission: '-1.2500', swap: '-0.3100', conversionFee: '0.1000', currency: 'USD' } };
  exactTrade._ledger = [{ ...exactTrade, ledgerDate: '2026-08-17', ledgerPnl: 12.34, financialKind: 'broker_exact_net', financialIsEstimate: false, realizedEvent: { executionId: 'close-1', executedAt: '2026-08-17T05:00:00.000Z', closedVolumeCents: '200000000000000001', price: '2321.400000000000001', pnl: '12.3400', grossProfit: '14.0000', commission: '-1.2500', swap: '-0.3100', pnlConversionFee: '0.1000' } }];
  const scopeFor = source => ({
    brokerAccounts: new Set(['account-1']),
    included: source.filter(trade => !trade._scopeKind).map(trade => ({ trade, presentation: trade._presentation, brokerTracked: true })),
    estimated: source.filter(trade => trade._scopeKind === 'estimated').map(trade => ({ trade, presentation: trade._presentation, brokerTracked: true })),
    manualExcluded: source.filter(trade => trade._scopeKind === 'manualExcluded').map(trade => ({ trade, presentation: trade._presentation, brokerTracked: true })),
    unavailable: source.filter(trade => trade._scopeKind === 'unavailable').map(trade => ({ trade, presentation: null, brokerTracked: true })),
  });
  const { exports: workbookBuilder } = evaluateSecurityFixture(
    `${xlsxHelpersSource}\n${workbookBuilderSource}`,
    {
      activePageAcct: { journal: 'all' }, S: { accounts: [{ id: 'account-1', name: 'Master' }] },
      financialPresentationLedgerForTrades: source => source.flatMap(trade => trade._ledger || []),
      financialScopeForTrades: scopeFor, tradeFinancialPresentation: trade => trade._presentation || null,
      tradeJournalDate: trade => trade.date, tradeDurationSeconds: trade => trade.durationSeconds,
      tradeIsOpen: trade => trade.isOpen === true, getTradeSizeValue: trade => trade.size, getSizeLabel: () => 'base units',
      tradePnlCurrency: trade => trade._presentation?.currency || trade.brokerData?.accountCurrency || 'USD',
      cTraderCalculatedGross: trade => trade._presentation?.gross || null, acctName: () => 'Master',
      cTraderEstimatedNet: trade => trade._presentation?.estimatedNet || null,
      ctraderCashFlowCategory: flow => flow.category || 'unknown', mappedAccountForCTraderConnection: connection => connection.mappedAccountId || '',
      ctraderCashFlowHasExactMoney: flow => flow?.scalingStatus === 'exact' && flow?.moneyDigitsSource === 'cash_flow' && Number.isSafeInteger(Number(flow?.moneyDigits)) && flow?.amount !== null && flow?.amount !== undefined && /^-?\d+(?:\.\d+)?$/.test(String(flow.amount)),
      isRealIsoDate: value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)),
    },
    '{edgebookDetailedWorkbook}',
  );
  const cashFlowExport = {
    complete: false,
    errors: ['All stored rows exported; provider historical completeness is unverified.'],
    financialPending: { connectionCount: 2, connectedConnectionCount: 1, disconnectedConnectionCount: 1, accountStatusUnknownCount: 1, pendingExactMoneyRetries: 1, pendingPositionReviewCount: 2, pendingLiveReconciliationCount: 1, pendingHistoricalReviewCount: 1, pendingReconciliationCount: 4, liveReviewUnavailableCount: 1, tradeHistoryIncompleteCount: 1, syncIncompleteCount: 1, historyThrough: [{ connectionId: 'connection-1', accountId: 'account-1', timestamp: 1786943100000, connected: true }] },
    connections: [{ id: 'connection-1', label: '25K Master', mappedAccountId: 'account-1', connected: true, accountBalance: '24901.1234', accountBalanceRawUnits: '2490112340000000001', accountBalanceMoneyDigits: 4, accountBalanceVersion: 'v2', accountBalanceScalingStatus: 'exact', accountCurrency: 'USD', accountBalanceAsOf: '2026-08-17T05:05:00Z', accountBalanceSource: 'ProtoOATrader', accountCashFlowHistoryComplete: false, accountCashFlowMonetaryScaleComplete: false, accountCashFlowTotalRows: 2, accountCashFlowScaledRows: 1, accountCashFlowUnscaledRows: 1, accountCashFlowPendingScaleRetries: 1, tradeHistoryComplete: false, tradeHistoryStartTimestamp: null, tradeHistorySyncedThroughTimestamp: null }],
    rows: [
      { occurredAt: '2026-08-17T05:02:00Z', balanceHistoryId: '9223372036854775807', connectionId: 'connection-1', mappedAccountId: 'account-1', operationName: 'BALANCE_FEE', category: 'unknown', amount: '-0.0100', balance: '24901.1234', equity: '24905.9999', currency: 'USD', moneyDigits: 4, scalingStatus: 'exact', positionAttribution: 'not_available_from_ctrader', rawAmountUnits: '-100000000000000001', rawBalanceUnits: '2490112340000000001', rawEquityUnits: '2490599990000000001', balanceVersion: 'v2', moneyDigitsSource: 'cash_flow' },
      { occurredAt: '2026-08-17T05:03:00Z', balanceHistoryId: '9223372036854775808', connectionId: 'connection-1', mappedAccountId: 'account-1', operationName: 'BALANCE_FEE', category: 'trading_related_adjustment', amount: null, balance: null, equity: null, currency: 'USD', moneyDigits: null, scalingStatus: 'money_digits_unavailable', positionAttribution: 'not_available_from_ctrader', rawAmountUnits: '-100000000000000002', rawBalanceUnits: '2490112340000000002', rawEquityUnits: '2490599990000000002', balanceVersion: 'v2', moneyDigitsSource: 'unavailable' },
    ],
  };
  const definition = workbookBuilder.edgebookDetailedWorkbook([exactTrade], cashFlowExport);
  const sheetNames = definition.sheets.map(sheet => sheet.name);
  if (sheetNames.join('|') !== 'Summary|Trades|Realized Events|Account Adjustments|Data Quality') failures.push('Detailed XLSX sheet topology regressed');
  const valueOf = cell => cell && typeof cell === 'object' && 'value' in cell ? cell.value : cell;
  const tradeHeaders = definition.sheets[1].rows[0].map(valueOf);
  const adjustmentHeaders = definition.sheets[3].rows[0].map(valueOf);
  const qualityCodes = definition.sheets[4].rows.slice(1).map(row => valueOf(row[1]));
  for (const header of ['Broker Net P&L', 'Estimated Fees & Charges', 'Estimated Net P&L', 'Gross Exact Text', 'Broker Net Exact Text', 'Quantity Base Units Exact Text']) if (!tradeHeaders.includes(header)) failures.push(`Detailed XLSX omitted trade audit column ${header}`);
  for (const header of ['Opened At (UTC)', 'Closed At (UTC)']) if (!tradeHeaders.includes(header)) failures.push(`Detailed XLSX omitted timestamp timezone label ${header}`);
  if (!adjustmentHeaders.includes('Occurred At (UTC)')) failures.push('Detailed XLSX account-ledger timestamp did not disclose UTC');
  for (const header of ['Raw Amount Units', 'Raw Balance Units', 'Raw Equity Units', 'Balance Version']) if (!adjustmentHeaders.includes(header)) failures.push(`Detailed XLSX omitted account-ledger audit column ${header}`);
  if (!qualityCodes.includes('ACCOUNT_LEDGER_PARTIAL') || !qualityCodes.includes('UNKNOWN_ACCOUNT_ADJUSTMENT')) failures.push('Detailed XLSX did not disclose partial/unknown account ledger quality');
  for (const code of ['ACCOUNT_ADJUSTMENT_SCALE_UNAVAILABLE','ACCOUNT_ADJUSTMENT_SCALE_RECOVERY_PENDING','ACCOUNT_ADJUSTMENT_SCALE_COVERAGE_INCOMPLETE']) if (!qualityCodes.includes(code)) failures.push(`Detailed XLSX omitted cash-flow scale quality row ${code}`);
  if (definition.sheets[3].rows[2][6] !== null || valueOf(definition.sheets[3].rows[2][18]) !== '-100000000000000002') failures.push('Detailed XLSX typed an unscaled adjustment as zero/money or lost its raw provider units');
  for (const code of ['BROKER_ACCOUNT_STATUS_UNKNOWN','BROKER_EXACT_MONEY_RECOVERY_PENDING','BROKER_POSITION_REVIEW_PENDING','LIVE_RECONCILIATION_PENDING','LIVE_RECONCILIATION_UNVERIFIED','HISTORICAL_RECONCILIATION_PENDING','BROKER_TRADE_HISTORY_INCOMPLETE','BROKER_SYNC_NOT_CURRENT','BROKER_CONNECTION_DISCONNECTED_SNAPSHOT']) if (!qualityCodes.includes(code)) failures.push(`Detailed XLSX omitted broker coverage quality row ${code}`);
  const summaryText = definition.sheets[0].rows.flat().map(valueOf).join(' | ');
  if (!/Overall P&L status \| WITHHELD/.test(summaryText) || !/Known broker trade net \(subtotal\)/.test(summaryText)) failures.push('Detailed XLSX presented accepted broker rows as a complete Overall P&L while coverage was pending');
  if (!/Account cash-flow ledger \| PARTIAL \/ UNKNOWN/.test(summaryText)) failures.push('Detailed XLSX claimed complete monetary account-adjustment coverage while an unscaled row remained');
  if (!/Overall P&L scope \| Realized broker trade net only[\s\S]*excludes open\/unrealized P&L[\s\S]*not live broker equity/.test(summaryText)) failures.push('Detailed XLSX did not distinguish realized trade net from live broker equity/unrealized P&L');
  if (!/Balance, not equity/.test(summaryText)) failures.push('Detailed XLSX mislabeled the broker balance control as live equity');
  requireMatch(app, /Exact broker Overall P&L remains withheld:[\s\S]*not exact broker net or live equity/, 'dashboard provisional-P&L versus live-equity scope disclosure');
  const partialAdjustmentSummaryRows = definition.sheets[0].rows.filter(row => ['Funding cash flows','Trading-related adjustments','Non-trading economics','Bonus / protection','Unknown adjustments'].includes(valueOf(row[0])));
  if (partialAdjustmentSummaryRows.length !== 5 || partialAdjustmentSummaryRows.some(row => row[1] !== null || !/Withheld:/.test(valueOf(row[3])))) failures.push('Detailed XLSX emitted partial account-adjustment category formulas while monetary scale coverage was incomplete');
  if (!definition.sheets[0].rows.flat().some(cell => cell?.type === 'formula_money')) failures.push('Detailed XLSX Summary lost its reconciliation formulas');

  const unavailableTrade = { ...exactTrade, id: 'unavailable-row', recordId: 'unavailable-row', pnl: null, _presentation: null, _ledger: [], _scopeKind: 'unavailable' };
  const manualTrade = { ...exactTrade, id: 'manual-row', recordId: 'manual-row', source: 'manual', sourceSystem: 'manual', pnl: -2, _presentation: { kind: 'manual_reported', amount: -2, currency: 'USD', isEstimate: false, isBrokerNet: false }, _ledger: [], _scopeKind: 'manualExcluded' };
  const estimateTrade = { ...exactTrade, id: 'estimate-row', recordId: 'estimate-row', pnl: null, _presentation: { kind: 'estimated_gross', amount: 3, currency: 'USD', isEstimate: true, isBrokerNet: false, gross: { valueText: '3.00' } }, _ledger: [], _scopeKind: 'estimated' };
  const issueDefinition = workbookBuilder.edgebookDetailedWorkbook([exactTrade, unavailableTrade, manualTrade, estimateTrade], cashFlowExport);
  const issueCodes = issueDefinition.sheets[4].rows.slice(1).map(row => valueOf(row[1]));
  for (const code of ['PNL_UNAVAILABLE','MANUAL_EXCLUDED_FROM_BROKER_TOTAL','ESTIMATED_GROSS']) if (!issueCodes.includes(code)) failures.push(`Detailed XLSX omitted visible trade quality row ${code}`);

  const completeDefinition = workbookBuilder.edgebookDetailedWorkbook([exactTrade], {
    ...cashFlowExport,
    complete: true,
    errors: [],
    rows: cashFlowExport.rows.slice(0,1),
    financialPending: { connectionCount: 1, connectedConnectionCount: 1, disconnectedConnectionCount: 0, accountStatusUnknownCount: 0, pendingExactMoneyRetries: 0, pendingPositionReviewCount: 0, pendingLiveReconciliationCount: 0, pendingHistoricalReviewCount: 0, pendingReconciliationCount: 0, liveReviewUnavailableCount: 0, tradeHistoryIncompleteCount: 0, syncIncompleteCount: 0, historyThrough: [{ connectionId: 'connection-1', accountId: 'account-1', timestamp: 1786943100000, connected: true }] },
    connections: cashFlowExport.connections.map(connection => ({ ...connection, tradeHistoryComplete: true, tradeHistoryStartTimestamp: 1786930000000, tradeHistorySyncedThroughTimestamp: 1786943100000, accountCashFlowHistoryComplete: true, accountCashFlowHistoryStartTimestamp: 1786930000000, accountCashFlowSyncedThroughTimestamp: 1786943100000, accountCashFlowMonetaryScaleComplete: true, accountCashFlowTotalRows: 1, accountCashFlowScaledRows: 1, accountCashFlowUnscaledRows: 0, accountCashFlowPendingScaleRetries: 0 })),
  });
  const completeSummaryText = completeDefinition.sheets[0].rows.flat().map(valueOf).join(' | ');
  if (!/Overall P&L status \| COMPLETE THROUGH account-1: 2026-08-17T05:05:00\.000Z/.test(completeSummaryText) || /Known broker trade net \(subtotal\)/.test(completeSummaryText)) failures.push('Detailed XLSX did not tie a complete Overall P&L claim to its exact broker-history through timestamp');
  if (!/Account cash-flow ledger \| Complete through/.test(completeSummaryText) || /money scale incomplete/.test(completeSummaryText)) failures.push('Detailed XLSX did not restore complete account-adjustment coverage after every row had authoritative scale');
  const completeAdjustmentSummaryRows = completeDefinition.sheets[0].rows.filter(row => ['Funding cash flows','Trading-related adjustments','Non-trading economics','Bonus / protection','Unknown adjustments'].includes(valueOf(row[0])));
  if (completeAdjustmentSummaryRows.length !== 5 || completeAdjustmentSummaryRows.some(row => row[1]?.type !== 'formula_money')) failures.push('Detailed XLSX did not restore account-adjustment category formulas after monetary scale coverage became complete');

  const disconnectedOnlyDefinition = workbookBuilder.edgebookDetailedWorkbook([], {
    ...cashFlowExport,
    rows: [], complete: true, errors: [],
    financialPending: { connectionCount: 1, connectedConnectionCount: 0, disconnectedConnectionCount: 1, accountStatusUnknownCount: 0, pendingExactMoneyRetries: 0, pendingPositionReviewCount: 0, pendingLiveReconciliationCount: 0, pendingHistoricalReviewCount: 0, pendingReconciliationCount: 0, liveReviewUnavailableCount: 0, tradeHistoryIncompleteCount: 0, syncIncompleteCount: 0, historyThrough: [{ connectionId: 'connection-1', accountId: 'account-1', timestamp: 1786943100000, connected: false }] },
    connections: cashFlowExport.connections.map(connection => ({ ...connection, connected: false, tradeHistoryComplete: true, tradeHistoryStartTimestamp: 1786930000000, tradeHistorySyncedThroughTimestamp: 1786943100000, accountCashFlowHistoryComplete: true, accountCashFlowHistoryStartTimestamp: 1786930000000, accountCashFlowSyncedThroughTimestamp: 1786943100000 })),
  });
  const disconnectedSummaryText = disconnectedOnlyDefinition.sheets[0].rows.flat().map(valueOf).join(' | ');
  const disconnectedQualityCodes = disconnectedOnlyDefinition.sheets[4].rows.slice(1).map(row => valueOf(row[1]));
  if (!/Overall P&L status \| WITHHELD/.test(disconnectedSummaryText) || !disconnectedQualityCodes.includes('BROKER_CONNECTION_DISCONNECTED_SNAPSHOT')) failures.push('Detailed XLSX labeled a disconnected potentially-withheld broker snapshot complete when no accepted trade row exposed the gap');

  const bytes = xlsxExport.buildXlsx(definition);
  const blob = xlsxExport.buildBlob(definition);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || blob.type !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') failures.push('Production XLSX output is not a real XLSX ZIP/blob');
  const entries = readStoredZipEntries(bytes);
  for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet5.xml']) if (!entries.has(part)) failures.push(`Production XLSX ZIP omitted ${part}`);
  const decode = name => new TextDecoder().decode(entries.get(name));
  const allSheetXml = [...entries].filter(([name]) => name.startsWith('xl/worksheets/')).map(([, value]) => new TextDecoder().decode(value)).join('\n');
  const tradesXml = decode('xl/worksheets/sheet2.xml');
  const adjustmentsXml = decode('xl/worksheets/sheet4.xml');
  const summaryXml = decode('xl/worksheets/sheet1.xml');
  const stylesXml = decode('xl/styles.xml');
  const expectedDateSerial = String(xlsxExport.excelSerial(new Date('2026-08-17T00:00:00.000Z')));
  if (!tradesXml.includes(`<c r="A2" s="3" t="n"><v>${expectedDateSerial}</v></c>`) || !tradesXml.includes('<c r="X2" s="5" t="n"><v>12.34</v></c>')) failures.push('Detailed XLSX dates or money values were not typed numeric cells');
  if (!summaryXml.includes('<f>SUMIF(') || !allSheetXml.includes('=HYPERLINK("https://bad.example")') || allSheetXml.includes('<f>HYPERLINK(') || !allSheetXml.includes('&lt;tag&gt;') || !allSheetXml.includes('₹')) failures.push('Detailed XLSX formula/injection/UTF-8/XML escaping contract regressed');
  if (!allSheetXml.includes('2490112340000000001') || !allSheetXml.includes('200000000000000001')) failures.push('Detailed XLSX lost exact raw integer audit values to floating-point conversion');
  if (adjustmentsXml.includes('<c r="G3"') || !adjustmentsXml.includes('-100000000000000002')) failures.push('Detailed XLSX serialized an unscaled cash-flow amount as typed money/zero or omitted its raw audit units');
  if (!stylesXml.includes('numFmtId="49"') || !tradesXml.includes('<c r="E2" s="10" t="inlineStr">') || !allSheetXml.includes('s="10" t="inlineStr"')) failures.push('Detailed XLSX exact identifiers/raw values lost their explicit Excel text format');
  if (!tradesXml.includes('<autoFilter ref="A1:BD2"')) failures.push('Detailed XLSX filter no longer starts on the actual Trades header row');

  const namedBytes = xlsxExport.buildXlsx({ sheets: [{ name: 'Invalid/very*long?sheet:name[one] 1234567890', rows: [['A']] }, { name: 'Invalid/very*long?sheet:name[one] 1234567890', rows: [['B']] }] });
  const namedWorkbookXml = new TextDecoder().decode(readStoredZipEntries(namedBytes).get('xl/workbook.xml'));
  const normalizedNames = [...namedWorkbookXml.matchAll(/<sheet name="([^"]+)"/g)].map(match => match[1]);
  if (normalizedNames.length !== 2 || normalizedNames[0] === normalizedNames[1] || normalizedNames.some(name => name.length > 31 || /[\\/*?:\[\]]/.test(name))) failures.push('Production XLSX sheet-name bounds/uniqueness regressed');
  let unsafeFormulaAccepted = false;
  try { xlsxExport.buildXlsx({ sheets: [{ name: 'Unsafe', rows: [[{ type: 'formula', value: '=HYPERLINK("https://bad.example")' }]] }] }); unsafeFormulaAccepted = true; } catch {}
  if (unsafeFormulaAccepted) failures.push('Production XLSX accepted an unallowlisted internal formula function');
  let oversizedAccepted = false;
  try { xlsxExport.buildXlsx({ sheets: [{ name: 'Too large', rows: Array.from({ length: 1251 }, () => Array(200).fill(0)) }] }); oversizedAccepted = true; } catch {}
  if (oversizedAccepted) failures.push('Production XLSX exceeded its 250,000-cell browser memory bound');
} catch (error) {
  failures.push(`Detailed XLSX production-writer fixture failed: ${error.message}`);
}

try {
  const calls = [];
  const adapter = createVpsDataAdapter({ async get(requestPath) { calls.push(requestPath); return { accountCashFlows: [], nextCursor: null }; } });
  const page = await adapter.ctrader.accountCashFlows('connection 1', { limit: 999, cursor: 'next page' });
  if (page.nextCursor !== null || calls[0] !== '/ctrader/connections/connection%201/cash-flows?limit=500&cursor=next+page') failures.push('Account cash-flow XLSX pagination adapter regressed');
  const invalid = createVpsDataAdapter({ async get() { return { accountCashFlows: [], nextCursor: 7 }; } });
  let invalidRejected = false;
  try { await invalid.ctrader.accountCashFlows('connection-1'); } catch (error) { invalidRejected = error?.code === 'CTRADER_CASH_FLOW_PAGE_INVALID'; }
  if (!invalidRejected) failures.push('Account cash-flow XLSX pagination accepted an invalid cursor contract');
} catch (error) {
  failures.push(`Account cash-flow XLSX pagination fixture failed: ${error.message}`);
}

if (failures.length) {
  console.error('Frontend verification failed:\n' + failures.map(item => `- ${item}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('Frontend verification passed.');
}
