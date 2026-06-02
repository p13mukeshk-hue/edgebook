# Edgebook — Trading Journal
## Full Project Context Document v4.0
**Last Updated:** June 2, 2026

---

## 1. Project Overview

Edgebook is a production trading journal web app for serious traders — live at **https://www.edgebook.trade**. It is already built and deployed. Your job is to continue development: fix bugs, complete partial features, and build remaining ones.

**Do NOT rebuild from scratch. The codebase is live and being used.**

### Core Capabilities
- Manual trade logging (full F&O support: EQ/FUT/CE/PE)
- Automatic broker sync — Zerodha (Kite Connect) + cTrader (fully working)
- Auto-reconciliation of open positions every 5 minutes
- CSV import with broker column mapping
- AI coaching reports (6 report types — Cloud Function proxy needed)
- Analytics: equity curve, win rate, profit factor, asset distribution
- Drawdown tracker (UI done, logic partial)
- Risk manager (UI exists, nearly empty)
- Mood/psychology tracking
- Daily journal with auto-save
- Multi-account support
- Dark/light theme

---

## 2. Tech Stack

| Component | Technology | Details |
|-----------|-----------|---------|
| Frontend | Vanilla JS / HTML / CSS | Single file: `app.html` (~6000+ lines) |
| Backend | Firebase Cloud Functions | Node.js 20, `functions/index.js` (~2500+ lines) |
| Database | Cloud Firestore | NoSQL, per-user document collections |
| Auth | Firebase Auth | Google OAuth + guest mode (localStorage) |
| Hosting | Firebase Hosting | Auto-deploy via GitHub Actions |
| Charts | Chart.js | Already imported in app.html |
| Icons | Font Awesome | Already imported |
| Live URL | Custom domain | www.edgebook.trade / edgebook.trade |
| GitHub | Public repo | github.com/p13mukeshk-hue/edgebook |
| Firebase | Project ID | edgebook-2dce2 |

---

## 3. Repository Structure

```
edgebook/
├── app.html                  # Main SPA — ALL JS/CSS/HTML in one file (~6000 lines)
├── index.html                # Landing page — CTAs route to /app.html
├── landing.html              # Marketing landing page
├── CONTEXT.md                # This file — project context for AI sessions
├── functions/
│   ├── index.js              # All Cloud Functions (~2500+ lines)
│   └── package.json          # firebase-admin 12, firebase-functions 4.9, kiteconnect 5
├── firebase.json             # Hosting + function rewrites config
├── firestore.rules           # Firestore security rules
├── firestore.indexes.json    # Composite indexes
└── .github/workflows/        # CI/CD — auto-deploys on push to main
```

---

## 4. CRITICAL — Deployment Rules

**`git push` alone does NOT update the live site.**

```bash
# app.html changes → deploy hosting:
git add app.html
git commit -m "fix: description"
git push
firebase deploy --only hosting

# functions/index.js changes → deploy functions:
git add functions/index.js
git commit -m "feat: description"
git push
firebase deploy --only functions

# firestore.rules changes:
firebase deploy --only firestore:rules

# Both changed:
firebase deploy --only hosting,functions
```

Always test on **https://www.edgebook.trade/app.html** after deploy.

---

## 5. Cloud Functions Status

| Function | Type | Purpose | Status |
|----------|------|---------|--------|
| `zerodhaLogin` | HTTP | Returns Kite OAuth login URL | ✅ Working |
| `zerodhaCallback` | HTTP | Exchanges auth code, stores token | ✅ Working |
| `syncZerodhaTrades` | HTTP | Manual on-demand Zerodha sync | ✅ Working |
| `zerodhaPostback` | HTTP | Webhook on order COMPLETE | ✅ Working |
| `marketHoursTradeSync` | Pub/Sub 5min | Scheduled Zerodha sync IST hours | ✅ Working |
| `scheduledTradeSync` | Pub/Sub daily | EOD backup Zerodha at 6pm IST | ✅ Working |
| `syncZerodhaHistory` | HTTP | 90-day historical Zerodha import | ✅ Working |
| `ctraderConnect` | HTTP | Connects cTrader, caches symbol map | ✅ Working |
| `syncCtraderTrades` | HTTP | Manual on-demand cTrader sync | ✅ Working |
| `syncCtraderHistory` | HTTP | Bulk historical import by positionId | ✅ Working |
| `ctraderScheduledSync` | Pub/Sub 5min | Scheduled cTrader sync 24/7 | ✅ Working |
| `forceReimportCtrader` | HTTP | Reconcile & sync all cTrader trades | ✅ Working |
| `forceReimportZerodha` | HTTP | Reconcile & sync all Zerodha trades | ✅ Working |
| `ctraderAddAccount` | HTTP | Add new cTrader account by accountId | ✅ Working |
| `aiCoachingReport` | HTTP | Proxy Anthropic API for AI reports | ❌ Not built |

