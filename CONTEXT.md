# Edgebook — Trading Journal
## Full Project Context Document v3.1
**Last Updated:** June 2, 2026

---

## 1. Project Overview

Edgebook is a production trading journal web app for serious traders — live at **https://www.edgebook.trade**.
Firebase project: `edgebook-2dce2`.

**Stack:** Single-page HTML app (`app.html`), Firebase Hosting, Firebase Firestore, Firebase Cloud Functions (Node.js 20).

**Users:** Single user for now (uid: `XwIgewatPWXNHVwGifCkaIquhFS2`).

---

## 2. Repository Structure

```
/
├── app.html                # Main SPA (~8000 lines) — all frontend
├── index.html              # Landing page
├── landing.html            # Marketing page
├── 404.html
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── storage.rules
└── functions/
    └── index.js            # All Cloud Functions (~4100 lines)
```

---

## 3. Firestore Schema

```
users/{uid}/
  trades/{tradeId}          # All trades (Zerodha + cTrader + manual + CSV)
  orders/{orderId}          # Zerodha orders
  brokers/
    zerodha                 # Zerodha connection state
    ctrader                 # Legacy single-account cTrader doc (100K — may still exist)
    ctrader_5032134         # 100K 2 Step account
    ctrader_5043464         # 25K 2 Step account
  meta/
    settings                # User settings (accounts, brokerAccountMap, prefs, etc.)
  notifications/{id}
  pendingDuplicates/{id}
  orderUpdates/{id}

system/
  ctrader                   # Symbol map cache (symbolDetails, symbolMapUpdatedAt)
```

### Broker doc fields (ctrader_*)
| Field | Type | Description |
|---|---|---|
| `connected` | bool | Whether the account is active — only `ctraderConnect` writes this |
| `accessToken` | string | AES-256-GCM encrypted bearer token (written by `ctraderConnect` / `ctraderAddAccount`) |
| `token` | string | Raw bearer token field (manually-created docs only — `readBrokerToken` handles both) |
| `accountId` | string | cTrader numeric account ID (e.g. "5032134") |
| `accountLabel` | string | User-defined friendly name (e.g. "100K 2 Step") |
| `mapToEdgebookAccountId` | string | Maps this broker account → Edgebook internal account ID |
| `lastSyncTimestamp` | Timestamp | End of last successful sync window |
| `lastSyncAt` | Timestamp | Wall-clock time of last sync |
| `lastSyncResult` | map | `{ saved, skipped, errors, durationMs }` |
| `tokenExpiresAt` | Timestamp | Token expiry (set by ctraderConnect; may be absent on manual docs) |
| `refreshToken` | string | AES-256-GCM encrypted refresh token (optional) |
| `tokenRefreshFailed` | bool | Set true when auto-refresh fails |

---

## 4. Settings Object (S)

Stored in `users/{uid}/meta/settings` and local storage. Key fields:

```javascript
S = {
  accounts: [{ id, name, color, currency, size }],
  brokerAccountMap: {
    'zerodha': edgebookAccountId,
    'ctrader_5032134': edgebookAccountId,
    'ctrader_5043464': edgebookAccountId,
  },
  prefs: {
    tradeGrouping: 'fifo' | 'combined',
    // ...
  },
  formFields: { ... },
  widgets: { ... },
  sidebarSections: { ... },
  customFields: [...],
}
```

---

## 5. Cloud Functions Status

| Function | Type | Purpose | Status |
|---|---|---|---|
| `zerodhaLogin` | HTTP | Returns Kite OAuth login URL | ✅ Working |
| `zerodhaCallback` | HTTP | Exchanges request_token → access_token, stores in Firestore | ✅ Working |
| `syncZerodhaTrades` | HTTP | Manual sync of today's Zerodha trades | ✅ Working |
| `syncZerodhaHistory` | HTTP | Import historical trades via Kite tradebook | ✅ Working |
| `restoreWronglyDeletedZerodha` | HTTP | One-time repair for phantom deletes | ✅ Working |
| `zerodhaPostback` | HTTP | Webhook from Zerodha on order updates | ✅ Working |
| `marketHoursTradeSync` | Scheduled (*/5 Mon–Fri, IST gate) | Intraday Zerodha sync | ✅ Working |
| `scheduledTradeSync` | Scheduled (18:00 IST daily) | EOD Zerodha sync | ✅ Working |
| `ctraderConnect` | HTTP | Validate token + store broker doc | ✅ Working |
| `ctraderAddAccount` | HTTP | Add new cTrader account by accountId | ✅ Working |
| `ctraderSymbolInfo` | HTTP | Debug endpoint — raw symbol details | ✅ Working |
| `syncCtraderTrades` | HTTP | Manual sync for a specific cTrader broker doc | ✅ Working |
| `ctraderScheduledSync` | Scheduled (*/5 UTC) | Scheduled sync for all ctrader_* docs | ✅ Working |
| `backfillCtraderTimes` | HTTP | One-time IST timestamp backfill | ✅ Working |
| `forceReimportCtrader` | HTTP | Full re-sync (no delete) for a specific broker doc | ✅ Working |
| `syncCtraderHistory` | HTTP | Full historical import for a specific broker doc | ✅ Working |
| `aiCoachingReport` | HTTP | AI coaching analysis | ❌ Not built |

