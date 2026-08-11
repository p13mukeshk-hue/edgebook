import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createVpsDataAdapter } from './data-adapter.js';
import { createAuthAdapter } from './auth-adapter.js';

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
const allBrowserSource = `${app}\n${marketing}\n${apiClient}\n${authAdapter}\n${dataAdapter}`;

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
const duplicateResolutionSource = sourceBetween('async function resolveDup', 'function showManualDupModal');
const jsonImportSource = sourceBetween('function importTradesJSON', 'function csvFormulaSafeText');
const csvImportCommitSource = sourceBetween('async function csvImportTrades', 'let ddRange');
requireMatch(migrationExportSource, /const bundle=\{users:\{\[legacyUid\]:\{[\s\S]*?settings:[\s\S]*?moods:[\s\S]*?dailyJournal:/, 'complete per-UID migration export shape');
requireMatch(dataStoreSource, /saveTrades\(t\)\{[\s\S]*?window\._dataMode===['"]vps['"][\s\S]*?return this\._syncVpsTrades\(t\);[\s\S]*?return false;/, 'trade save returns false without a selected provider');
requireMatch(dataStoreSource, /async _syncVpsTrades\(items\)[\s\S]*?const results=await Promise\.allSettled\(pending\);[\s\S]*?return failed\.length===0;/, 'trade save awaits every VPS mutation');
requireMatch(dataStoreSource, /saveTrade\(trade\)\{[\s\S]{0,700}?_syncVpsTrades\(\[trade\]\)/, 'trade modal persists only its owned mutation');
requireMatch(tradeSaveSource, /const synced=await DataStore\.saveTrade\((?:trades\[i\]|trade)\);[\s\S]*?if\(!synced\)[\s\S]*?return;[\s\S]*?showToast\(['"]Trade (?:updated|logged)/, 'manual trade success waits for targeted persistence');
requireMatch(tradeSaveSource, /if\(_tradeSaveInFlight\)return;[\s\S]*?_tradeSaveInFlight=true;[\s\S]*?finally[\s\S]*?_tradeSaveInFlight=false/, 'manual trade submit has an in-flight double-click lock');
requireMatch(tradeSaveSource, /id:editId\|\|_tradeDraftId\|\|\(_tradeDraftId=Date\.now\(\)\)/, 'manual trade retries retain a stable idempotency ID');
requireMatch(tradeSaveSource, /await loadManualDuplicateCandidates\(\)[\s\S]*?findLocalDuplicate\(trade,duplicateCandidates\)/, 'manual trade duplicate check uses the authoritative VPS list');
requireMatch(duplicateResolutionSource, /duplicateNumericClose\(existing\.entry,incoming\.entry,\.005\)[\s\S]*?duplicateNumericClose\(existing\.exit,incoming\.exit,\.005\)[\s\S]*?duplicateNumericClose\(existing\.size,incoming\.size,\.02\)/, 'manual duplicate check covers near entry exit and size values');
requireMatch(dataAdapter, /async create\(trade\)[\s\S]*?isAmbiguousWriteError\(error\)[\s\S]*?api\.get\(`\/trades\/\$\{encodeURIComponent\(trade\.id\)\}`\)/, 'lost trade-create response reconciliation');
requireMatch(duplicateResolutionSource, /const saved=await DataStore\.saveTrades\(trades\);[\s\S]*?if\(!saved\)[\s\S]*?recoverTradesAfterFailedWrite/, 'duplicate resolution waits for persistence');
requireMatch(jsonImportSource, /const saved=await DataStore\.saveTrades\(trades\);[\s\S]*?if\(!saved\)[\s\S]*?recoverTradesAfterFailedWrite/, 'JSON import waits for persistence');
requireMatch(csvImportCommitSource, /const saved=await DataStore\.saveTrades\(trades\);[\s\S]*?if\(!saved\)[\s\S]*?recoverTradesAfterFailedWrite[\s\S]*?return;[\s\S]*?closeModal/, 'CSV import waits for persistence before closing');
requireMatch(csvImportCommitSource, /String\(trade\.broker\|\|['"]['"]\)\.toLowerCase\(\)===String\(csvState\.selectedBroker\|\|['"]['"]\)\.toLowerCase\(\)/, 'legacy CSV open-position reconciliation is broker-scoped');
requireMatch(app, /async function commitSettings\([\s\S]*?const saved=await SettingsManager\.set\(S\);/, 'settings commit awaits VPS persistence');
requireMatch(browserDataMigrationSource, /remoteStillAtBase=dirty\.baseKnown===true&&remoteFingerprint===dirty\.baseFingerprint/, 'dirty journal retry compares the remote row with its captured base');
requireMatch(browserDataMigrationSource, /if\(!remoteAlreadyHasLocal&&!remoteStillAtBase&&!safelyCreating\)[\s\S]*?djRecordConflict\(date,dirty,existing\);[\s\S]*?continue;/, 'divergent journal edits are preserved as conflicts without a PUT');
requireMatch(browserDataMigrationSource, /if\(journalConflicts\.includes\(date\)\) continue;[\s\S]*?await djClearDirty\(date,localEntry\)/, 'journal dirty marker clears only after verified non-conflicting content');
for (const mutation of ['saveBrokerMapping','addAccount','saveEditAccount','toggleFormField','addCustomField','removeCustomField','saveEditCF','moveCFInSection','moveCFSection','setTheme','toggleSidebarPin','addSymbol','removeSymbol']) {
  requireMatch(app, new RegExp(`async function ${mutation}\\b[\\s\\S]{0,1800}?await (?:commitSettings\\(|SettingsManager\\.set\\(S\\))`), `${mutation} awaits settings persistence`);
}
requireMatch(app, /function removeAccount\b[\s\S]{0,800}?async\(\)=>\{[\s\S]*?await SettingsManager\.set\(S\)/, 'removeAccount awaits settings persistence');
requireMatch(app, /function clearSymbolsForTab\b[\s\S]{0,800}?async\(\)=>\{[\s\S]*?await commitSettings\(/, 'clearSymbolsForTab awaits settings persistence');

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
requireMatch(app, /#page-dashboard\{--text2:#adb6cd;--text3:#8d98b6\}/, 'dashboard-scoped dark text contrast');
requireMatch(app, /body\.light #page-dashboard\{--text2:#4a4438;--text3:#6f6658\}/, 'dashboard light-theme text hierarchy');
requireMatch(app, /DASH_TC='#8d98b6'/, 'readable dashboard canvas labels');
requireMatch(app, /setEquityAxisMode\(['"]date['"]\)[\s\S]{0,260}?By date/, 'date-based equity axis control');
requireMatch(app, /setEquityAxisMode\(['"]trade['"]\)[\s\S]{0,260}?By trade #/, 'explicit trade-number equity axis control');
requireMatch(app, /function equityTradeTimestamp\b/, 'equity close timestamp projection');
requireMatch(app, /cubicInterpolationMode:['"]monotone['"]/, 'monotone equity line interpolation');
requireMatch(app, /pointRadius:context=>context\.raw\?\.synthetic\?0:\(displayedEquityPoints\.length===1\?4:0\)[\s\S]{0,220}?pointHoverRadius:4/, 'visible first equity point with decluttered multi-point curve');
requireMatch(app, /maxTicksLimit:7[\s\S]{0,180}?equityDateTick/, 'bounded date ticks on equity curve');
requireMatch(app, /Cumulative P&L:\s*\$\{signedMoney\(point\.y/, 'cumulative P&L equity tooltip');
requireMatch(app, /aggregateEquityDaily\(rawEquityPoints\)/, 'daily-close smoothing for date equity view');
requireMatch(app, /ensureEquityStartAnchor\(displayedEquityPoints,chartAxisMode\)/, 'zero baseline anchor for the first equity close');
requireMatch(app, /visibleEquityValues=displayedEquityPoints\.map[\s\S]{0,160}?equityAxisDomain\(visibleEquityValues\)/, 'dynamic equity Y-domain from visible points');
requireMatch(app, /y:\{[\s\S]{0,100}?min:yDomain\.min,[\s\S]{0,60}?max:yDomain\.max/, 'exact equity Y-domain without library tick expansion');
requireMatch(app, /insertEquityZeroCrossings\(plotEquityPoints\)/, 'exact zero crossing projection');
requireMatch(app, /segment:\{borderColor:[\s\S]{0,180}?EQUITY_POS_COLOR[\s\S]{0,80}?EQUITY_NEG_COLOR/, 'zero-aware equity line colors');
requireMatch(app, /backgroundColor:equityFillGradient/, 'zero-aware gradual equity fill');
requireMatch(app, /id=["']equity-empty["'][\s\S]{0,100}?Log a completed trade/, 'empty equity curve guidance');
rejectMatch(app, /labels:closed\.map\(\(_,i\)=>['"]T['"]\+\(i\+1\)\)/, 'opaque T-number equity labels');
for (const insightCanvas of ['symbol-chart', 'outcome-chart', 'direction-chart', 'day-chart']) {
  requireMatch(app, new RegExp(`id=["']${insightCanvas}["']`), `dashboard insight canvas ${insightCanvas}`);
}
requireMatch(app, /function renderDashboardInsights[\s\S]*?realizedLedgerForTrades\(src\)/, 'dashboard insights use the actual-date realised-event ledger');
requireMatch(app, /const day=String\(event\.ledgerDate\|\|''\)\.slice\(0,10\)/, 'day consistency canonicalizes timestamp dates');
requireMatch(app, /\.insight-ring-wrap canvas\{width:100%!important;height:100%!important\}/, 'dashboard ring canvases have bounded empty-state dimensions');
requireMatch(app, /\.insight-ring-wrap\{[^}]*width:118px;height:118px/, 'prominent dashboard outcome rings');
requireMatch(app, /class=["']insight-mini-card insight-ring-card["'][\s\S]{0,220}?Outcome Mix/, 'outcome card visual treatment');
requireMatch(app, /class=["']insight-mini-card insight-ring-card["'][\s\S]{0,220}?Day Consistency/, 'day-consistency card visual treatment');
requireMatch(app, /bySymbol[\s\S]{0,500}?Math\.abs\(b\.pnl\)-Math\.abs\(a\.pnl\)/, 'signed symbol P&L ranking retains gains and losses');
requireMatch(app, /outcomeCounts=\[outcomes\.filter\(value=>value>0\)[\s\S]{0,160}?value===0/, 'outcome mix includes break-even trades');
requireMatch(app, /dayCounts=\[dayValues\.filter\(value=>value>\.005\)[\s\S]{0,180}?Math\.abs\(value\)<=\.005/, 'day consistency includes profitable losing and flat days');
rejectMatch(app, /id=["']asset-chart["']|Object\.keys\(apnl\)\.filter\(k=>apnl\[k\]>0\)/, 'positive-only asset-class doughnut');

// Daily Journal dictation must remain a review-first, browser-native feature:
// append to existing notes, expose live status, and never save automatically.
const journalVoiceSource = sourceBetween('let djVoiceRecognition', 'function djStorageKey');
requireMatch(app, /id=["']dj-voice-btn["'][\s\S]{0,180}?djToggleVoiceJournal\(\)/, 'visible Daily Journal voice control');
requireMatch(app, /id=["']dj-voice-status["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/, 'accessible live dictation status');
requireMatch(journalVoiceSource, /window\.SpeechRecognition\|\|window\.webkitSpeechRecognition/, 'browser speech-recognition compatibility');
requireMatch(journalVoiceSource, /djVoiceBaseText=textarea\.value/, 'voice transcript preserves existing journal notes');
requireMatch(journalVoiceSource, /textarea\.value=djJoinVoiceText/, 'voice transcript appends through the safe text-value boundary');
requireMatch(journalVoiceSource, /Transcript added[^\n]*review it[^\n]*save the entry/, 'review-before-save dictation completion state');
rejectMatch(journalVoiceSource, /djAutoSave|djSaveEntry/, 'automatic persistence from voice dictation');
const tradeVoiceSource = sourceBetween('const TRADE_VOICE_TARGETS', 'function openTradeModal');
for (const target of ['t-psych-prethought', 't-psych-execution', 't-psych-review', 't-notes']) {
  requireMatch(app, new RegExp(`data-voice-target=["']${target}["'][\\s\\S]{0,160}?toggleTradeVoice\\('${target}'\\)`), `trade dictation control for ${target}`);
  requireMatch(app, new RegExp(`id=["']voice-status-${target}["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']`), `accessible trade dictation status for ${target}`);
}
requireMatch(app, /\.trade-voice-wave b\{[^}]*animation:tradeVoiceWave/, 'animated live trade dictation waveform');
requireMatch(tradeVoiceSource, /window\.SpeechRecognition\|\|window\.webkitSpeechRecognition/, 'trade speech-recognition compatibility');
requireMatch(tradeVoiceSource, /tradeVoiceBaseText=textarea\.value/, 'trade dictation preserves existing text');
requireMatch(tradeVoiceSource, /textarea\.value=tradeJoinVoiceText/, 'trade dictation appends through the safe text-value boundary');
requireMatch(tradeVoiceSource, /Transcript added[^\n]*review it before saving the trade/, 'review-before-save trade dictation completion state');
rejectMatch(tradeVoiceSource, /saveTrade\s*\(/, 'automatic trade persistence from voice dictation');
const equityProjectionSource = sourceBetween('function equityTradeTimestamp', 'function signedMoney');
const equityAxisDomainSource = sourceBetween('function equityAxisDomain', 'function setDashboardInsightEmpty');
const equityProjectionContext = {};
vm.runInNewContext(`
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
  const stops=[];
  equityFillGradient({chart:{chartArea:{top:0,bottom:100},scales:{y:{getPixelForValue:()=>40}},ctx:{createLinearGradient:()=>({addColorStop:(offset,color)=>stops.push([offset,color])})}}});
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
  failures.push('Equity color boundary is not projected at the exact zero crossing');
}
if (equityProjectionContext.gradientStops?.length !== 4 || !equityProjectionContext.gradientStops[0]?.[1]?.includes('34,201,135') || !equityProjectionContext.gradientStops[3]?.[1]?.includes('255,94,106')) {
  failures.push('Equity area gradient does not transition from positive green to negative red');
}
if (equityProjectionContext.axisDomain?.min !== -3348 || equityProjectionContext.axisDomain?.max !== 3148) {
  failures.push('Equity axis does not stay close to the actual visible P&L range');
}

try {
  const { exports: duplicateFixture } = evaluateSecurityFixture(
    duplicateResolutionSource,
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
      realizedLedgerForTrades: source => source,
      isRealIsoDate: value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)),
      safeAccountColor: value => value,
      escapeHtml: value => String(value),
      signedMoney: (value, symbol) => `${Number(value) < 0 ? '-' : Number(value) > 0 ? '+' : ''}${symbol}${Math.abs(Number(value)).toFixed(0)}`,
      equityMoneyTick: (value, symbol) => `${symbol}${value}`,
    },
    '{renderDashboardInsights}',
  );
  const realised = [
    { symbol: 'XAUUSD', ledgerDate: '2026-08-01T00:00:00.000Z', ledgerPnl: 120, direction: 'Long', accountId: 'a' },
    { symbol: 'BTCUSD', ledgerDate: '2026-08-02', ledgerPnl: -200, direction: 'Short', accountId: 'a' },
    { symbol: 'XAUUSD', ledgerDate: '2026-08-02', ledgerPnl: -20, direction: 'Long', accountId: 'a' },
    { symbol: 'EURUSD', ledgerDate: '2026-08-03', ledgerPnl: 0, direction: 'Short', accountId: 'a' },
  ];
  const closedOutcomes = [
    { pnl: 100, direction: 'Long', accountId: 'a' },
    { pnl: -200, direction: 'Short', accountId: 'a' },
    { pnl: 0, direction: 'Short', accountId: 'a' },
  ];
  insightRenderer.renderDashboardInsights(realised, closedOutcomes, '$', false);
  const symbolConfig = renderedInsightCharts.get('symbol-chart')?.config;
  const outcomeConfig = renderedInsightCharts.get('outcome-chart')?.config;
  const directionConfig = renderedInsightCharts.get('direction-chart')?.config;
  const dayConfig = renderedInsightCharts.get('day-chart')?.config;
  if (symbolConfig?.data?.labels?.[0] !== 'BTCUSD' || symbolConfig?.data?.datasets?.[0]?.data?.[0] !== -200 || !insightDocument.getElementById('symbol-summary').textContent.includes('net -$100')) {
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

// cTrader uses only same-origin OAuth and read-only sync routes. Any archived
// pasted-token controls must remain inaccessible in the VPS runtime.
requireMatch(app, /app\.html\?ctrader=select|callback\?\.state===['"]select['"]/, 'cTrader OAuth account-selection callback');
requireMatch(app, /pendingOAuth\(\)/, 'pending cTrader OAuth grant lookup');
requireMatch(app, /mappedLegacyAccountId/, 'cTrader legacy account mapping');
requireMatch(app, /function applyVpsCtraderPickerDefaults[\s\S]*?existing\?\.mappedLegacyAccountId/, 'cTrader reconnect mapping preservation');
requireMatch(app, /lastSyncStatus/, 'cTrader sync status rendering');
requireMatch(app, /Read-only automatic sync runs in the background/, 'automatic cTrader sync messaging');
requireMatch(app, /function cTraderReviewRevision[\s\S]*?realizedEvents[\s\S]*?executions:/, 'cTrader provider-revision review marker');
requireMatch(app, /function cTraderTradeNeedsReview[\s\S]*?edgebookReview/, 'cTrader needs-review detection');
requireMatch(app, /cfVals\.edgebookReview=\{version:1,providerRevision:cTraderReviewRevision\(existingTrade\)/, 'cTrader review acknowledgement on journal save');
requireMatch(app, /const CTRADER_OWNED_FORM_IDS=[\s\S]*?function setTradeBrokerOwnedMode/, 'cTrader broker-owned form lock');
requireMatch(app, /cTraderReviewBadge\(t\)/, 'cTrader needs-review table badge');
requireMatch(app, /id="sn-brokers"[^>]*showBrokerConnections/, 'dedicated broker sync settings navigation');
requireMatch(app, /cTrader automatic sync[\s\S]*?Setup required[\s\S]*?never paste a broker password, API secret, or access token/, 'visible fail-closed cTrader setup card');
requireMatch(app, /escapeCtraderText\(JSON\.stringify\(id\)\)/, 'safe VPS cTrader inline identifier');
requireMatch(app, /html\[data-auth-mode="vps"\] \.ctrader-legacy-only\{display:none!important\}/, 'legacy cTrader controls hidden in VPS mode');
requireMatch(dataAdapter, /['"]\/ctrader\/oauth\/start['"]/, 'same-origin cTrader OAuth start route');
requireMatch(dataAdapter, /['"]\/ctrader\/oauth\/pending['"]/, 'same-origin cTrader OAuth pending route');
rejectMatch(dataAdapter, /https?:\/\//i, 'absolute URL in VPS data adapter');

try {
  const reviewSource = sourceBetween('const CTRADER_OWNED_FORM_IDS', 'function openTradeModal');
  const reviewStableJson = value => {
    if (Array.isArray(value)) return `[${value.map(reviewStableJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${reviewStableJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
  };
  const { exports: review } = evaluateSecurityFixture(
    reviewSource,
    {
      stableJson: reviewStableJson,
      tradeIsOpen: trade => trade?.isOpen === true || (trade?.isOpen == null && trade?.exit == null && trade?.pnl == null),
    },
    '{cTraderReviewRevision,cTraderTradeNeedsReview}',
  );
  const imported = { source: 'ctrader', isOpen: true, entryAt: '2026-08-11T01:00:00.000Z', brokerData: { realizedEvents: [] }, custom: {} };
  if (!review.cTraderTradeNeedsReview(imported)) failures.push('A newly imported cTrader trade was not marked for review');
  const reviewed = { ...imported, custom: { edgebookReview: { providerRevision: review.cTraderReviewRevision(imported) } } };
  if (review.cTraderTradeNeedsReview(reviewed)) failures.push('An unchanged reviewed cTrader trade remained marked for review');
  const closed = { ...reviewed, isOpen: false, exitAt: '2026-08-11T02:00:00.000Z', brokerData: { realizedEvents: [{ executionId: 'close-1', executedAt: '2026-08-11T02:00:00.000Z', pnl: '12.5' }] } };
  if (!review.cTraderTradeNeedsReview(closed)) failures.push('A newly closed cTrader trade did not return to needs-review state');
} catch (error) {
  failures.push(`cTrader review lifecycle fixture failed: ${error.message}`);
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
    `${csvIdentitySource}\n${csvDocumentIdSource}`,
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
} catch (error) {
  failures.push(`CSV identity fixture failed: ${error.message}`);
}

try {
  const { exports: parser } = evaluateSecurityFixture(csvParserSource, {}, '{parseCSV}');
  const { exports: csvExport } = evaluateSecurityFixture(
    csvExportSource,
    {
      ASSET_LABELS: { eq: 'Equities' },
      tradeIsOpen: trade => trade?.isOpen === true,
      tradeHasPnl: trade => Number.isFinite(Number(trade?.pnl)),
      acctName: () => '@Desk',
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
  }]);
  const journalRows = JSON.parse(JSON.stringify(parser.parseCSV(journalCsv)));
  if (!journalCsv.includes('\r\n') || journalRows.length !== 2 || journalRows[1].length !== 21 || journalRows[1][1] !== "'=CMD()" ||
      journalRows[1][9] !== '-2.00' || journalRows[1][10] !== "'+SUM(1,1)" || journalRows[1][11] !== "'=HYPERLINK(\"bad\")" || journalRows[1][19] !== "'@Desk" || journalRows[1][20] !== 'line 1, "quoted"\nline 2') {
    failures.push('RFC 4180 journal export or spreadsheet-injection protection regressed');
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

requireMatch(app, /const closed=src\.filter\(tradeIsClosedWithPnl\)[^;]*?\.sort\(compareTradeChronology\)/, 'explicit analytics trade chronology sort');
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
    { isRealIsoDate: value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)) },
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
    `${securityHelperSource}\n${duplicateSource}`,
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
    `${securityHelperSource}\n${positionSemanticsSource}\n${screenshotLookupSource}\n${tradeSource}`,
    {
      window: securityWindow,
      getAccount: id => id === account.id ? account : null,
      acctCur: () => maliciousMarkup,
      pnlBreakdown: () => maliciousMarkup,
      cTraderTradeNeedsReview: () => false,
      FUTURES_SPECS: {},
      ASSET_LABELS: { eq: 'Equity', cx: 'Crypto', fx: 'Forex', cm: 'Commodity', ix: 'Index' },
      fmtDate: value => value,
      formatTime: value => value,
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
  const maliciousHeatmapTrade = { strategy: maliciousMarkup, pnl: 10, accountId: null };
  const { exports: heatmapGroup } = evaluateSecurityFixture(
    `${securityHelperSource}\n${positionSemanticsSource}\n${heatmapGroupSource}`,
    {
      document: groupDocument,
      window: securityWindow,
      hmGroup: 'strategy',
      hmSelected: null,
      buildHmAcctFilter() {},
      hmFilteredTrades: () => [maliciousHeatmapTrade],
      buildHmGridWithInsert() {},
      acctCur: () => '$',
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
  const voiceLabel = { textContent: '' };
  const voiceIcon = { className: '' };
  const voiceButton = {
    disabled: false,
    classList: classSet(['dj-voice-btn']),
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    querySelector(selector) { return selector === 'span' ? voiceLabel : selector === 'i' ? voiceIcon : null; },
  };
  const voiceStatus = { textContent: '', classList: classSet(['dj-voice-status']) };
  const voiceNotes = { value: 'Existing note.', readOnly: false };
  const voiceElements = new Map([
    ['dj-voice-btn', voiceButton],
    ['dj-voice-status', voiceStatus],
    ['dj-notes', voiceNotes],
  ]);
  const recognizers = [];
  class FakeSpeechRecognition {
    constructor() { recognizers.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
  }
  const { exports: voice } = evaluateSecurityFixture(
    journalVoiceSource,
    {
      document: { getElementById: id => voiceElements.get(id) || null },
      window: { SpeechRecognition: FakeSpeechRecognition },
      navigator: { language: 'en-IN' },
      djDate: '2026-08-09',
      showToast() {},
    },
    '{djToggleVoiceJournal,djStopVoiceJournal,djJoinVoiceText,djVoiceErrorMessage}',
  );
  voice.djToggleVoiceJournal();
  const recognition = recognizers[0];
  const finalResult = [{ transcript: 'Waited for confirmation' }];
  finalResult.isFinal = true;
  recognition.onresult({ resultIndex: 0, results: [finalResult] });
  const interimResult = [{ transcript: 'while risk stayed small' }];
  interimResult.isFinal = false;
  recognition.onresult({ resultIndex: 0, results: [interimResult] });
  const expectedTranscript = 'Existing note.\nWaited for confirmation while risk stayed small';
  if (!recognition.started || !voiceNotes.readOnly || voiceButton.attributes['aria-pressed'] !== 'true' || voiceNotes.value !== expectedTranscript) {
    failures.push('Daily-journal dictation did not append its live transcript without overwriting existing notes');
  }
  voice.djStopVoiceJournal();
  if (!recognition.stopped || voiceNotes.readOnly || voiceButton.attributes['aria-pressed'] !== 'false' || !/review it.*save/i.test(voiceStatus.textContent)) {
    failures.push('Daily-journal dictation did not return to an editable review-before-save state');
  }
  if (!/permission/i.test(voice.djVoiceErrorMessage('not-allowed'))) {
    failures.push('Daily-journal dictation does not explain blocked microphone permission');
  }
} catch (error) {
  failures.push(`Daily-journal voice fixture failed: ${error.message}`);
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
  const tradeVoiceIcon = { className: '' };
  const tradeVoiceButton = {
    dataset: { voiceTarget: 't-notes' },
    disabled: false,
    title: '',
    classList: classSet(['trade-voice-btn']),
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    querySelector(selector) { return selector === 'i' ? tradeVoiceIcon : null; },
  };
  const tradeVoiceStatus = { textContent: '', classList: classSet(['trade-voice-status']) };
  const tradeVoiceNotes = { value: 'Existing trade note.', readOnly: false };
  const tradeVoiceElements = new Map([
    ['t-notes', tradeVoiceNotes],
    ['voice-status-t-notes', tradeVoiceStatus],
  ]);
  const tradeRecognizers = [];
  class FakeTradeSpeechRecognition {
    constructor() { tradeRecognizers.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
  }
  const tradeVoiceState = "let tradeVoiceRecognition=null,tradeVoiceTarget=null,tradeVoiceBaseText='',tradeVoiceFinalText='',tradeVoiceInterimText='';\n";
  const { exports: tradeVoice } = evaluateSecurityFixture(
    tradeVoiceState + tradeVoiceSource,
    {
      document: {
        getElementById: id => tradeVoiceElements.get(id) || null,
        querySelectorAll: selector => selector === '[data-voice-target]' ? [tradeVoiceButton] : [],
      },
      window: { SpeechRecognition: FakeTradeSpeechRecognition },
      navigator: { language: 'en-IN' },
      showToast() {},
    },
    '{toggleTradeVoice,stopTradeVoice,tradeJoinVoiceText,tradeVoiceErrorMessage}',
  );
  tradeVoice.toggleTradeVoice('t-notes');
  const recognition = tradeRecognizers[0];
  const finalResult = [{ transcript: 'Waited for the sweep' }];
  finalResult.isFinal = true;
  recognition.onresult({ resultIndex: 0, results: [finalResult] });
  const interimResult = [{ transcript: 'before entering' }];
  interimResult.isFinal = false;
  recognition.onresult({ resultIndex: 0, results: [interimResult] });
  const expectedTranscript = 'Existing trade note.\nWaited for the sweep before entering';
  if (!recognition.started || !tradeVoiceNotes.readOnly || tradeVoiceButton.attributes['aria-pressed'] !== 'true' ||
      !tradeVoiceButton.classList.contains('is-listening') || tradeVoiceNotes.value !== expectedTranscript) {
    failures.push('Trade dictation did not append a live transcript with the animated listening state');
  }
  tradeVoice.stopTradeVoice();
  if (!recognition.stopped || tradeVoiceNotes.readOnly || tradeVoiceButton.attributes['aria-pressed'] !== 'false' ||
      !/review it.*saving the trade/i.test(tradeVoiceStatus.textContent)) {
    failures.push('Trade dictation did not return to an editable review-before-save state');
  }
  if (!/permission/i.test(tradeVoice.tradeVoiceErrorMessage('not-allowed'))) {
    failures.push('Trade dictation does not explain blocked microphone permission');
  }
} catch (error) {
  failures.push(`Trade voice fixture failed: ${error.message}`);
}

const coachingFunctions = app.match(/function coachingLabel[\s\S]*?(?=\nasync function openAIReport)/)?.[0];
if (!coachingFunctions) {
  failures.push('Local coaching functions could not be isolated for runtime verification');
} else {
  const coachingContext = {
    tradesForContext: () => [
      { date: '2026-08-01', entryTime: '09:30', pnl: 120, accountId: 'acct_1', strategy: 'Breakout', emotion: 'Calm' },
      { date: '2026-08-02', entryTime: '13:15', pnl: -50, accountId: 'acct_1', strategy: 'Pullback', emotion: 'Anxious' },
      { date: '2026-08-03', entryTime: '09:45', pnl: 80, accountId: 'acct_1', strategy: 'Breakout', emotion: 'Calm' },
    ],
    activePageAcct: { analytics: 'all' },
    FxRates: { toUSD: amount => amount },
    acctCur: () => '$',
    getAccount: () => null,
    compareTradeChronology: (left, right) => `${left?.date || ''}T${left?.entryTime || ''}`.localeCompare(`${right?.date || ''}T${right?.entryTime || ''}`),
    tradeIsOpen: trade => trade?.isOpen === true || (trade?.isOpen == null && trade?.exit == null && trade?.pnl == null),
    tradeHasPnl: trade => trade?.pnl !== null && trade?.pnl !== undefined && Number.isFinite(Number(trade.pnl)),
    tradeIsClosedWithPnl: trade => !(trade?.isOpen === true || (trade?.isOpen == null && trade?.exit == null && trade?.pnl == null)) && trade?.pnl !== null && trade?.pnl !== undefined && Number.isFinite(Number(trade.pnl)),
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
    if (requestPath === '/config') return { ctraderEnabled: true };
    if (requestPath === '/ctrader/oauth/pending') return { grantId: 'grant-1', accounts: [{ ctidTraderAccountId: '42' }] };
    if (requestPath === '/ctrader/connections') return { connections: [{ id: 'connection-1', lastSyncStatus: 'succeeded' }] };
    if (requestPath.endsWith('/status')) return { connection: { id: 'connection-1', lastSyncStatus: 'running' } };
    return {};
  },
  async post(requestPath, body) {
    ctraderCalls.push({ method: 'POST', path: requestPath, body });
    if (requestPath === '/ctrader/oauth/start') return { authorizationUrl: 'https://id.ctrader.com/my/settings/openapi/grantingaccess/', expiresAt: '2026-08-09T00:00:00Z' };
    if (requestPath === '/ctrader/connections') return { connection: { id: 'connection-1' } };
    if (requestPath.endsWith('/sync')) return { syncRunId: 'sync-1', status: 'queued' };
    return null;
  },
};
const ctraderData = createVpsDataAdapter(ctraderApi);
await ctraderData.ctrader.config();
await ctraderData.ctrader.startOAuth();
await ctraderData.ctrader.pendingOAuth();
await ctraderData.ctrader.list();
await ctraderData.ctrader.create({ grantId: 'grant-1', ctidTraderAccountId: '42', mappedLegacyAccountId: 'acct_1', label: 'Demo' });
await ctraderData.ctrader.status('connection-1');
await ctraderData.ctrader.sync('connection-1');
await ctraderData.ctrader.disconnect('connection-1');
const ctraderCreate = ctraderCalls.find(call => call.method === 'POST' && call.path === '/ctrader/connections');
if (ctraderCreate?.body?.mappedLegacyAccountId !== 'acct_1') failures.push('cTrader legacy account mapping was not forwarded');
for (const expectedPath of [
  '/ctrader/oauth/start',
  '/ctrader/oauth/pending',
  '/ctrader/connections',
  '/ctrader/connections/connection-1/status',
  '/ctrader/connections/connection-1/sync',
  '/ctrader/connections/connection-1/disconnect',
]) {
  if (!ctraderCalls.some(call => call.path === expectedPath)) failures.push(`Missing cTrader adapter call ${expectedPath}`);
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

if (failures.length) {
  console.error('Frontend verification failed:\n' + failures.map(item => `- ${item}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('Frontend verification passed.');
}