---

## 6. Firestore Data Schema

### `users/{uid}/trades/{tradeId}`

```javascript
{
  // EXECUTION FIELDS — updated by broker sync
  id: string,              // zerodha_<sym>_<date>_<entry> OR ctrader_<positionId>
  source: string,          // 'manual' | 'zerodha' | 'ctrader' | 'csv'
  brokerTradeId: string,   // broker's own reference ID (for dedup)
  symbol: string,          // e.g. EURUSD, XAUUSD, NIFTY26519
  asset: string,           // 'eq' | 'cm' | 'fx' | 'cr'
  instrument: string,      // 'Options' | 'Futures' | null
  optionType: string,      // 'CE' | 'PE' | null
  strike: number,          // options strike price
  expiry: string,          // YYYY-MM-DD for F&O
  direction: string,       // 'Long' | 'Short'
  entry: number,           // entry execution price
  exit: number|null,       // exit price, null if position open
  size: number,            // lots / shares / units
  pnl: number|null,        // profit/loss in account currency, null if open
  isOpen: boolean,         // true = position still open
  date: string,            // YYYY-MM-DD (entry date)
  entryTime: string,       // HH:MM
  exitTime: string|null,   // HH:MM or null
  accountId: string,       // which account this trade belongs to
  exchange: string,        // NSE, BSE, MCX, FOREX etc
  product: string,         // MIS, CNC, NRML or similar
  syncedAt: timestamp,     // last broker sync timestamp
  deleted: boolean,        // true = archived, undefined/false = active
  deletedAt: string,       // YYYY-MM-DD when archived, null if not deleted
  groupingMode: string,    // 'fifo' | 'combined' — how trade was imported
  needsReview: boolean,    // true = uncertain pairing, flag for user review

  // USER FIELDS — NEVER overwritten by any sync operation
  strategy: string,
  emotion: string,
  notes: string,
  screenshots: [{src: string, name: string}],  // OBJECTS not strings
  psychology: {
    preThought: string,
    executionNote: string,
    review: string
  },
  tags: string[]
}
```

### `users/{uid}/brokers/{brokerDocId}`

```javascript
// Zerodha
{
  accessToken: string,      // encrypted via encrypt()
  connected: boolean,
  lastSyncTimestamp: timestamp
}

// cTrader — CRITICAL token format (see Section 7)
{
  accountId: string,        // e.g. '5032134' or '5043464'
  accountLabel: string,     // e.g. '100K 2 Step' or '25K 2 Step'
  token: string,            // FULL base64 MCP config blob — never decoded
  connected: boolean,       // only written by ctraderConnect, never by sync
  lastSyncTimestamp: timestamp,
  lastSyncResult: {
    saved: number,
    skipped: number,
    errors: number,
    durationMs: number
  }
}
```

### Other Collections
- `users/{uid}/pendingDuplicates/{id}` — Duplicates awaiting user resolution
- `users/{uid}/settings` — Accounts, brokerAccountMap, preferences, riskSettings
- `users/{uid}/notifications/{notifId}` — Notification center items
- `users/{uid}/meta/{doc}` — Settings sync across devices
- `system/ctrader.symbolDetails` — Symbol cache (132 symbols, 6hr TTL)

### Firestore Rules
```
match /users/{uid}/{document=**} {
  allow read, write: if request.auth.uid == uid;
}
match /system/{doc} {
  allow read: if request.auth != null;
  allow write: if false; // Cloud Functions only
}
```

---

## 7. Broker Integration Details

### Zerodha (Kite Connect)
- **SDK:** kiteconnect v5
- **Auth:** `zerodhaLogin` → Kite OAuth → `zerodhaCallback` → stores token
- **Endpoints:** `kite.getTrades()`, `kite.getOrders()`, `kite.getPositions()`
- **Trade pairing:** FIFO BUY+SELL fills by symbol — dual queue (see Rule 11)
- **F&O mapping:** EQ/FUT/CE/PE → asset + instrument + optionType
- **Market hours:** 9:10am–3:40pm IST, Mon–Fri
- **Doc ID:** `zerodha_<tradingsymbol>_<date>_<entryPrice>`
- **History:** 90-day via `syncZerodhaHistory`
- **Two-source model:** same-day trades via API sync; historical trades via CSV import