---

## 6. cTrader Integration Details

### Token format (CRITICAL)
- The bearer token is the **full base64 MCP config blob** copied from cTrader Settings → Advanced → Remote MCP
- Store it **raw** in `token` field (or encrypted in `accessToken` field via `ctraderConnect`/`ctraderAddAccount`)
- **Never decode it before storage** — the entire blob is the bearer token
- Pass directly to `Authorization: Bearer <blob>` header

### `readBrokerToken(brokerData)`
```javascript
function readBrokerToken(brokerData) {
  const raw = brokerData.token || null;
  if (raw && typeof raw === 'string') {
    // Detect AES-GCM encrypted format (hex:hex:hex) vs raw JWT/blob
    if (/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(raw)) {
      try { return decrypt(raw); } catch { /* fall through */ }
    }
    return raw;  // raw token blob
  }
  if (brokerData.accessToken) return decrypt(brokerData.accessToken);
  return null;
}
```

### Multi-account sync flow
1. `ctraderScheduledSync` queries `collectionGroup("brokers").where("connected","==",true)`
2. Filters to `doc.id === "ctrader" || doc.id.startsWith("ctrader_")`
3. For each doc: calls `syncCtraderForUser(uid, { brokerDocId: doc.id })`
4. `syncCtraderForUser` fetches ALL deals (no accountId filter in request)
5. Filters deals client-side: `deal[accountField] === brokerData.accountId`
6. Writes trades with docId prefix `ctrader_{accountId}_{positionId}`

### Account ID on deals
The cTrader API returns all deals for the token — the `accountId` request param is ignored.
Client-side filter checks candidate fields: `accountId`, `tradingAccountId`, `accountLogin`, `login`, `account`.

---

## 7. Zerodha Integration Details

### Fill pairing (pairFillsIntoTrades)
Dual FIFO queue — correctly handles option selling (SELL=open, BUY=close):

| Fill arrives | Queue check | Action |
|---|---|---|
| BUY | sellQueue non-empty | Closes Short: pnl = (shortEntry.price − price) × qty |
| BUY | sellQueue empty | Push to buyQueue (opens Long) |
| SELL | buyQueue non-empty | Closes Long: pnl = (price − longEntry.price) × qty |
| SELL | buyQueue empty + existingOpenLongs | Closes multi-day Long |
| SELL | Both empty | Push to sellQueue (opens Short) |

### Lot sizes
`getZerodhaLotSize(tradingsymbol)` returns the divisor for converting raw qty → lots.
NIFTY = 65, BANKNIFTY = 30, FINNIFTY = 65, etc. Options symbols start with the index name.

---

## 8. Frontend Architecture

- Single SPA in `app.html` (~8000 lines)
- Section markers: search `§` to find boundaries
- Sections marked `DO NOT EDIT` must not be touched
- Global state: `S` (settings), `trades[]`, `moods[]`, `CH` (chart handles)
- `DataStore` object handles Firestore sync
- `SettingsManager` object handles settings persistence

### Settings panels
| Panel ID | Nav item | Notes |
|---|---|---|
| `sp-display` | Display | Default active on open |
| `sp-accounts` | Accounts | |
| `sp-data` | Import / Export | **Contains broker connections** |
| `sp-danger` | Danger zone | |

### Broker card rendering
`loadCtraderConnections()` → `renderCtraderCards()` → `renderCtraderAccountCard()`.
Called on: boot (1.2s timeout), `buildSettingsUI()`, `showSPanel('data')`, after connect/disconnect/sync.
Shows **all** `ctrader*` docs (connected and disconnected).

---

## 9. Known Architectural Issues