### cTrader
- **API:** cTrader MCP HTTP at `https://mcp.ctrader.com/trading/mcp`
- **Auth:** Bearer token (~30 days validity) stored in Firestore
- **CRITICAL — Token format:** Store the FULL base64 MCP config blob as-is in `token` field
  - Example: `eyJwbGFudCI6InRoZTVlcnMiLCJlbnZpcm9ubWVudCI6ImxpdmUiLCJ0b2tlbiI6Ii4uLiJ9`
  - Never decode before storage. Never encrypt. Pass directly to Authorization header.
  - Each account has its own unique blob — copy from its own cTrader session on The5ers
- **Endpoints:** `get_deals`, `get_symbols`
- **Account filtering:** `get_deals` API ignores `accountId` param — fetch all deals, filter client-side by `deal.accountId === brokerData.accountId`
- **Auto-reconciliation:** `reconcileOpenPositions()` runs at end of EVERY sync
- **CRITICAL facts:**
  - API never sends `pnl` or `dealType` — use `tradeSide` pairing
  - Collect ALL deals from ALL chunks FIRST, then group by `positionId`
  - Symbol names: `XAU/USD` not `XAUUSD` — normalise before lookup
  - `lotSize` not from API — use `LOT_SIZE_DEFAULTS` map
- **Doc ID:** `ctrader_<positionId>` (legacy) or `ctrader_{accountId}_{positionId}` (new)
- **`connected` field:** ONLY written by `ctraderConnect` on successful connection. Sync failures NEVER write `connected:false` — only update `lastSyncResult`.

### cTrader Accounts (The5ers)
| Doc ID | accountId | accountLabel | Token source |
|--------|-----------|--------------|-------------|
| `brokers/ctrader` | (legacy) | — | accessToken field, encrypted |
| `brokers/ctrader_5032134` | 5032134 | 100K 2 Step | Copy MCP config from 100K session |
| `brokers/ctrader_5043464` | 5043464 | 25K 2 Step | Copy MCP config from 25K session |

### Shoonya by Finvasia
- Placeholder UI in Settings → Brokers. No code written.

---

## 8. Key Architectural Rules

### Rule 1 — User Fields Are Sacred
NEVER overwrite: `strategy`, `emotion`, `notes`, `screenshots`, `psychology`, `tags`, `deleted`, `deletedAt`, `accountId`
```javascript
await docRef.set({
  ...brokerData,
  strategy: existing?.strategy ?? null,
  emotion: existing?.emotion ?? null,
  notes: existing?.notes ?? null,
  screenshots: existing?.screenshots ?? [],
  psychology: existing?.psychology ?? {},
  tags: existing?.tags ?? []
}, { merge: true });
```

### Rule 2 — Trades in Firestore Only (Not localStorage)
Authenticated users: trades live ONLY in Firestore + memory.
localStorage is ONLY for guest mode trades and settings.
```javascript
// On boot, clear old oversized localStorage key:
localStorage.removeItem('tradedesk_trades_' + uid);
```

### Rule 3 — Post Re-import Session Flag
Force re-import sets `sessionStorage.setItem('post_reimport', '1')` before reload.
On boot, if flag present:
- Clear flag immediately
- Skip `seedSampleData()`
- Use `loadFromFirestore({ forceServer: true })`

### Rule 4 — Always Quote IDs in onclick
```javascript
// CORRECT:
onclick="openTradeModal('${t.id}')"
onclick="openLightbox('${t.id}', 0)"
// WRONG (causes SyntaxError for IDs with dashes):
onclick="openTradeModal(${t.id})"
```

### Rule 5 — Screenshots Are Objects
```javascript
// CORRECT:
screenshots: [{ src: 'base64...', name: 'chart.png' }]
// Use helpers:
function getThumbSrc(trade) {
  const first = trade.screenshots?.[0];
  return first?.src ?? (typeof first === 'string' ? first : null);
}
function getLightboxSrcs(trade) {
  return (trade.screenshots ?? [])
    .map(s => typeof s === 'object' ? s.src : s)
    .filter(Boolean);
}
```

### Rule 6 — CORS on Every HTTP Function
```javascript
const ALLOWED_ORIGINS = [
  'https://www.edgebook.trade',  // www. is CRITICAL
  'https://edgebook.trade',
  'https://edgebook-2dce2.web.app',
  'https://edgebook-2dce2.firebaseapp.com',
  'http://localhost:5000',
  'http://localhost:3000'
];
// Call at top of every HTTP handler + handle OPTIONS
```

### Rule 7 — Sanitize Before Firestore Batch
```javascript
function sanitizeUserFields(f) {
  return {
    strategy: f.strategy ?? null,
    emotion: f.emotion ?? null,
    notes: f.notes ?? null,
    tags: Array.isArray(f.tags) ? f.tags.filter(t => typeof t === 'string') : [],
    screenshots: Array.isArray(f.screenshots)
      ? f.screenshots.filter(s => s?.src && s.src.length < 900000)
          .map(s => ({ src: s.src, name: s.name ?? '' }))
      : [],
    psychology: {
      preThought: f.psychology?.preThought ?? null,
      executionNote: f.psychology?.executionNote ?? null,
      review: f.psychology?.review ?? null
    }
  };
}
```

### Rule 8 — Date Format
- UI: `DD/MM/YY` via `formatDate()` helper
- Firestore: `YYYY-MM-DD` (never change)
- HTML inputs: `YYYY-MM-DD`

### Rule 9 — Trade Sort Order
```javascript
// Always newest first:
trades.sort((a, b) => {
  const dateCompare = (b.date ?? '').localeCompare(a.date ?? '');
  if (dateCompare !== 0) return dateCompare;
  return (b.entryTime ?? '99:99').localeCompare(a.entryTime ?? '99:99');
});
```

### Rule 10 — cTrader: All Chunks Before Grouping
```javascript
// CORRECT — collect all, then group:
const allDeals = [];
for (const chunk of chunks) allDeals.push(...await fetchChunk(chunk));
const byPosition = {};
for (const deal of allDeals) {
  if (!byPosition[deal.positionId]) byPosition[deal.positionId] = [];
  byPosition[deal.positionId].push(deal);
}
// WRONG — never group per-chunk (breaks cross-month positions)
```

### Rule 11 — Zerodha FIFO: Dual Queue for Direction Detection
```javascript
// Opening side detected from FIRST fill, not hardcoded
// BUY into empty sellQueue → opens Long (push to buyQueue)
// SELL into empty buyQueue → opens Short (push to sellQueue)
// BUY with sellQueue non-empty → closes Short
// SELL with buyQueue non-empty → closes Long
// Never assume BUY=open — option selling opens with SELL
```

### Rule 12 — Never Delete, Never Auto-Delete
- Sync functions NEVER delete Firestore documents
- Reconcile marks uncertain trades with `needsReview:true`, never deletes
- User deletes = soft delete (`deleted:true`) only
- Permanent delete only from Danger Zone with double confirm
- Broker trades: soft delete survives sync (hard delete causes re-appear)

### Rule 13 — Section Markers in app.html
```
DO NOT edit any section marked DO NOT EDIT.
Search for § to find section boundaries.
```
Protected sections:
- `§ SETTINGS MANAGER` — SettingsManager object
- `§ DATA NORMALISATION` — normaliseFsTrade()
- `§ FIRESTORE SYNC` — startTradesListener(), loadFromFirestore
- `§ P&L ENGINE` — calculatePnL(), pnlBreakdown()
- `§ TRADE FORM` — openTradeModal(), validateTrade(), saveTrade()
- `§ DELETE & ARCHIVE` — deleteTrade(), restoreTrade(), permanentDeleteTrade()
- `§ TRADE TABLE` — refreshAll(), tradeRow(), getBaseFilteredTrades(), renderTradeTable()

---

## 9. Feature Status