1. **File size**: `app.html` (~8000 lines) and `functions/index.js` (~4100 lines) are too large for safe AI editing. Regression rate is meaningfully higher than with modular files.
2. **No smoke tests**: No automated verification of Cloud Function responses.
3. **Node.js 20 deprecated**: Deadline Oct 30, 2026 to upgrade to Node.js 22.
4. **Planned refactor** (next weekend): Split `functions/index.js` into modules per broker.

---

## 10. Lessons Learned

| Issue | What went wrong | Correct approach |
|---|---|---|
| FIFO pairing for short options | BUY=open assumption broke SELL-first option trades | Dual queue: detect opening side from first fill chronologically |
| Timestamp extraction | `String(ts).slice(11,16)` fails on ISO strings with T separator | Use `extractDateStr()` helper that handles all formats |
| cTrader symbol map | Hardcoded field names broke when API response shape changed | Always log first raw object; use `?? fallback` for every field |
| Multi-account cTrader | Single broker doc only queried one accountId | Per-account docs `ctrader_{accountId}`; client-side deal filtering |
| Firebase "No changes detected" | Scheduled function ran stale code after targeted deploy | Always deploy `--only functions` (full bundle), not per-function |
| Context doc drift | Claude built on outdated summary, missed token field name change | After every session, update verified schema section with exact field names actually written |
| cTrader token decoded before storage | Stored decoded inner token — 401 on every sync | Store full base64 MCP config blob raw in `token` field, never decode before storage |
| `connected:false` written on sync failure | Broker cards disappeared after any 401 error | Sync failures only update `lastSyncResult`, never write to `connected` field |
| Manual Firestore broker doc creation | Wrong token format, hours of debugging | Always use UI connection flow (`ctraderAddAccount`), never manually create broker docs |
| cTrader API token format | Full base64 MCP config blob is the bearer token | Pass raw to Authorization header — `readBrokerToken()` returns it as-is |

---

## 11. Deployment

```bash
# Full deploy
firebase deploy --only hosting,functions

# Functions only (code changes)
firebase deploy --only functions

# Hosting only (app.html changes)
firebase deploy --only hosting

# Logs
firebase functions:log --only <functionName> 2>&1 | tail -60
```

---

## 12. Environment Variables (functions/.env)

| Variable | Purpose |
|---|---|
| `ZERODHA_API_SECRET` | Kite Connect API secret |
| `ZERODHA_ENCRYPTION_KEY` | 64-char hex AES-256 key for token encryption |
| `CTRADER_CLIENT_ID` | cTrader Open API client ID (for token auto-refresh) |
| `CTRADER_CLIENT_SECRET` | cTrader Open API client secret (for token auto-refresh) |

---

## 13. CORS

All HTTP functions use `setCors(req, res)` which allows the `ALLOWED_ORIGINS` list.
Always call as first line; always handle `OPTIONS` preflight before any logic.

---

## 14. Trade Document Schema

```javascript
{
  // Broker-written fields (never overwrite user fields)
  id: string,               // doc ID (e.g. ctrader_5032134_3866300)
  source: 'ctrader' | 'zerodha' | 'csv' | 'manual',
  broker: 'ctrader' | 'zerodha',
  brokerTradeId: string,    // positionId (cTrader) or order_id (Zerodha)
  accountId: string,        // Edgebook internal account ID (from brokerAccountMap)
  symbol: string,
  direction: 'Long' | 'Short',
  asset: string,
  instrument: string | null,
  entry: number,
  exit: number | null,
  size: number,             // in lots (not raw units)
  pnl: number | null,
  isOpen: boolean,
  date: string,             // YYYY-MM-DD IST
  entryTime: string | null, // HH:MM IST
  exitTime: string | null,
  syncedAt: Timestamp,

  // User-written fields (NEVER overwritten by sync)
  strategy: string,
  emotion: string,
  notes: string,
  screenshots: string[],
  psychology: object,
  tags: string[],
  deleted: boolean,
  deletedAt: Timestamp | null,
}
```

---

## 15. Safety Rules

1. **Never delete trades from Firestore** — use `deleted: true` soft-delete only
2. **Never overwrite user fields** on sync — always `{ merge: true }` and preserve user-owned fields
3. **Never skip CORS headers** on any HTTP function
4. **Never edit sections marked DO NOT EDIT** in app.html
5. **Always deploy after changes** — don't leave code changes without deploying

---

## 16. Section Markers in app.html

Search `§` to jump to section boundaries:

| Section | What it contains |
|---|---|
| `§ SETTINGS MANAGER` | `SettingsManager` object — DO NOT EDIT |
| `§ DATA NORMALISATION` | `normaliseFsTrade` — DO NOT EDIT |
| `§ FIRESTORE SYNC` | `startTradesListener` — DO NOT EDIT |
| `§ P&L ENGINE` | `calculatePnL` |
| `§ TRADE FORM` | `openTradeModal`, `validateTrade`, `saveTrade` — DO NOT EDIT |
| `§ DELETE & ARCHIVE` | `deleteTrade` |
| `§ TRADE TABLE` | `refreshAll`, `renderTradeTable` |

---

## 17. cTrader Accounts

| Broker Doc ID | Account ID | Label | Status |
|---|---|---|---|
| `ctrader_5032134` | 5032134 | 100K 2 Step | ✅ Connected |
| `ctrader_5043464` | 5043464 | 25K 2 Step | 🔄 In progress |
| `ctrader` | (legacy) | — | May still exist; scheduled sync handles it |

**Important:** Each account needs its own bearer token blob from cTrader.
The 100K and 25K tokens are different — get each from the respective cTrader account session.

---

## 18. Features Roadmap

| Feature | Status | Notes |
|---|---|---|
| Zerodha sync (daily + intraday) | ✅ Done | marketHoursTradeSync + scheduledTradeSync |
| cTrader sync (multi-account) | 🔄 In progress | Token format issue being resolved |
| CSV import | ✅ Done | Zerodha, Groww, Angel One, Upstox |
| Trade journal / table | ✅ Done | |
| Analytics / equity curve | ✅ Done | |
| Mood tracking | ✅ Done | |
| Risk Manager | ❌ Pending | |
| AI Coaching Reports | ❌ Pending | |
| Monte Carlo simulation | ❌ Pending | |
| Node.js 20→22 upgrade | ❌ Pending | Deadline: Oct 30, 2026 |
| functions/index.js modular split | ❌ Pending | Scheduled for next weekend |

---

## 19. Session Updates — June 2, 2026

### Bugs Fixed

1. **FIFO fill pairing — dual queue fix.** SELL=open for option selling (Short PE/CE).
   All three Zerodha sync call sites updated (`syncZerodhaTrades`, `syncZerodhaHistory`,
   `marketHoursTradeSync`). Future trades pair correctly.

2. **cTrader 25K account (5043464) sync** — was invisible because:
   - Token was account-scoped (different base64 blob per account — same login, different token)
   - `get_deals` `accountId` param ignored by API — filter client-side instead
   - `syncCtraderTrades` HTTP handler was ignoring `brokerDocId` from request body (always defaulted to `'ctrader'`)
   - `connected:false` written on failure caused cards to disappear from UI
   - Full base64 MCP config blob is the correct bearer token format

3. **Broker cards disappearing after 401** — `loadCtraderConnections` now shows ALL
   `ctrader*` docs regardless of `connected` field. Individual card render errors no longer
   blank the entire container (try/catch per card).

4. **`readBrokerToken()`** — detects AES-GCM encrypted blobs (`hex:hex:hex`) vs raw
   bearer token blobs, handles both. Raw token field passed straight through without
   decoding.

5. **`forceReimportCtrader` HTTP handler** was also ignoring `brokerDocId` — fixed
   alongside `syncCtraderTrades`.

### Architecture Decisions

- **cTrader token**: store full base64 MCP config blob in `token` field (raw, unencrypted)
  when creating broker docs manually. `ctraderAddAccount` and `ctraderConnect` store
  encrypted in `accessToken`. `readBrokerToken()` handles both formats.
- **Per-account broker docs**: `ctrader_5032134` (100K), `ctrader_5043464` (25K).
  Each needs its own token from the corresponding cTrader account session.
- **Client-side account filtering**: `get_deals` fetches all deals for the token, then
  filter by `deal[accountField] === brokerData.accountId` after unwrapping.
- **`connected` field**: only `ctraderConnect` writes it. Sync failures write only to
  `lastSyncResult`. Cards always show regardless of `connected` state.

### Still Broken / Needs Verification

- Zerodha entry timestamps missing on June 1 trades — fix was deployed, needs
  verification on next live trade
- Lot size showing 65 instead of 1 for NIFTY options — fix deployed, needs
  next live trade to verify

### Pending (Next Session)

1. Verify timestamp fix and lot size fix on next Zerodha trade
2. Confirm 25K cTrader trades visible after using correct per-account token
3. Restructure `functions/index.js` into modules (schedule for weekend)
4. AI Coaching Reports
5. Risk Manager
6. Node.js 20→22 upgrade (Oct 30, 2026 deadline)