### ✅ Complete and Working
- Firebase Auth (Google OAuth, guest mode)
- Landing page CTAs → app.html, auto-redirect
- Manual trade entry with full F&O support
- Trade log: pagination 50/page, newest first, quick filters
- Quick filter pills [All][Long][Short][Open][Closed][Winners][Losers]
- Source badges (Manual/Zerodha/cTrader/CSV)
- Psychology fields in edit modal
- Screenshot module (upload, lightbox, thumbnails for all trade types)
- Duplicate resolution modal (3-way)
- Zerodha OAuth + sync + history import
- cTrader sync + history import
- Auto-reconciliation of open positions every 5 min
- Multi-cTrader account support (100K + 25K 2 Step)
- Force re-import / Reconcile & sync (both brokers, user fields preserved)
- Soft delete system (archive, restore, permanent delete)
- Notification center (bell icon, real-time, Firestore-backed)
- Broker account mapping UI
- Settings sync across devices
- Real-time Firestore onSnapshot listener
- Date format DD/MM/YY everywhere
- Toast (5s, copy button)
- Edit button all trade types
- Notes/psychology → Firestore
- Trades in Firestore only (localStorage quota fix)
- Section markers in app.html
- FIFO dual-queue pairing (SELL=open for option selling)
- `ctraderAddAccount` Cloud Function

### ⚠️ Partially Working
- Zerodha entry timestamps — fix deployed, needs verification on next trade
- Zerodha lot size (NIFTY showing 65 instead of 1) — needs next trade to verify
- Drawdown Tracker — UI done, render logic partial
- Mood vs P&L correlation — not connected
- Equity curve — only closed trades shown, X-axis labels deferred

### ❌ Not Yet Built
- AI Coaching Reports (needs Cloud Function proxy)
- Risk Manager (position sizing, daily loss, exposure chart)
- Monte Carlo simulation (JS logic missing)
- Zerodha CSV import rewrite (FIFO pairing, F&O parsing)
- P&L by time-of-day chart
- Table column sorting
- Shoonya by Finvasia integration
- Node.js runtime upgrade (nodejs20 → nodejs22, due Oct 30 2026)
- functions/index.js restructure into modules

---

## 10. Lessons Learned

| Mistake | What Happened | Fix Applied |
|---------|--------------|-------------|
| Unquoted IDs in onclick | SyntaxError for broker trade IDs | Always quote: `'${t.id}'` |
| CORS missing www. | All broker connections failed | Added `https://www.edgebook.trade` |
| Batch write with screenshots | Silent failure, quota exceeded | Individual `doc.set()` calls |
| Screenshots as strings | Firestore invalid entity error | Store as `{src, name}` objects |
| Group deals per chunk | Cross-month positions never close | Collect all deals first |
| getDocs (cached) | Stale data after re-import | `getDocsFromServer` + sessionStorage flag |
| Trades in localStorage | Quota exceeded with 54+ trades | Firestore only for auth users |
| seedSampleData after reload | Sample trades overwrote real data | Skip on post-reimport flag |
| async polling before popup | Browser blocks popup silently | Enable button after firebase-ready |
| git push only | Live site not updated | Always `firebase deploy` too |
| Incremental sync missed closes | Closed positions stayed LIVE | `reconcileOpenPositions()` on every sync |
| FIFO assumed BUY=open | Option selling (SELL=open) paired wrong fills | Dual queue — detect opening side from first fill |
| cTrader token decoded before storage | 401 on every 25K sync | Store full base64 MCP config blob raw, never decode |
| `connected:false` written on sync failure | Broker cards disappeared after any error | Sync failures only update `lastSyncResult`, never `connected` |
| Manual Firestore broker doc creation | Wrong token format, hours of debugging | Always use UI connection flow, never manually create broker docs |
| cTrader API token format | Full base64 MCP config blob is the bearer token | Pass raw to Authorization header — `readBrokerToken()` returns as-is |
| cTrader `get_deals` accountId param | API ignores it, returns all deals regardless | Filter client-side: `deal.accountId === brokerData.accountId` |
| `syncCtraderTrades` not passing brokerDocId | Manual sync always used default 'ctrader' doc | HTTP handler now reads `req.body.brokerDocId` and passes through |
| loadCtraderConnections filtered connected:true | Both cards disappeared when all accounts had errors | Render ALL ctrader* docs regardless of connected state |

---

## 11. Improvement Suggestions (Not Yet Started)

### High Impact
1. **Mobile responsive** — Add CSS media queries (traders use phones)
2. **Trade templates** — Save setups as templates, one-click pre-fill
3. **Streak tracker** — Current win/loss streak widget on dashboard
4. **Commission tracker** — Track brokerage paid, net vs gross P&L
5. **Pre-trade checklist** — 3 questions before logging a trade

### Medium Impact
6. **Keyboard shortcuts** — N=new trade, J=journal, D=dashboard, Esc=close
7. **Bulk tag editor** — Select multiple trades, apply tag in one action
8. **Best/worst day of week** — Bar chart of Mon–Fri performance
9. **Angel One / Upstox** — Popular Indian brokers on landing page
10. **Export to Excel** — Formatted .xlsx with charts

### Lower Impact
11. **PWA support** — Offline access, mobile install
12. **Audit log** — Track all changes to trades
13. **Node.js upgrade** — nodejs20 → nodejs22 before Oct 30 2026

---

## 12. Environment

```
Firebase Project:  edgebook-2dce2
Region:            us-central1
Runtime:           nodejs20 (upgrade to nodejs22 by Oct 30 2026)
Live URL:          https://www.edgebook.trade/app.html
GitHub:            https://github.com/p13mukeshk-hue/edgebook
Auth domains:      www.edgebook.trade, edgebook.trade,
                   edgebook-2dce2.web.app, localhost
```

---

## 13. Testing Checklist

- [ ] Hard refresh (Cmd+Shift+R)
- [ ] No red errors in F12 Console
- [ ] Trades load on dashboard and journal
- [ ] Dates show as DD/MM/YY
- [ ] Edit works: manual, Zerodha, cTrader trades
- [ ] Notes survive force re-import
- [ ] Screenshot lightbox opens
- [ ] Quick filter pills correct counts
- [ ] Pagination works (50/page, newest first)
- [ ] cTrader closed trade auto-updates within 5 min
- [ ] Force re-import → page reloads → all trades visible
- [ ] No "data required" error on broker trade save
- [ ] Both cTrader cards visible in Settings → Import/Export
- [ ] 25K account syncs independently from 100K

---

## 14. Session Updates — May 21, 2026

### Bugs Fixed (Full Audit Pass)
All 11 bugs found in comprehensive audit were fixed in one pass:

1. **Settings never synced to Firestore** — dead code after `return true` in `_save()`. Fixed: Firestore sync now runs, settings loaded from Firestore on login.
2. **Firestore write failure invisible** — `saveTrade()` now shows error toast if Firestore write fails.
3. **`_syncTrades` overwrote without merge** — changed `batch.set(ref, tr)` to `batch.set(ref, tr, {merge:true})` preventing Cloud Function fields being reverted.
4. **Legacy `normaliseFsTrade` stripped fields** — added 9 missing fields (psychology, tags, isOpen, entryTime etc.) to legacy mapping path.
5. **Source defaulted to 'zerodha'** — changed `source: t.source || 'zerodha'` to `|| 'manual'`.
6. **TODAY used UTC not IST** — fixed to use IST offset everywhere including mood timestamps and edit-trade date fallback.
7. **Zerodha postback had no HMAC verification** — added SHA256 checksum validation against `ZERODHA_API_SECRET`.
8. **Debug `console.log('[thumb]')` on every render** — removed.
9. **Silent no-op editing deleted trade** — now shows error toast and returns early.
10. **Open/Closed filter double-counted trades** — unified filter logic across all three filter functions.
11. **`backfillCtraderTimes` returned 200 for errors** — now returns 503 for connection/token errors.

### New Features Added
- **Date format** — changed to "19 May" format everywhere in UI
- **Entry time column** — new TIME column in trade table, shows 12hr IST format (e.g. "9:15 AM")
- **Entry time auto-fill** — new trade modal auto-fills date and time in IST on open
- **IST time conversion** — cTrader UTC times converted to IST in Cloud Functions
- **Auto IST backfill** — runs silently once on first login via sessionStorage flag
- **Force re-import moved to Advanced section** — hidden by default, shows warning text
- **Sync descriptions updated** — clear text explaining auto-sync schedule per broker
- **cTrader 24-hour lookback** — sync always looks back 24h minimum, no trades ever missed

### Workflow Design (Finalised)
Three-tier data update model:
- **Tier 1 — Auto sync** (every 5 min): handles new trades + closing open positions automatically
- **Tier 2 — Sync now** (manual): same as auto but on-demand, go-to button for users
- **Tier 3 — Force re-import** (hidden in Advanced): only for corrupted data, never for format fixes

### Critical Fix — cTrader Sync Window
**Problem:** `lastSyncTimestamp` corruption caused sync to fetch only a 35-minute window, missing trades.
**Fix:** `fromTimestamp = Math.min(lastSyncMs - 30min, oneDayAgoMs)` — always looks back at least 24 hours. Dedup check prevents duplicates.

### Architecture Note — Backfill Pattern
For data migrations (format fixes, field additions):
- Never use force re-import
- Create a targeted Cloud Function (e.g. `backfillCtraderTimes`)
- Run it automatically once via `localStorage` flag on login
- No user action needed

---

## 15. Session Updates — May 22, 2026

### Features Built

#### Soft Delete System (complete)
- **Archive trades** — trash icon now soft-deletes (sets `deleted:true` + `deletedAt` in Firestore)
- **Confirm dialog** — "Archive trade?" with clear message and restore instructions
- **Filtered out everywhere** — `loadFromFirestore()` filter `&& !t.deleted` excludes archived trades from ALL views
- **CSV export** — excludes archived trades by default
- **Archived trades section** — Settings → Danger Zone → filterable by symbol, account, source
- **Restore** — per-row restore button, clears `deleted`/`deletedAt`, trade reappears in journal
- **Restore all** — bulk restore button
- **Permanent delete** — per-row with double confirm, removes Firestore doc entirely
- **Survives sync** — `deleted`/`deletedAt` treated as user fields, preserved on all syncs and force re-import

#### Notification Center (complete)
- Bell icon in topbar with red unread badge
- Slide-out panel (360px, z-index 300) with real-time onSnapshot listener
- createNotification() / markNotifRead() / markAllRead() / relativeTime()
- Auto-triggers: sync completion, unassigned trades, token expiry, duplicates
- Firestore-backed: `users/{uid}/notifications/{notifId}`

#### Broker Account Mapping UI (complete)
- Each broker card shows "Maps to account →" dropdown
- Saves to `S.brokerAccountMap` in settings

#### Settings Sync Across Devices (complete)
- `SettingsManager._save()` correctly writes to Firestore
- Settings load from Firestore on login with field-by-field merge
- Firestore rule added for `users/{uid}/meta/{doc}`

### Real-time Updates
- **Firestore onSnapshot on trades** — `startTradesListener(uid)` opens a persistent listener at boot
- `docChanges()` handles added/modified/removed incrementally
- Modal safety — `refreshAll()` skipped while any modal is open
- **Tab focus refresh** — `visibilitychange` calls `refreshAll()` after 30s away
- **Cross-device sync** — changes on one device appear on another in ~1 second

---

## 16. Session Updates — May 27-28, 2026

### Zerodha Sync — Complete Rewrite

#### Root cause of all Zerodha bugs
The sync was using FIFO fill pairing incorrectly:
- Orphan SELL fills created phantom Short trades
- reconcileOpenZerodhaPositions() was auto-deleting trades
- needsReview batch was never committed

#### Final Zerodha sync architecture
**pairFillsIntoTrades():**
- FIFO pairs BUY+SELL fills by symbol
- Orphan SELL + existing open Long → closes the Long
- Orphan SELL + no Long → creates Short with needsReview:true
- Never creates phantom trades silently

**reconcileOpenZerodhaPositions():**
- Case 1: still open in Kite → skip
- Case 2: expired options (qty=0, realised_pnl set) → close with last_price
- Case 3: closed today (day positions) → close with realised_pnl
- Case 4: uncertain → needsReview:true flag only, NEVER delete
- Aborts entirely if getPositions() fails

#### Trade grouping toggle
- Settings → General → Trade Import Preferences
- "Per round trip" (FIFO, default) vs "Combined" (positions API)
- Saves to S.prefs.tradeGrouping

---

## 17. Session Updates — May 31, 2026

### Golden Rule Implemented — Never Delete
- forceReimportCtrader and forceReimportZerodha no longer delete any Firestore documents
- Both now use reconcile-only approach
- Button renamed "Reconcile & sync"

### Zerodha Sync Architecture (Final)
Two-source model:
- Source 1: 5-min scheduled sync (same-day trades)
- Source 2: CSV import (historical trades)

### Lot Size and Labels Fixed
- getZerodhaLotSize(): NIFTY updated 75→65 (NSE Jan 2026)
- pos.multiplier from Kite API used as primary source
- getSizeLabel() helper: Options/Futures → "lot/lots", Equities → "share/shares"

### Remaining Issues with Zerodha CSV Import
NEEDS COMPLETE REWRITE:
- No FIFO pairing (imports each fill separately)
- Wrong asset class for F&O (NFO → crypto instead of eq)
- No lot size conversion
- No F&O symbol parsing
- No matching against existing open trades
- No deterministic doc IDs (creates duplicates)

---

## 18. Session Updates — May 31, 2026 (Evening)

### Multi-cTrader Account Support (Built)
- Firestore schema: users/{uid}/brokers/ctrader_{accountId}
- Legacy 'ctrader' doc preserved for backward compatibility
- syncCtraderForUser() accepts brokerDocId parameter
- ctraderScheduledSync loops over all ctrader_* broker docs
- Settings UI: dynamic cards per connection
- "+ Add cTrader account" button

### Broker UI Redesign
- .broker-account-card — clear card per connection
- Section labels: ZERODHA / CTRADER separators
- .btn-accent CSS rule added
- --radius-lg CSS variable added

### Equity Curve
- X axis date labels attempted but broke the chart — reverted
- Decision deferred to next session

---

## 19. Session Updates — June 1, 2026

### Section Markers Added to app.html
app.html now has protected section markers.
Add this to EVERY Claude Code prompt going forward:

  DO NOT edit any section marked DO NOT EDIT.
  Search for § to find section boundaries.

### Zerodha FIFO Dual Queue Fix
- Root cause: single buyQueue assumed BUY=open always
- Fix: dual FIFO queues detect opening side from first fill
- SELL-first = Short open; BUY-first = Long open
- All three call sites updated: syncZerodhaTrades, syncZerodhaHistory, marketHoursTradeSync

---

## 20. Session Updates — June 2, 2026

### Bugs Fixed

1. **cTrader 25K account (5043464) not syncing — root cause chain (4 layers):**
   - Token was account-scoped: different base64 blob per account on The5ers platform
   - `get_deals` `accountId` param ignored by API — must filter client-side after fetch
   - `syncCtraderTrades` HTTP handler never passed `brokerDocId` to `syncCtraderForUser()`
   - `connected:false` written on 401 caused broker cards to disappear
   - **Fix:** client-side deal filtering, `brokerDocId` wired through, `connected` field protected

2. **Broker cards disappearing after 401**
   - Sync failures no longer write `connected:false`
   - Only `ctraderConnect` writes the `connected` field

3. **`readBrokerToken()` — dual format support**
   - Detects AES-GCM encrypted blobs (`hex:hex:hex`) and decrypts
   - Raw base64 blobs and JWTs pass straight through

4. **`loadCtraderConnections()` showing no cards**
   - Was filtering to `connected:true` only
   - Fix: render ALL `ctrader*` docs regardless of connected state
   - Each card render wrapped in try/catch
   - Called on every Settings open, not only on nav click

5. **Zerodha timestamps missing on June 1 trades**
   - Open position stubs were created with `entryTime: null`
   - Fix: extract time from fill data when creating stubs
   - **Status: deployed, needs verification on next Zerodha trade**

### Architecture Decisions

**cTrader token storage (CRITICAL):**
- Store the FULL base64 MCP config blob as-is in the `token` field
- Never decode before storage. Never encrypt. Pass directly to Authorization header.
- The Authorization header value = `Bearer <full_base64_blob>`
- Each account has its own unique blob — copy from its own session on app.the5ers.com

**Client-side account filtering:**
- `get_deals` fetches ALL deals for the token (API ignores accountId param)
- Filter by `deal.accountId === brokerData.accountId` after fetch
- Same filter in `reconcileOpenPositions()`

### Still Broken (Carry Forward)
- Zerodha entry timestamps — fix deployed, needs verification on next trade
- Lot size showing 65 instead of 1 for NIFTY options — needs next Zerodha trade to verify

### Pending (Next Sessions)
1. Verify timestamp fix and lot size fix on next Zerodha trade
2. **Restructure `functions/index.js` into modules** (schedule for weekend — 3hr session, no new features)
3. AI Coaching Reports (Anthropic API proxy)
4. Risk Manager
5. Zerodha CSV import rewrite
6. Node.js 20→22 upgrade (Oct 30 2026 deadline)

### Restructure Plan (When Scheduled)
Split `functions/index.js` into:
```
functions/
  brokers/
    zerodha.js      — all Zerodha sync logic
    ctrader.js      — all cTrader sync logic
  core/
    sync.js         — shared pairing, reconcile logic
    schema.js       — sanitizeUserFields, field constants
  handlers/
    ai.js           — AI coaching proxy
    notifications.js
  index.js          — imports and exports only (~50 lines)
```
Split `app.html` into src/ files in a follow-up session.
Rule: no new features during restructure sessions.
