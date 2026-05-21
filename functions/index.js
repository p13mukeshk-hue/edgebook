"use strict";

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { KiteConnect } = require("kiteconnect");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// ─── Constants ───────────────────────────────────────────────────────────────

const KITE_API_KEY = "ee7h02pr0g6bmxjj";

const ALLOWED_ORIGINS = [
  "https://www.edgebook.trade",
  "https://edgebook.trade",
  "https://edgebook-2dce2.web.app",
  "https://edgebook-2dce2.firebaseapp.com",
  "http://localhost:5000",
  "http://localhost:3000",
];

// ─── CORS — manual header injection (most reliable in Firebase Functions) ────
//
// Call setCors(req, res) as the first line of every HTTP function,
// then immediately handle OPTIONS preflights and return.

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Credentials", "true");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age", "3600");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getApiSecret() {
  const secret = process.env.ZERODHA_API_SECRET;
  if (!secret) throw new Error("ZERODHA_API_SECRET env var is not set — add it to functions/.env");
  return secret;
}

/**
 * cTrader Open API app credentials — required for token refresh.
 * Returns null (does NOT throw) if unset, so callers can degrade gracefully
 * and log a clear message rather than crashing unrelated syncs.
 */
function getCtraderClientId() {
  return process.env.CTRADER_CLIENT_ID || null;
}
function getCtraderClientSecret() {
  return process.env.CTRADER_CLIENT_SECRET || null;
}

function getEncryptionKey() {
  const keyHex = process.env.ZERODHA_ENCRYPTION_KEY;
  if (!keyHex) throw new Error("ZERODHA_ENCRYPTION_KEY env var is not set — add it to functions/.env");
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("ZERODHA_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  return key;
}

/** AES-256-GCM encrypt. Returns "iv:authTag:ciphertext" (all hex). */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(16);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(":");
}

/** AES-256-GCM decrypt. Accepts "iv:authTag:ciphertext" format. */
function decrypt(encoded) {
  const [ivHex, authTagHex, cipherHex] = encoded.split(":");
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/** Verify Firebase ID token from Authorization: Bearer <token> header. */
async function verifyAuth(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    const err = new Error("Missing or malformed Authorization header");
    err.status = 401;
    throw err;
  }
  try {
    return await admin.auth().verifyIdToken(authHeader.slice(7));
  } catch {
    const err = new Error("Invalid or expired ID token");
    err.status = 401;
    throw err;
  }
}

/** Get a KiteConnect instance loaded with the user's decrypted access token. */
async function getKiteForUser(uid) {
  const snap = await db.collection("users").doc(uid).collection("brokers").doc("zerodha").get();
  if (!snap.exists || !snap.data().connected) {
    const err = new Error("Zerodha is not connected for this account");
    err.status = 403;
    throw err;
  }
  const kite = new KiteConnect({ api_key: KITE_API_KEY });
  kite.setAccessToken(decrypt(snap.data().accessToken));
  return kite;
}

/**
 * Zerodha tokens expire at midnight IST every day. Detect the error codes Kite
 * returns for an invalid/expired token and mark the broker as disconnected so
 * the frontend can prompt the user to re-authenticate.
 */
function isTokenExpiredError(err) {
  const msg = (err.message || "").toLowerCase();
  const type = (err.error_type || err.errorType || "").toLowerCase();
  return (
    type === "tokenexception" ||
    msg.includes("token") && (msg.includes("invalid") || msg.includes("expired")) ||
    msg.includes("access token") ||
    err.status === 403
  );
}

async function markZerodhaDisconnected(uid, reason) {
  await db.collection("users").doc(uid).collection("brokers").doc("zerodha")
    .update({ connected: false, disconnectedAt: admin.firestore.FieldValue.serverTimestamp(), disconnectReason: reason });
}

// ─── Deduplication helpers ────────────────────────────────────────────────────

/** Extract YYYY-MM-DD from any timestamp format the brokers may send. */
function extractDateStr(val) {
  if (!val) return null;
  if (typeof val === "string")           return val.slice(0, 10);
  if (val && typeof val.toDate === "function") return val.toDate().toISOString().slice(0, 10);
  if (val instanceof Date)               return val.toISOString().slice(0, 10);
  if (typeof val === "number")           return new Date(val).toISOString().slice(0, 10);
  return null;
}

/**
 * Snapshot all existing trade docs into two fast-lookup structures:
 *   byDocId  — Set of doc IDs          (condition-1 check: same broker ID)
 *   byKey    — Map of "SYMBOL|DATE" → [{docId, entry}]  (conditions 2 & 3)
 */
async function buildExistingTradeIndex(tradesRef) {
  const snap = await tradesRef.get();
  const byDocId = new Set();
  const byKey   = new Map();

  for (const docSnap of snap.docs) {
    byDocId.add(docSnap.id);
    const d = docSnap.data();
    const sym   = (d.symbol || d.tradingsymbol || "").toUpperCase().trim();
    const date  = d.date || extractDateStr(
      d.fill_timestamp || d.order_timestamp || d.exchange_timestamp || d.openTimestamp
    );
    const entry = typeof d.entry === "number"         ? d.entry
                : typeof d.average_price === "number" ? d.average_price
                : null;

    if (sym && date && entry !== null) {
      const key = `${sym}|${date}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ docId: docSnap.id, entry });
    }
  }
  return { byDocId, byKey };
}

/**
 * Classify one incoming trade against the index:
 *   "skip"  — condition 1: same broker doc ID already in Firestore  → silent skip
 *   "flag"  — condition 2/3: same symbol + date, entry within 0.5%  → pendingDuplicates
 *   "save"  — no match → safe to write
 */
function checkTradeDedup(index, docId, symbol, date, entry) {
  if (index.byDocId.has(docId)) return { action: "skip" };
  if (!symbol || !date || !entry) return { action: "save" };

  const key        = `${symbol.toUpperCase()}|${date}`;
  const candidates = index.byKey.get(key) || [];

  for (const c of candidates) {
    if (!c.entry || c.entry <= 0) continue;
    const pctDiff = Math.abs(c.entry - entry) / c.entry;
    if (pctDiff <= 0.005) return { action: "flag", existingTradeId: c.docId };
  }
  return { action: "save" };
}


/**
 * Fetch today's trades + orders from Kite and upsert into Firestore.
 *
 * IMPORTANT — Kite Connect API limitation:
 *   getTrades() / getOrders() only return data for the CURRENT trading day.
 *   There is no Kite API for bulk multi-day trade history. 30-day history is
 *   built up by running this sync daily (via scheduledTradeSync) so each day's
 *   trades accumulate in Firestore over time.
 *
 *   On weekends / market holidays the exchange is closed, so both endpoints
 *   legitimately return [] — this is not a bug.
 */
/**
 * Map a Kite fill's instrument_type to Edgebook asset + instrument fields.
 * Kite instrument_type values: EQ, FUT, CE, PE (options).
 */
function mapZerodhaInstrument(fill) {
  const itype = (fill.instrument_type || "EQ").toUpperCase();
  switch (itype) {
    case "FUT":
      return { asset: "eq", instrument: "Futures",  optionType: null };
    case "CE":
      return { asset: "eq", instrument: "Options",  optionType: "CE" };
    case "PE":
      return { asset: "eq", instrument: "Options",  optionType: "PE" };
    default:
      return { asset: "eq", instrument: null,        optionType: null };
  }
}

/**
 * Build a stable Edgebook doc ID for a matched Zerodha round-trip.
 * Uses symbol + date + entry so it survives re-syncs that produce the same trade.
 */
function zerodhaTradeDocId(symbol, date, entryPrice) {
  return `zerodha_${symbol}_${date}_${entryPrice}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
 * FIFO-pair an array of Kite fills into Edgebook trade documents.
 *
 * Shared by syncTradesForUser (daily) and syncZerodhaHistory (historical).
 *
 * @param {Array}  fills       Raw fill objects from kite.getTrades() / getTradebook()
 * @param {Set}    openSymbols Symbol names that still have an open net position
 *                             (pass new Set() for history imports where position data
 *                              is unavailable — unmatched BUYs will be skipped)
 * @param {string} uid         UID used only for log labels
 * @param {string} label       Log prefix (e.g. "syncZerodhaTrades")
 * @returns {Array} pairedTrades — Edgebook trade objects ready to batch-write
 */
function pairFillsIntoTrades(fills, openSymbols, uid, label = "zerodha") {
  // Group fills by tradingsymbol, sort by fill time ascending
  const bySymbol = {};
  for (const fill of fills) {
    const sym = (fill.tradingsymbol || "").toUpperCase();
    if (!sym) { console.warn(`${label} [${uid}]: fill missing tradingsymbol — skipping`); continue; }
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push(fill);
  }
  for (const sym of Object.keys(bySymbol)) {
    bySymbol[sym].sort((a, b) => {
      const ta = new Date(a.fill_timestamp || a.order_timestamp || 0).getTime();
      const tb = new Date(b.fill_timestamp || b.order_timestamp || 0).getTime();
      return ta - tb;
    });
  }

  const pairedTrades = [];

  for (const [sym, symFills] of Object.entries(bySymbol)) {
    const buyQueue = [];  // unmatched BUY fills (FIFO)

    for (const fill of symFills) {
      const txType = (fill.transaction_type || "").toUpperCase();
      const qty    = Number(fill.quantity || fill.filled_quantity || 0);
      const price  = Number(fill.average_price || 0);
      const ts     = fill.fill_timestamp || fill.order_timestamp || fill.exchange_timestamp;
      const date   = extractDateStr(ts);
      const time   = ts ? String(ts).slice(11, 16) : null;

      if (txType === "BUY") {
        buyQueue.push({ fill, qty, price, date, time });
        continue;
      }

      if (txType === "SELL") {
        const buyEntry = buyQueue.shift();
        const { asset, instrument, optionType } = mapZerodhaInstrument(fill);
        const matchQty = buyEntry ? Math.min(buyEntry.qty, qty) : qty;

        if (buyEntry) {
          // Matched Long round-trip
          const entry = buyEntry.price;
          const exit  = price;
          const pnl   = parseFloat(((exit - entry) * matchQty).toFixed(2));
          pairedTrades.push({
            id:            zerodhaTradeDocId(sym, buyEntry.date, entry),
            brokerTradeId: fill.order_id || fill.trade_id,
            source:        "zerodha",
            broker:        "zerodha",
            symbol:        sym,
            asset,
            instrument:    instrument ?? null,
            optionType:    optionType ?? null,
            strike:        fill.strike    ? Number(fill.strike)    : null,
            expiry:        fill.expiry    || null,
            exchange:      fill.exchange  || null,
            product:       fill.product   || null,
            direction:     "Long",
            entry,
            exit,
            size:          matchQty,
            pnl,
            isOpen:        false,
            date:          buyEntry.date,
            entryTime:     buyEntry.time,
            exitTime:      time,
            syncedAt:      admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          // SELL with no preceding BUY — Short entry
          pairedTrades.push({
            id:            zerodhaTradeDocId(sym, date, price),
            brokerTradeId: fill.order_id || fill.trade_id,
            source:        "zerodha",
            broker:        "zerodha",
            symbol:        sym,
            asset,
            instrument:    instrument ?? null,
            optionType:    optionType ?? null,
            strike:        fill.strike  ? Number(fill.strike) : null,
            expiry:        fill.expiry  || null,
            exchange:      fill.exchange || null,
            product:       fill.product  || null,
            direction:     "Short",
            entry:         price,
            exit:          null,
            size:          qty,
            pnl:           null,
            isOpen:        true,
            date,
            entryTime:     time,
            exitTime:      null,
            syncedAt:      admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        continue;
      }

      console.warn(`${label} [${uid}]: unknown transaction_type "${txType}" for ${sym} — skipping fill`);
    }

    // Remaining unmatched BUY fills → open Long positions (skip if not in openSymbols)
    for (const { fill, qty, price, date, time } of buyQueue) {
      if (!openSymbols.has(sym)) {
        console.log(`${label} [${uid}]: unmatched BUY ${sym} not in openSymbols — skipping`);
        continue;
      }
      const { asset, instrument, optionType } = mapZerodhaInstrument(fill);
      pairedTrades.push({
        id:            zerodhaTradeDocId(sym, date, price),
        brokerTradeId: fill.order_id || fill.trade_id,
        source:        "zerodha",
        broker:        "zerodha",
        symbol:        sym,
        asset,
        instrument:    instrument ?? null,
        optionType:    optionType ?? null,
        strike:        fill.strike  ? Number(fill.strike) : null,
        expiry:        fill.expiry  || null,
        exchange:      fill.exchange || null,
        product:       fill.product  || null,
        direction:     "Long",
        entry:         price,
        exit:          null,
        size:          qty,
        pnl:           null,
        isOpen:        true,
        date,
        entryTime:     time,
        exitTime:      null,
        syncedAt:      admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  return pairedTrades;
}

async function syncTradesForUser(uid) {
  const kite = await getKiteForUser(uid);

  // ── 1. Token validation ──────────────────────────────────────────────────────
  try {
    const profile = await kite.getProfile();
    console.log(
      `syncZerodhaTrades [${uid}]: token valid, Kite user=${profile.user_id} (${profile.user_name})`
    );
  } catch (tokenErr) {
    console.error(
      `syncZerodhaTrades [${uid}]: token validation failed —`,
      tokenErr.message, "| error_type:", tokenErr.error_type
    );
    if (isTokenExpiredError(tokenErr)) {
      await markZerodhaDisconnected(uid, "access_token_expired");
      const err = new Error("Zerodha access token has expired. Please reconnect via Settings → Brokers.");
      err.status = 401; err.code = "TOKEN_EXPIRED";
      throw err;
    }
    throw tokenErr;
  }

  // ── 2. Fetch fills, positions, orders ────────────────────────────────────────
  let fills = [], positionsData = null, orders = [];
  try {
    [fills, positionsData, orders] = await Promise.all([
      kite.getTrades(),
      kite.getPositions().catch((e) => {
        console.warn(`syncZerodhaTrades [${uid}]: getPositions failed (${e.message}) — assuming all fills are closed`);
        return null;
      }),
      kite.getOrders(),
    ]);
  } catch (apiErr) {
    console.error(
      `syncZerodhaTrades [${uid}]: Kite API error —`, apiErr.message,
      "| error_type:", apiErr.error_type
    );
    if (isTokenExpiredError(apiErr)) {
      await markZerodhaDisconnected(uid, "access_token_expired");
      const err = new Error("Zerodha access token has expired. Please reconnect via Settings → Brokers.");
      err.status = 401; err.code = "TOKEN_EXPIRED";
      throw err;
    }
    throw apiErr;
  }

  // Build a set of symbols that still have open net positions
  const openSymbols = new Set(
    ((positionsData && positionsData.net) || [])
      .filter((p) => p.quantity !== 0)
      .map((p) => (p.tradingsymbol || "").toUpperCase())
  );

  const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(
    `syncZerodhaTrades [${uid}]: date(IST)=${today} ` +
    `fills=${fills.length} orders=${orders.length} openSymbols=${openSymbols.size}`
  );
  if (fills.length > 0) {
    console.log(`syncZerodhaTrades [${uid}]: sample fill —`, JSON.stringify(fills[0]));
  }

  const tradesRef = db.collection("users").doc(uid).collection("trades");
  const ordersRef = db.collection("users").doc(uid).collection("orders");

  // ── 3. Resolve prop accountId from user settings ──────────────────────────────
  const accountId = await resolvePropAccountId(uid);

  // ── 4. FIFO pair BUY + SELL fills per symbol → round-trip trades ─────────────
  const pairedTrades = pairFillsIntoTrades(fills, openSymbols, uid, "syncZerodhaTrades");

  // Create open Long trades from positions that have no fills today
  // (e.g. position opened on a previous day, still running)
  if (positionsData && positionsData.net) {
    for (const pos of positionsData.net) {
      if (pos.quantity === 0) continue;
      const sym = (pos.tradingsymbol || "").toUpperCase();
      const alreadyBuilt = pairedTrades.some((t) => t.symbol === sym && t.isOpen);
      if (alreadyBuilt) continue;

      const entry = Number(pos.average_price || 0);
      const date  = new Date().toISOString().slice(0, 10);  // today — best we can do
      const { asset, instrument, optionType } = mapZerodhaInstrument(pos);
      pairedTrades.push({
        id:            zerodhaTradeDocId(sym, date, entry),
        brokerTradeId: pos.product || sym,
        source:        "zerodha",
        broker:        "zerodha",
        symbol:        sym,
        asset,
        instrument:    instrument ?? null,
        optionType:    optionType ?? null,
        strike:        pos.strike  ? Number(pos.strike) : null,
        expiry:        pos.expiry  || null,
        exchange:      pos.exchange || null,
        product:       pos.product  || null,
        direction:     pos.quantity > 0 ? "Long" : "Short",
        entry,
        exit:          null,
        size:          Math.abs(pos.quantity),
        pnl:           null,
        isOpen:        true,
        date,
        entryTime:     null,
        exitTime:      null,
        syncedAt:      admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  if (accountId) {
    for (const t of pairedTrades) t.accountId = accountId;
  }

  console.log(
    `syncZerodhaTrades [${uid}]: fills=${fills.length} → ` +
    `${pairedTrades.length} paired trade(s) ` +
    `(${pairedTrades.filter((t) => !t.isOpen).length} closed, ` +
    `${pairedTrades.filter((t) => t.isOpen).length} open)`
  );

  // ── 6. Load existing Zerodha trade docs (id + isOpen) for dedup/update ────────
  const existingSnap = await tradesRef
    .where("broker", "==", "zerodha")
    .select("id", "isOpen")
    .get();
  const existingByDocId = new Map();
  for (const doc of existingSnap.docs) {
    existingByDocId.set(doc.id, { ref: doc.ref, isOpen: doc.data().isOpen });
  }

  // ── 7. Batch write — new trades full-set, open→closed transitions update-only ─
  const BATCH_SIZE    = 400;
  let   written       = 0;
  let   updatedCount  = 0;
  const toWriteNew    = [];
  const toWriteUpdate = [];

  for (const trade of pairedTrades) {
    const docRef   = tradesRef.doc(trade.id);
    const existing = existingByDocId.get(trade.id);

    if (existing) {
      if (!trade.isOpen && existing.isOpen !== false) {
        // Trade just closed — update only closing fields, preserve user-owned fields
        toWriteUpdate.push({ ref: existing.ref, fields: {
          exit:     trade.exit,
          pnl:      trade.pnl,
          exitTime: trade.exitTime,
          isOpen:   false,
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
        }});
      } else {
        console.log(`syncZerodhaTrades [${uid}]: ${trade.id} already up-to-date — no change`);
      }
    } else {
      toWriteNew.push({ ref: docRef, trade });
    }
  }

  for (let i = 0; i < toWriteNew.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const { ref, trade } of toWriteNew.slice(i, i + BATCH_SIZE)) {
      batch.set(ref, trade, { merge: true });
    }
    await batch.commit();
    written += toWriteNew.slice(i, i + BATCH_SIZE).length;
  }

  for (let i = 0; i < toWriteUpdate.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const { ref, fields } of toWriteUpdate.slice(i, i + BATCH_SIZE)) {
      batch.set(ref, fields, { merge: true });
    }
    await batch.commit();
    updatedCount += toWriteUpdate.slice(i, i + BATCH_SIZE).length;
  }

  // ── 8. Persist orders (unchanged) ────────────────────────────────────────────
  if (orders.length > 0) {
    for (let i = 0; i < orders.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const order of orders.slice(i, i + BATCH_SIZE)) {
        batch.set(
          ordersRef.doc(String(order.order_id)),
          { ...order, broker: "zerodha", syncedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
      }
      await batch.commit();
    }
  }

  console.log(
    `syncZerodhaTrades [${uid}]: new=${written} updated(closed)=${updatedCount} orders=${orders.length}`
  );

  await db.collection("users").doc(uid).collection("brokers").doc("zerodha")
    .update({ lastSync: admin.firestore.FieldValue.serverTimestamp() });

  const dayOfWeek = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long" });
  const isWeekend = ["Saturday", "Sunday"].includes(dayOfWeek);
  const noTradesReason = isWeekend
    ? `No trades today (${dayOfWeek} — market closed)`
    : "No trades executed today";

  return {
    trades:  written + updatedCount,
    orders:  orders.length,
    note:    fills.length === 0
      ? `${noTradesReason}. Kite Connect only provides same-day data; 30-day history accumulates via the daily scheduled sync.`
      : null,
  };
}

// ─── 1. zerodhaLogin ─────────────────────────────────────────────────────────
//
// GET /zerodhaLogin  (Authorization: Bearer <Firebase ID token>)
// Returns { loginUrl } — the frontend redirects the user there to begin Kite OAuth.
// After auth Zerodha redirects to https://edgebook.trade/zerodha-callback?request_token=…
// That page must call /zerodhaCallback (POST) with the token + user's ID token.

exports.zerodhaLogin = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    await verifyAuth(req);
    const kite = new KiteConnect({ api_key: KITE_API_KEY });
    return res.status(200).json({ loginUrl: kite.getLoginURL() });
  } catch (err) {
    console.error("zerodhaLogin:", err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── 2. zerodhaCallback ───────────────────────────────────────────────────────
//
// POST /zerodhaCallback  (Authorization: Bearer <Firebase ID token>)
// Body: { request_token: "…" }
// Exchanges request_token → access_token, stores encrypted in Firestore.

exports.zerodhaCallback = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { uid } = await verifyAuth(req);
    const { request_token: requestToken } = req.body;
    if (!requestToken || typeof requestToken !== "string") {
      return res.status(400).json({ error: "request_token is required" });
    }

    const kite = new KiteConnect({ api_key: KITE_API_KEY });
    const session = await kite.generateSession(requestToken, getApiSecret());
    const { access_token, user_id, user_name, email, user_type, broker, exchanges, products, order_types } = session;

    await db.collection("users").doc(uid).collection("brokers").doc("zerodha").set(
      {
        connected: true,
        userId: user_id,
        userName: user_name,
        email: email || null,
        userType: user_type || null,
        broker: broker || "ZERODHA",
        exchanges: exchanges || [],
        products: products || [],
        orderTypes: order_types || [],
        accessToken: encrypt(access_token),
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSync: null,
      },
      { merge: true }
    );

    // Immediate background sync — don't await so the HTTP response isn't delayed
    syncTradesForUser(uid).catch((err) =>
      console.error(`Background sync after connect failed for ${uid}:`, err.message)
    );

    res.json({ success: true, userId: user_id, userName: user_name, message: "Zerodha connected" });
  } catch (err) {
    console.error("zerodhaCallback:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── 3. syncZerodhaTrades ─────────────────────────────────────────────────────
//
// POST /syncZerodhaTrades  (Authorization: Bearer <Firebase ID token>)
// Syncs today's trades + orders into users/{uid}/trades and users/{uid}/orders.

exports.syncZerodhaTrades = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { uid } = await verifyAuth(req);
    const result = await syncTradesForUser(uid);
    res.json({
      success: true,
      synced: { trades: result.trades, orders: result.orders },
      message: `Synced ${result.trades} trade(s) and ${result.orders} order(s)`,
      ...(result.note && { note: result.note }),
    });
  } catch (err) {
    console.error("syncZerodhaTrades:", err.message);
    res.status(err.status || 500).json({
      error: err.message,
      ...(err.code && { code: err.code }),
    });
  }
});

// ─── 4. syncZerodhaHistory ────────────────────────────────────────────────────
//
// POST /syncZerodhaHistory  (Authorization: Bearer <Firebase ID token>)
// Body (optional): { force: true }
//
// Attempts to import historical Zerodha trades:
//   1. Tries kite.getTradebook() — available on some Kite plans / future API versions.
//   2. Falls back to kite.getOrders() filtered to status === "COMPLETE".
//
// NOTE: The standard Kite Connect API (free tier) only provides same-day fills
// via getTrades() / getOrders(). Neither endpoint accepts date-range parameters.
// If getTradebook() is unavailable, this function imports whatever the API returns.
// Pass force:true to overwrite trades that already exist in Firestore.

exports.syncZerodhaHistory = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { uid } = await verifyAuth(req);
    const kite = await getKiteForUser(uid);
    const force = req.body?.force === true;

    console.log(`syncZerodhaHistory [${uid}]: starting — force=${force}`);

    // ── 1. Fetch fills — try getTradebook() first, fall back to getOrders() ──────
    let fills = [];
    try {
      fills = await kite.getTradebook();
      console.log(`syncZerodhaHistory [${uid}]: getTradebook() returned ${fills.length} fill(s)`);
    } catch (tbErr) {
      console.warn(
        `syncZerodhaHistory [${uid}]: getTradebook() unavailable (${tbErr.message}) ` +
        `— falling back to getOrders()`
      );
      const orders = await kite.getOrders();
      // Normalise complete orders to look like fill objects
      fills = orders
        .filter((o) => (o.status || "").toUpperCase() === "COMPLETE")
        .map((o) => ({
          ...o,
          quantity:         o.filled_quantity ?? o.quantity,
          fill_timestamp:   o.exchange_update_timestamp || o.order_timestamp,
        }));
      console.log(`syncZerodhaHistory [${uid}]: ${fills.length} complete order(s) from fallback`);
    }

    if (fills.length === 0) {
      return res.status(200).json({
        saved: 0,
        skipped: 0,
        message:
          "No fills found. The standard Kite Connect API provides same-day data only; " +
          "historical trade data accumulates via the daily scheduled sync.",
      });
    }

    // ── 2. Pair fills into trades using shared FIFO helper ──────────────────────
    // Pass an empty openSymbols Set — for historical data we don't have live
    // position state, so unmatched BUYs are skipped (they will appear via daily sync).
    const pairedTrades = pairFillsIntoTrades(fills, new Set(), uid, "syncZerodhaHistory");
    console.log(
      `syncZerodhaHistory [${uid}]: ${fills.length} fill(s) → ` +
      `${pairedTrades.length} paired trade(s)`
    );

    // ── 3. Resolve prop account ID ───────────────────────────────────────────────
    const accountId = await resolvePropAccountId(uid);
    if (accountId) {
      for (const t of pairedTrades) t.accountId = accountId;
    }

    // ── 4. Load existing Zerodha trades for dedup ───────────────────────────────
    const tradesRef = db.collection("users").doc(uid).collection("trades");
    const existingSnap = await tradesRef
      .where("broker", "==", "zerodha")
      .select("id", "isOpen")
      .get();
    const existingIds = new Set(existingSnap.docs.map((d) => d.id));

    // ── 5. Batch write — skip existing unless force=true ────────────────────────
    const BATCH_SIZE = 400;
    let saved = 0, skipped = 0;
    const toWrite = [];

    for (const trade of pairedTrades) {
      if (existingIds.has(trade.id) && !force) {
        skipped++;
        continue;
      }
      toWrite.push({ ref: tradesRef.doc(trade.id), trade });
    }

    for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const { ref, trade } of toWrite.slice(i, i + BATCH_SIZE)) {
        batch.set(ref, trade, { merge: true });
      }
      await batch.commit();
      saved += toWrite.slice(i, i + BATCH_SIZE).length;
    }

    console.log(`syncZerodhaHistory [${uid}]: saved=${saved} skipped=${skipped}`);

    await db.collection("users").doc(uid).collection("brokers").doc("zerodha")
      .update({ lastSync: admin.firestore.FieldValue.serverTimestamp() });

    return res.status(200).json({
      saved,
      skipped,
      message: saved > 0
        ? `Imported ${saved} trade(s) from Zerodha (${skipped} already existed)`
        : "No new trades to import — all already in Firestore or no data available",
    });

  } catch (err) {
    console.error("syncZerodhaHistory error:", err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── 5. zerodhaPostback ───────────────────────────────────────────────────────
//
// POST /zerodhaPostback  (no auth — called by Zerodha's servers)
// Set this URL as the Postback URL in your Kite developer console.
// Always returns 200 immediately; Zerodha retries on anything else.

exports.zerodhaPostback = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }

  // Respond 200 immediately so Zerodha doesn't retry
  res.status(200).json({ received: true });

  try {
    if (req.method !== "POST") return;
    const payload = req.body;
    if (!payload?.user_id || !payload?.order_id) {
      console.warn("zerodhaPostback: invalid payload", payload);
      return;
    }

    console.log(`zerodhaPostback: order ${payload.order_id} user ${payload.user_id} status ${payload.status}`);

    const snapshot = await db
      .collectionGroup("brokers")
      .where("userId", "==", payload.user_id)
      .where("connected", "==", true)
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.warn(`zerodhaPostback: no user for Zerodha user_id ${payload.user_id}`);
      return;
    }

    const uid = snapshot.docs[0].ref.parent.parent.id;
    await db.collection("users").doc(uid).collection("orderUpdates").add({
      ...payload,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (payload.status === "COMPLETE") {
      await syncTradesForUser(uid).catch((err) =>
        console.error(`Post-postback sync failed for ${uid}:`, err.message)
      );
    }
  } catch (err) {
    console.error("zerodhaPostback processing error:", err.message);
  }
});

// ─── 5. scheduledTradeSync ───────────────────────────────────────────────────
//
// Runs every day at 6:00 PM IST — after NSE/BSE market close.
// Syncs trades for every user with a connected Zerodha account.

// ─── 5. marketHoursTradeSync ─────────────────────────────────────────────────
//
// Fires every 5 minutes, Mon–Fri (Cloud Scheduler minimum granularity = 1 min).
// The function itself checks whether the current IST time falls within market
// hours before touching the Kite API — invocations outside that window return
// immediately so they cost essentially nothing.
//
// Market window used: 9:10 AM–3:40 PM IST (±5 min buffer around 9:15–3:35).

/** Return current hours + minutes in IST as { h, m, totalMinutes, label }. */
function istNow() {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours();
  const m = ist.getMinutes();
  return { h, m, totalMinutes: h * 60 + m, label: `${h}:${String(m).padStart(2, "0")} IST` };
}

const MARKET_OPEN_MINS  = 9 * 60 + 10;  // 09:10 IST — 5-min buffer before open
const MARKET_CLOSE_MINS = 15 * 60 + 40; // 15:40 IST — 5-min buffer after close

exports.marketHoursTradeSync = functions.pubsub
  .schedule("*/5 * * * 1-5")   // every 5 min, Monday–Friday
  .timeZone("Asia/Kolkata")
  .onRun(async () => {
    const { totalMinutes, label } = istNow();

    if (totalMinutes < MARKET_OPEN_MINS || totalMinutes > MARKET_CLOSE_MINS) {
      console.log(`marketHoursTradeSync: ${label} — outside market hours, skipping`);
      return;
    }

    console.log(`marketHoursTradeSync: ${label} — within market hours, starting sync`);

    const snapshot = await db.collectionGroup("brokers").where("connected", "==", true).get();
    // Only sync Zerodha accounts here; cTrader has its own scheduler
    const zerodhaDocs = snapshot.docs.filter((doc) => doc.id === "zerodha");
    if (zerodhaDocs.length === 0) {
      console.log("marketHoursTradeSync: no connected Zerodha users");
      return;
    }

    const results = await Promise.allSettled(
      zerodhaDocs.map(async (doc) => {
        const uid = doc.ref.parent.parent.id;
        const result = await syncTradesForUser(uid);
        console.log(`marketHoursTradeSync: uid=${uid} trades=${result.trades} orders=${result.orders}`);
        return { uid, ...result };
      })
    );

    const ok   = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.filter((r) => r.status === "rejected").length;
    console.log(`marketHoursTradeSync: done — ${ok} ok, ${fail} failed`);
  });

// ─── 6. scheduledTradeSync (EOD) ─────────────────────────────────────────────
//
// End-of-day backup sync at 6:00 PM IST every day — captures any trades that
// the intraday scheduler may have missed (e.g. last few minutes before close,
// AMO orders) and runs on weekends/holidays too so token expiry is detected.

exports.scheduledTradeSync = functions.pubsub
  .schedule("0 18 * * *")
  .timeZone("Asia/Kolkata")
  .onRun(async () => {
    console.log("scheduledTradeSync (EOD): starting");

    const snapshot = await db.collectionGroup("brokers").where("connected", "==", true).get();
    // Only sync Zerodha accounts here; cTrader has its own scheduler
    const zerodhaDocs = snapshot.docs.filter((doc) => doc.id === "zerodha");
    const results = await Promise.allSettled(
      zerodhaDocs.map(async (doc) => {
        const uid = doc.ref.parent.parent.id;
        const result = await syncTradesForUser(uid);
        console.log(`scheduledTradeSync: uid=${uid} trades=${result.trades} orders=${result.orders}`);
        return { uid, ...result };
      })
    );

    const ok   = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.filter((r) => r.status === "rejected").length;
    console.log(`scheduledTradeSync (EOD): done — ${ok} ok, ${fail} failed`);
  });

// ═══════════════════════════════════════════════════════════════════════════════
// cTRADER INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════
//
// Strict no-assumptions policy:
//   • Every piece of data (symbol names, trading hours, pip sizes, lot sizes,
//     holidays, timezones) comes from the cTrader MCP API — nothing hardcoded.
//   • If a required field is missing from the API response, we log clearly and
//     skip — we never guess or default.
//   • We are dealing with real money.
//
// Symbol map structure stored in Firestore system/ctrader.symbolDetails:
//   { "<symbolId>": { id, name, enabled, symbolCategory, lotSize, pipSize,
//                     pipValue, scheduleTimeZone, tradingHours, holidays } }

const CTRADER_MCP_URL = "https://mcp.ctrader.com/trading/mcp";

// Symbol-map cache TTL — refresh if older than 6 hours
const SYMBOL_MAP_TTL_MS = 6 * 60 * 60 * 1000;

// ─── cTrader MCP protocol helpers ────────────────────────────────────────────

/**
 * Initialise an MCP session and return the session ID.
 * Protocol: POST initialize → read Mcp-Session-Id header → POST notifications/initialized.
 */
async function initCtraderSession(bearerToken) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": `Bearer ${bearerToken}`,
  };

  // Step 1: initialize
  const initRes = await fetch(CTRADER_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "edgebook-server", version: "1.0.0" },
      },
    }),
  });

  if (!initRes.ok) {
    throw new Error(`cTrader MCP initialize failed: HTTP ${initRes.status}`);
  }

  const sessionId = initRes.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("cTrader MCP did not return Mcp-Session-Id header");

  // Step 2: notifications/initialized (fire-and-forget; response is optional)
  await fetch(CTRADER_MCP_URL, {
    method: "POST",
    headers: { ...headers, "Mcp-Session-Id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch((e) => console.warn("notifications/initialized warning (non-fatal):", e.message));

  return sessionId;
}

/**
 * Call an MCP tool and return the parsed result object.
 * Handles both plain JSON and SSE (text/event-stream) response formats.
 */
async function callCtraderTool(bearerToken, sessionId, toolName, toolArgs = {}) {
  const res = await fetch(CTRADER_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": `Bearer ${bearerToken}`,
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: toolName, arguments: toolArgs },
    }),
  });

  if (!res.ok) {
    throw new Error(`cTrader MCP tools/call (${toolName}) failed: HTTP ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();

  let rpcResponse;
  if (contentType.includes("text/event-stream")) {
    // Parse SSE: find the last "data: {...}" line with a result or error
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);

    if (dataLines.length === 0) throw new Error(`cTrader MCP (${toolName}): empty SSE response`);

    // The last data line should be the JSON-RPC result
    const lastData = dataLines[dataLines.length - 1];
    try {
      rpcResponse = JSON.parse(lastData);
    } catch {
      throw new Error(`cTrader MCP (${toolName}): could not parse SSE data as JSON: ${lastData.slice(0, 200)}`);
    }
  } else {
    try {
      rpcResponse = JSON.parse(text);
    } catch {
      throw new Error(`cTrader MCP (${toolName}): could not parse response as JSON: ${text.slice(0, 200)}`);
    }
  }

  if (rpcResponse.error) {
    throw new Error(`cTrader MCP (${toolName}) RPC error ${rpcResponse.error.code}: ${rpcResponse.error.message}`);
  }

  // result.content is an array of { type: "text", text: "<json>" }
  const content = rpcResponse?.result?.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`cTrader MCP (${toolName}): unexpected result shape — ${JSON.stringify(rpcResponse).slice(0, 300)}`);
  }

  const textBlock = content.find((c) => c.type === "text");
  if (!textBlock) throw new Error(`cTrader MCP (${toolName}): no text block in result content`);

  try {
    return JSON.parse(textBlock.text);
  } catch {
    // Some tools return plain text (e.g. confirmations); return as-is
    return textBlock.text;
  }
}

/**
 * Fetch and cache full symbol details from get_symbols.
 *
 * Returns symbolDetails: { "<id>": { id, name, enabled, symbolCategory,
 *   lotSize, pipSize, pipValue, scheduleTimeZone, tradingHours, holidays, _raw } }
 *
 * Caching: stored in Firestore system/ctrader.symbolDetails + symbolMapUpdatedAt.
 * TTL = 6 hours. forceRefresh = true bypasses the cache.
 *
 * On first fetch the full raw symbol[0] is logged so we can see the exact field
 * names the API uses — this helps us adapt if the schema ever changes.
 */

// Fallback lot sizes when cTrader MCP get_symbols doesn't return contract sizing.
// Values are standard industry lots (units of base currency or contract units).
const LOT_SIZE_DEFAULTS = {
  // Normalised (no slashes/dots)
  EURUSD: 100000, GBPUSD: 100000, USDJPY: 100000, AUDUSD: 100000,
  USDCAD: 100000, USDCHF: 100000, NZDUSD: 100000, EURGBP: 100000,
  EURJPY: 100000, GBPJPY: 100000, EURCHF: 100000, EURAUD: 100000,
  GBPAUD: 100000, AUDCAD: 100000, CADJPY: 100000, CHFJPY: 100000,
  XAUUSD: 100,   XAGUSD: 5000,
  BTCUSD: 1,     ETHUSD: 1,     BTCUSDT: 1,   ETHUSDT: 1,
  US30: 1,       US500: 1,      SPX500: 1,    NAS100: 1,    UK100: 1,
  GER40: 1,      AUS200: 1,     JPN225: 1,
  XTIUSD: 1000,  XBRUSD: 1000,
  // Slash-separated aliases (cTrader API often sends these)
  'EUR/USD': 100000, 'GBP/USD': 100000, 'USD/JPY': 100000, 'AUD/USD': 100000,
  'USD/CAD': 100000, 'USD/CHF': 100000, 'NZD/USD': 100000,
  'EUR/GBP': 100000, 'EUR/JPY': 100000, 'GBP/JPY': 100000,
  'XAU/USD': 100,    'XAG/USD': 5000,
  'BTC/USD': 1,      'ETH/USD': 1,
  // Common display-name aliases
  GOLD: 100, SILVER: 5000, WTI: 1000, OIL: 1000, BRENT: 1000,
};

// Fallback pip sizes (smallest price increment that matters for P&L).
const PIP_SIZE_DEFAULTS = {
  EURUSD: 0.0001, GBPUSD: 0.0001, AUDUSD: 0.0001, NZDUSD: 0.0001,
  USDCAD: 0.0001, USDCHF: 0.0001, EURGBP: 0.0001, EURCHF: 0.0001,
  EURAUD: 0.0001, GBPAUD: 0.0001, AUDCAD: 0.0001,
  USDJPY: 0.01,   EURJPY: 0.01,   GBPJPY: 0.01,   CADJPY: 0.01,
  CHFJPY: 0.01,
  XAUUSD: 0.01,   XAGUSD: 0.001,
  BTCUSD: 1,      ETHUSD: 0.01,  BTCUSDT: 1,   ETHUSDT: 0.01,
  US30: 1,        NAS100: 1,     US500: 0.1,   UK100: 1,
  GER40: 1,       AUS200: 1,     JPN225: 1,
  XTIUSD: 0.01,   XBRUSD: 0.01,
};

async function getVerifiedSymbolMap(bearerToken, sessionId, { forceRefresh = false } = {}) {
  const cacheRef = db.collection("system").doc("ctrader");

  if (!forceRefresh) {
    const cacheSnap = await cacheRef.get();
    if (cacheSnap.exists) {
      const { symbolDetails, symbolMapUpdatedAt } = cacheSnap.data();
      const age = Date.now() - (symbolMapUpdatedAt?.toMillis?.() ?? 0);
      if (symbolDetails && Object.keys(symbolDetails).length > 0 && age < SYMBOL_MAP_TTL_MS) {
        console.log(
          `cTrader: using cached symbol details ` +
          `(${Object.keys(symbolDetails).length} symbols, age ${Math.round(age / 60000)}m)`
        );
        return symbolDetails;
      }
    }
  }

  console.log("cTrader: fetching fresh symbol details from get_symbols");
  const symbolsRaw = await callCtraderTool(bearerToken, sessionId, "get_symbols");

  // Log the exact top-level shape so we can see what the API returns
  console.log(
    "cTrader get_symbols: raw response type =", typeof symbolsRaw,
    "| isArray =", Array.isArray(symbolsRaw),
    "| keys =", (!Array.isArray(symbolsRaw) && symbolsRaw && typeof symbolsRaw === "object")
      ? Object.keys(symbolsRaw).join(", ")
      : "n/a",
    "| preview =", JSON.stringify(symbolsRaw).slice(0, 200)
  );

  // Unwrap either format:
  //   {"symbols": [...]}  →  use .symbols
  //   [...]               →  use as-is
  //   {"data": [...]}  /  {"result": [...]}  →  use first array-valued key
  let rawSymbols;
  if (Array.isArray(symbolsRaw)) {
    rawSymbols = symbolsRaw;
  } else if (symbolsRaw && typeof symbolsRaw === "object") {
    // Try common wrapper key names first
    if (Array.isArray(symbolsRaw.symbols))  rawSymbols = symbolsRaw.symbols;
    else if (Array.isArray(symbolsRaw.data))    rawSymbols = symbolsRaw.data;
    else if (Array.isArray(symbolsRaw.result))  rawSymbols = symbolsRaw.result;
    else if (Array.isArray(symbolsRaw.items))   rawSymbols = symbolsRaw.items;
    else {
      // Last resort: pick the first key whose value is an array
      const arrayKey = Object.keys(symbolsRaw).find((k) => Array.isArray(symbolsRaw[k]));
      if (arrayKey) {
        console.log(`cTrader get_symbols: unwrapping via key "${arrayKey}"`);
        rawSymbols = symbolsRaw[arrayKey];
      } else {
        throw new Error(
          `cTrader get_symbols: response is an object but contains no array value — ` +
          `keys: ${Object.keys(symbolsRaw).join(", ")} — full: ${JSON.stringify(symbolsRaw).slice(0, 300)}`
        );
      }
    }
  } else {
    throw new Error(
      `cTrader get_symbols: unexpected response type "${typeof symbolsRaw}" — ${JSON.stringify(symbolsRaw).slice(0, 300)}`
    );
  }

  if (rawSymbols.length === 0) {
    throw new Error("cTrader get_symbols: array is empty — cannot build symbol map");
  }

  // Log the first symbol's raw shape so we can see the exact field names
  console.log("cTrader get_symbols: first symbol raw shape →", JSON.stringify(rawSymbols[0]));

  const symbolDetails = {};
  let skippedCount = 0;

  for (const s of rawSymbols) {
    // Resolve id — try common field name variants
    const id = String(s.id ?? s.symbolId ?? s.symbol_id ?? "").trim();
    const name = String(s.name ?? s.symbolName ?? s.symbol_name ?? "").trim();

    if (!id || !name) {
      console.warn("cTrader get_symbols: skipping entry — missing id or name:", JSON.stringify(s));
      skippedCount++;
      continue;
    }

    // Extract every field the user requested.
    // For sizing fields: try API first, fall back to hardcoded industry defaults,
    // then a safe catch-all (1 lot / 0.0001 pip) so downstream math never gets NaN.
    const apiLotSize  = extractNumber(s, ["lotSize", "lot_size", "contractSize", "contract_size"]);
    const apiPipSize  = extractNumber(s, ["pipSize", "pip_size", "pipPosition", "point"]);
    const apiPipValue = extractNumber(s, ["pipValue", "pip_value", "pipValuePerLot"]);

    const normName = name.replace(/\//g, "").replace(/\./g, "").toUpperCase().trim();
    const defaultLotSize = LOT_SIZE_DEFAULTS[normName] ?? LOT_SIZE_DEFAULTS[name] ?? null;
    const defaultPipSize = PIP_SIZE_DEFAULTS[normName] ?? PIP_SIZE_DEFAULTS[name] ?? null;
    console.log(`[symbolMap] "${name}" norm="${normName}" apiLotSize=${apiLotSize} defaultLotSize=${defaultLotSize}`);

    const lotSize  = apiLotSize  ?? defaultLotSize  ?? 1;
    const pipSize  = apiPipSize  ?? defaultPipSize  ?? 0.0001;
    const pipValue = apiPipValue ?? null;

    const lotSizeSrc  = apiLotSize  != null ? "api" : (defaultLotSize  != null ? "fallback" : "default");
    const pipSizeSrc  = apiPipSize  != null ? "api" : (defaultPipSize  != null ? "fallback" : "default");

    const entry = {
      id,
      name,
      // Is this symbol currently tradeable?
      enabled: s.enabled ?? s.tradingEnabled ?? s.isEnabled ?? null,
      // Asset class — API may return symbolCategoryId (int) rather than a string;
      // keep whatever the API gives so ctraderCategoryToAsset() can map it.
      symbolCategory: s.symbolCategory ?? s.category ?? s.assetClass ?? s.type ?? s.symbolCategoryId ?? null,
      // Contract / volume sizing — API value preferred, then named fallback, then safe default
      lotSize,
      pipSize,
      pipValue,
      _lotSizeSrc: lotSizeSrc,
      _pipSizeSrc: pipSizeSrc,
      // Schedule data — from API only
      scheduleTimeZone: s.scheduleTimeZone ?? s.tradingScheduleTimeZone ?? s.timezone ?? null,
      tradingHours:     s.tradingHours ?? s.schedule ?? s.tradingSchedule ?? s.hours ?? null,
      holidays:         s.holidays ?? s.tradingHolidays ?? s.closedDates ?? null,
      _raw: s,  // keep original for debugging; prune once stable
    };

    symbolDetails[id] = entry;
  }

  if (Object.keys(symbolDetails).length === 0) {
    throw new Error("cTrader get_symbols: could not extract any symbol entries from API response");
  }

  if (skippedCount > 0) {
    console.warn(`cTrader get_symbols: skipped ${skippedCount} entries due to missing id/name`);
  }

  // Log spot-check for key symbols if present
  for (const checkName of ["XAUUSD", "BTCUSD", "BTCUSDT", "EURUSD"]) {
    const found = Object.values(symbolDetails).find((s) => s.name === checkName);
    if (found) {
      console.log(
        `cTrader symbol check — ${checkName}: id=${found.id} enabled=${found.enabled} ` +
        `category=${found.symbolCategory} ` +
        `lotSize=${found.lotSize} (${found._lotSizeSrc}) ` +
        `pipSize=${found.pipSize} (${found._pipSizeSrc}) ` +
        `pipValue=${found.pipValue} tz=${found.scheduleTimeZone}`
      );
    }
  }

  // Persist rich details to cache
  await cacheRef.set(
    {
      symbolDetails,
      // Keep legacy symbolMap for backward compat with ctraderConnect symbolCount
      symbolMap: Object.fromEntries(Object.entries(symbolDetails).map(([k, v]) => [k, v.name])),
      symbolMapUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  console.log(`cTrader: symbol details cached — ${Object.keys(symbolDetails).length} symbols`);

  return symbolDetails;
}

/**
 * Helper: extract a numeric field from an object, trying multiple key names.
 * Returns the first finite number found, or null if none.
 */
function extractNumber(obj, keys) {
  for (const key of keys) {
    const v = obj[key];
    if (v != null) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// ─── Trading-hours validation ─────────────────────────────────────────────────
//
// All logic is driven entirely by data from the API (tradingHours, holidays,
// scheduleTimeZone). We never hardcode session times for any instrument.
//
// tradingHours shape from cTrader can be one of:
//   A) Array of { dayOfWeek: "MONDAY"|"1"|1, open: "HH:MM", close: "HH:MM" }
//   B) Array of { from: { dayOfWeek, time }, to: { dayOfWeek, time } }  (interval style)
//   C) String "00:00-24:00" (simple, assume every day)
//   D) null / missing → cannot determine → returns { tradeable: null, reason }
//
// Returns { tradeable: true|false|null, reason: string }
//   true  → within hours
//   false → outside hours or holiday
//   null  → could not determine (API data missing or unparseable)

const DOW_NAMES = ["SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"];

function checkTradingHours(symbolInfo, nowMs) {
  const { name, scheduleTimeZone, tradingHours, holidays } = symbolInfo;

  // ── Step 1: resolve "now" in the symbol's declared timezone ─────────────────
  let tz = scheduleTimeZone;
  if (!tz) {
    return { tradeable: null, reason: `${name}: scheduleTimeZone not provided by API — cannot check hours` };
  }

  let localDate;
  try {
    // Use Intl to get the local date/time string in the symbol's timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(formatter.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
    localDate = {
      year:    parseInt(parts.year,   10),
      month:   parseInt(parts.month,  10), // 1-12
      day:     parseInt(parts.day,    10),
      hour:    parseInt(parts.hour,   10),
      minute:  parseInt(parts.minute, 10),
      // Day of week in local timezone (0=Sun…6=Sat)
      dow:     new Date(nowMs).toLocaleDateString("en-US", { timeZone: tz, weekday: "long" }).toUpperCase(),
    };
  } catch (e) {
    return { tradeable: null, reason: `${name}: invalid scheduleTimeZone "${tz}" — ${e.message}` };
  }

  const localMinutes = localDate.hour * 60 + localDate.minute;
  const localDateStr = `${localDate.year}-${String(localDate.month).padStart(2,"0")}-${String(localDate.day).padStart(2,"0")}`;

  // ── Step 2: check holidays ────────────────────────────────────────────────
  if (Array.isArray(holidays) && holidays.length > 0) {
    // Holidays may be Date strings like "2024-12-25" or objects { date: "2024-12-25" }
    const holidaySet = new Set(
      holidays.map((h) => (typeof h === "string" ? h.slice(0, 10) : (h?.date ?? h?.holiday ?? "").slice(0, 10)))
        .filter(Boolean)
    );
    if (holidaySet.has(localDateStr)) {
      return { tradeable: false, reason: `${name}: today (${localDateStr}) is a declared holiday` };
    }
  }

  // ── Step 3: check trading hours ───────────────────────────────────────────
  if (!tradingHours) {
    return { tradeable: null, reason: `${name}: tradingHours not provided by API — cannot check hours` };
  }

  // Format C: simple string like "00:00-24:00"
  if (typeof tradingHours === "string") {
    const m = tradingHours.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) {
      return { tradeable: null, reason: `${name}: tradingHours string "${tradingHours}" not parseable` };
    }
    const openMin  = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const closeMin = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
    const within   = localMinutes >= openMin && localMinutes < (closeMin === 1440 ? 1440 : closeMin);
    return {
      tradeable: within,
      reason: within
        ? `${name}: within hours ${tradingHours} (${tz})`
        : `${name}: outside hours ${tradingHours} (${tz}), local time ${localDate.hour}:${String(localDate.minute).padStart(2,"0")}`,
    };
  }

  if (!Array.isArray(tradingHours) || tradingHours.length === 0) {
    return { tradeable: null, reason: `${name}: tradingHours is not a usable array` };
  }

  // Normalise day-of-week to uppercase string
  function normaliseDow(v) {
    if (v == null) return null;
    if (typeof v === "string") {
      const up = v.toUpperCase().trim();
      if (DOW_NAMES.includes(up)) return up;
      // Try numeric string
      const n = parseInt(v, 10);
      if (!isNaN(n) && n >= 0 && n <= 6) return DOW_NAMES[n];
      if (!isNaN(n) && n >= 1 && n <= 7) return DOW_NAMES[n % 7]; // ISO: 1=Mon…7=Sun
    }
    if (typeof v === "number") {
      if (v >= 0 && v <= 6) return DOW_NAMES[v];
      if (v >= 1 && v <= 7) return DOW_NAMES[v % 7];
    }
    return null;
  }

  // Parse "HH:MM" → total minutes
  function parseTime(t) {
    if (t == null) return null;
    const s = String(t).trim();
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  const firstEntry = tradingHours[0];

  // Format A: { dayOfWeek, open/openTime/from, close/closeTime/to }
  if (firstEntry.dayOfWeek != null || firstEntry.day != null) {
    for (const slot of tradingHours) {
      const slotDow   = normaliseDow(slot.dayOfWeek ?? slot.day);
      const openMin   = parseTime(slot.open ?? slot.openTime ?? slot.from ?? slot.start);
      const closeMin  = parseTime(slot.close ?? slot.closeTime ?? slot.to ?? slot.end);

      if (!slotDow || openMin == null || closeMin == null) {
        console.warn(`cTrader ${name}: unparseable tradingHours slot: ${JSON.stringify(slot)}`);
        continue;
      }

      if (slotDow !== localDate.dow) continue;

      // Handle midnight-crossing (e.g. 22:00–02:00)
      const within = closeMin <= openMin
        ? (localMinutes >= openMin || localMinutes < closeMin)
        : (localMinutes >= openMin && localMinutes < closeMin);

      return {
        tradeable: within,
        reason: within
          ? `${name}: within ${slotDow} ${slot.open ?? slot.openTime ?? slot.from}–${slot.close ?? slot.closeTime ?? slot.to} (${tz})`
          : `${name}: outside ${slotDow} hours (${tz}), local ${localDate.hour}:${String(localDate.minute).padStart(2,"0")}`,
      };
    }
    // Today not listed → market closed today
    return { tradeable: false, reason: `${name}: ${localDate.dow} not in tradingHours — market closed today (${tz})` };
  }

  // Format B: interval style { from: { dayOfWeek, time }, to: { dayOfWeek, time } }
  if (firstEntry.from != null && firstEntry.to != null) {
    for (const interval of tradingHours) {
      const fromDow = normaliseDow(interval.from?.dayOfWeek ?? interval.from?.day);
      const toDow   = normaliseDow(interval.to?.dayOfWeek   ?? interval.to?.day);
      const fromMin = parseTime(interval.from?.time ?? interval.from?.open);
      const toMin   = parseTime(interval.to?.time   ?? interval.to?.close);

      if (!fromDow || !toDow || fromMin == null || toMin == null) {
        console.warn(`cTrader ${name}: unparseable interval slot: ${JSON.stringify(interval)}`);
        continue;
      }

      const fromDowIdx = DOW_NAMES.indexOf(fromDow);
      const toDowIdx   = DOW_NAMES.indexOf(toDow);
      const nowDowIdx  = DOW_NAMES.indexOf(localDate.dow);
      const nowMins    = localMinutes;

      // Convert to a simple "minutes since Sunday 00:00" for comparison
      const fromAbs = fromDowIdx * 1440 + fromMin;
      const toAbs   = toDowIdx   * 1440 + toMin;
      const nowAbs  = nowDowIdx  * 1440 + nowMins;

      const within = toAbs > fromAbs
        ? (nowAbs >= fromAbs && nowAbs < toAbs)
        : (nowAbs >= fromAbs || nowAbs < toAbs); // week-wrap

      if (within) {
        return { tradeable: true, reason: `${name}: within interval ${fromDow} ${interval.from.time}–${toDow} ${interval.to.time} (${tz})` };
      }
    }
    return { tradeable: false, reason: `${name}: outside all trading intervals (${tz}), local ${localDate.dow} ${localDate.hour}:${String(localDate.minute).padStart(2,"0")}` };
  }

  return { tradeable: null, reason: `${name}: tradingHours format not recognised — ${JSON.stringify(firstEntry).slice(0, 120)}` };
}

/**
 * Map a cTrader symbolCategory + symbol name to the app's asset class code.
 * Returns "fx" as the default.
 *
 * App codes: "eq" Equities · "cx" Crypto · "fx" Forex · "cm" Commodities · "ix" Index
 */

// Symbol-name overrides — checked before category ID so well-known symbols are always right
const SYMBOL_ASSET_MAP = {
  // Commodities — metals
  XAUUSD: "cm", XAUEUR: "cm", XAGUSD: "cm", XAGEUR: "cm",
  GOLD: "cm", SILVER: "cm",
  // Commodities — energy
  XTIUSD: "cm", XBRUSD: "cm", WTI: "cm", OIL: "cm", BRENT: "cm", NATGAS: "cm",
  // Crypto
  BTCUSD: "cx", ETHUSD: "cx", BTCUSDT: "cx", ETHUSDT: "cx",
  BNBUSD: "cx", SOLUSD: "cx", XRPUSD: "cx", ADAUSD: "cx",
  // Indices
  SP500: "ix", SPX500: "ix", US500: "ix", NAS100: "ix", US30: "ix",
  UK100: "ix", GER40: "ix", AUS200: "ix", JPN225: "ix", FRA40: "ix",
  // SP500 alternate spellings
  "S&P500": "ix", SPXUSD: "ix",
};

// Sanitizes user-owned fields before writing to Firestore.
// Firestore rejects: undefined values, nested arrays, oversized strings.
function sanitizeUserFields(fields) {
  return {
    strategy:    fields.strategy    ?? null,
    emotion:     fields.emotion     ?? null,
    notes:       fields.notes       ?? null,
    tags: Array.isArray(fields.tags)
      ? fields.tags.filter((t) => typeof t === "string")
      : [],
    screenshots: Array.isArray(fields.screenshots)
      ? fields.screenshots.filter((s) => s && typeof s === "object" && typeof s.src === "string" && s.src.length < 900000)
          .map((s) => ({ src: s.src, name: s.name ?? "" }))
      : [],
    psychology: {
      preThought:    fields.psychology?.preThought    ?? null,
      executionNote: fields.psychology?.executionNote ?? null,
      review:        fields.psychology?.review        ?? null,
    },
  };
}

// Returns the quote currency for a forex/commodity symbol, or "USD" as default.
// Used to detect JPY-quoted pairs whose PnL the cTrader MCP returns in JPY, not USD.
function getQuoteCurrency(symbolName) {
  const name = String(symbolName).toUpperCase().replace(/[^A-Z]/g, "");
  if (name.endsWith("JPY")) return "JPY";
  if (name.endsWith("USD")) return "USD";
  if (name.endsWith("EUR")) return "EUR";
  if (name.endsWith("GBP")) return "GBP";
  if (name.endsWith("CHF")) return "CHF";
  if (name.endsWith("CAD")) return "CAD";
  if (name.endsWith("AUD")) return "AUD";
  if (name.endsWith("NZD")) return "NZD";
  return "USD";
}

function ctraderCategoryToAsset(category, symbolName = "") {
  // 1. Check symbol name first (most reliable — API-agnostic)
  const nameKey = String(symbolName).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (SYMBOL_ASSET_MAP[nameKey]) return SYMBOL_ASSET_MAP[nameKey];
  // Also check with slashes stripped differently
  const nameRaw = String(symbolName).toUpperCase();
  if (SYMBOL_ASSET_MAP[nameRaw]) return SYMBOL_ASSET_MAP[nameRaw];

  // 2. Map standard cTrader numeric category IDs (broker-agnostic)
  const numId = Number(category);
  if (Number.isFinite(numId)) {
    if (numId === 1) return "fx";   // Forex
    if (numId === 2) return "cm";   // Metals
    if (numId === 3) return "cm";   // Energy
    if (numId === 4) return "ix";   // Indices
    if (numId === 5) return "eq";   // Equities
    if (numId === 6) return "cx";   // Crypto
  }

  // 3. String category name fallback
  if (!category) return "fx";
  const c = String(category).toLowerCase();
  if (c.includes("crypto")   || c.includes("coin"))                             return "cx";
  if (c.includes("index")    || c.includes("indice") || c.includes("indices"))  return "ix";
  if (c.includes("commodit") || c.includes("metal")  || c.includes("energy")
      || c.includes("oil")   || c.includes("gas"))                              return "cm";
  if (c.includes("stock")    || c.includes("equit")  || c.includes("share"))    return "eq";
  return "fx";
}

// ─── Required deal fields — ALL must be present. No defaults, no guessing. ───

const REQUIRED_DEAL_FIELDS = [
  "dealId",
  "positionId",
  "orderId",
  "tradeSide",
  "symbolId",
  "filledVolume",
  "executionPrice",
  "executionTimestamp",
  "dealStatus",
  // dealType intentionally omitted — cTrader MCP does not return it in deal objects.
  // ENTRY/EXIT classification is done via chronological order + pnl presence instead.
];

/**
 * Validate one raw deal from get_deals — required fields + numeric sanity.
 * Throws if any required field is missing or a numeric field is invalid.
 * Note: pnl is intentionally NOT required — ENTRY deals legitimately have null pnl.
 */
function validateDeal(rawDeal) {
  const missing = REQUIRED_DEAL_FIELDS.filter((f) => rawDeal[f] == null);
  if (missing.length > 0) {
    throw new Error(
      `cTrader deal ${rawDeal.dealId ?? "(unknown)"} missing required fields: ${missing.join(", ")}`
    );
  }

  const executionTimestamp = Number(rawDeal.executionTimestamp);
  if (!Number.isFinite(executionTimestamp) || executionTimestamp <= 0) {
    throw new Error(`cTrader deal ${rawDeal.dealId}: invalid executionTimestamp: ${rawDeal.executionTimestamp}`);
  }

  const executionPrice = Number(rawDeal.executionPrice);
  if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
    throw new Error(`cTrader deal ${rawDeal.dealId}: invalid executionPrice: ${rawDeal.executionPrice}`);
  }

  const filledVolume = Number(rawDeal.filledVolume);
  if (!Number.isFinite(filledVolume) || filledVolume < 0) {
    throw new Error(`cTrader deal ${rawDeal.dealId}: invalid filledVolume: ${rawDeal.filledVolume}`);
  }
}

/**
 * Build one Edgebook trade document from all deals sharing a positionId.
 *
 * cTrader MCP does NOT return dealType in deal objects, so ENTRY/EXIT
 * classification uses chronological order + pnl presence instead:
 *   ENTRY = first deal by executionTimestamp (the opener)
 *   EXIT  = any deal where pnl != null (the API only sets pnl on closing fills)
 *
 * For partial closes (multiple exit deals):
 *   exit = weighted-average price across all closing fills
 *   pnl  = sum of all closing-deal pnl values + commission + swap
 *
 * User-owned fields (strategy, emotion, notes, screenshots, psychology, tags)
 * are NOT included in the returned object — set(…, {merge:true}) preserves them.
 */
function toISTTime(tsMs) {
  if (!tsMs) return null;
  const ms = Number(tsMs);
  if (!Number.isFinite(ms)) return null;
  const ist = new Date(ms + 5.5 * 60 * 60 * 1000);
  return String(ist.getUTCHours()).padStart(2, "0") + ":" + String(ist.getUTCMinutes()).padStart(2, "0");
}

function toISTDate(tsMs) {
  if (!tsMs) return null;
  const ms = Number(tsMs);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function buildPositionTrade(positionId, deals, symbolInfo, accountId) {
  const lotSize  = symbolInfo.lotSize  ?? null;
  const pipSize  = symbolInfo.pipSize  ?? null;
  const pipValue = symbolInfo.pipValue ?? null;

  // ── STEP 1: verbose raw-deal logging (check field names in Cloud Logging) ────
  console.log("[buildPositionTrade] positionId:", positionId,
    "deals:", deals.length,
    "raw deals:", JSON.stringify(deals.map((d) => ({
      dealId:             d.dealId,
      executionPrice:     d.executionPrice,
      pnl:                d.pnl,
      grossPnl:           d.grossPnl,
      netPnl:             d.netPnl,
      profit:             d.profit,
      dealPnl:            d.dealPnl,
      realizedPnl:        d.realizedPnl,
      tradeSide:          d.tradeSide,
      executionTimestamp: d.executionTimestamp,
      filledVolume:       d.filledVolume,
      keys:               Object.keys(d),
    })))
  );

  // Sort chronologically — first deal is the opener
  const sorted = [...deals].sort(
    (a, b) => Number(a.executionTimestamp) - Number(b.executionTimestamp)
  );

  const primaryEntry   = sorted[0];
  const tradeSideUpper = String(primaryEntry.tradeSide ?? "BUY").toUpperCase();
  const direction      = tradeSideUpper === "BUY" ? "Long" : "Short";

  const entryTs   = Number(primaryEntry.executionTimestamp);
  const date      = toISTDate(entryTs);
  const entryTime = toISTTime(entryTs);

  // ── STEP 3: try multiple executionPrice field names ──────────────────────────
  const PRICE_FIELDS = ["executionPrice", "price", "dealPrice", "filledPrice", "closePrice"];
  const getPrice = (d) => {
    for (const f of PRICE_FIELDS) { if (d[f] != null) return Number(d[f]); }
    return null;
  };
  const entry    = getPrice(primaryEntry) ?? 0;
  const entryVol = Number(primaryEntry.filledVolume ?? primaryEntry.volume ?? primaryEntry.quantity ?? 0);
  // cTrader MCP returns filledVolume in (native contract units × 100), i.e. centilots.
  // Correct formula: filledVolume / lotSize / 100.
  // Example: XAUUSD filledVolume=600, lotSize=100 → 600/100/100 = 0.06 lots.
  const size = (lotSize && lotSize > 0)
    ? parseFloat((entryVol / lotSize / 100).toFixed(6))
    : parseFloat((entryVol / 100).toFixed(6));
  console.log(`[buildPositionTrade] pos=${positionId} symbol=${symbolInfo.name} lotSize=${lotSize} entryVol=${entryVol} size=${size} (entryVol/lotSize/100)`);

  // ── STEP 2: try multiple pnl field names ────────────────────────────────────
  const PNL_FIELDS = ["pnl", "grossPnl", "netPnl", "profit", "dealPnl", "realizedPnl", "grossProfit", "netProfit"];
  // cTrader MCP returns all monetary values in account-currency cents (1/100 of USD).
  // Divide by 100 here so every downstream calculation works in whole USD.
  const getDealPnl = (d) => {
    for (const f of PNL_FIELDS) { if (d[f] != null) return Number(d[f]) / 100; }
    return null;
  };

  // Try pnl-based exit detection first (API sets pnl on closing deals)
  // ── STEP 4: identify closing deals — must be in the opposing tradeSide direction
  // Never treat the opening deal as an exit even if it has a pnl (e.g. commission).
  const entryIsBuy = tradeSideUpper === "BUY";
  let exitDeals = sorted.filter((d) => {
    const side = String(d.tradeSide ?? "").toUpperCase();
    const isClosingDir = entryIsBuy ? side === "SELL" : side === "BUY";
    return isClosingDir && getDealPnl(d) !== null;
  });

  // Fallback: if no closing deals found with pnl, pair by tradeSide alone
  if (exitDeals.length === 0 && sorted.length > 1) {
    exitDeals = sorted.slice(1).filter((d) => {
      const side = String(d.tradeSide ?? "").toUpperCase();
      return entryIsBuy ? side === "SELL" : side === "BUY";
    });
    console.log(
      `[buildPositionTrade] pos=${positionId}: pnl null on closing deals — ` +
      `tradeSide pairing found ${exitDeals.length} exit deal(s)`
    );
  }

  let exit = null, pnl = null, exitTime = null, isOpen = true;

  if (exitDeals.length > 0) {
    isOpen = false;

    // Weighted-average exit price across all closing fills
    const totalExitVol = exitDeals.reduce(
      (s, d) => s + Number(d.filledVolume ?? d.volume ?? d.quantity ?? 0), 0
    );
    const weightedSum = exitDeals.reduce(
      (s, d) => s + (getPrice(d) ?? 0) * Number(d.filledVolume ?? d.volume ?? d.quantity ?? 0), 0
    );
    exit = totalExitVol > 0
      ? parseFloat((weightedSum / totalExitVol).toFixed(8))
      : (getPrice(exitDeals[exitDeals.length - 1]) ?? null);

    const latestExit = exitDeals[exitDeals.length - 1];
    exitTime = toISTTime(Number(latestExit.executionTimestamp));

    // Calculate P&L from price diff × size × lotSize (not the API pnl field).
    // This keeps P&L consistent with the displayed size regardless of how the
    // broker's API scales its internal monetary values.
    if (exit !== null && size > 0) {
      const priceDiff = direction === "Long" ? exit - entry : entry - exit;
      let rawPnl = priceDiff * size * (lotSize ?? 1);
      // JPY-quoted pairs: convert result from JPY to USD using the exit rate
      if (getQuoteCurrency(symbolInfo.name) === "JPY") {
        const rate = exit ?? entry;
        if (rate > 0) rawPnl = rawPnl / rate;
      }
      pnl = parseFloat(rawPnl.toFixed(2));
    }
  }

  console.log(
    `buildPositionTrade pos=${positionId}: ${sorted.length} deal(s) | ${exitDeals.length} exit deal(s) | ` +
    `entry=${entry} exit=${exit} pnl=${pnl} isOpen=${isOpen}`
  );

  const trade = {
    id:            `ctrader_${positionId}`,
    brokerTradeId: positionId,
    source:        "ctrader",
    broker:        "ctrader",
    symbol:        symbolInfo.name,
    asset:         ctraderCategoryToAsset(symbolInfo.symbolCategory, symbolInfo.name),
    direction,
    entry,
    exit,
    size,
    pnl,
    isOpen,
    date,
    entryTime,
    exitTime,
    exchange:      symbolInfo.symbolCategory ?? null,
    lotSize,
    pipSize,
    pipValue,
  };
  if (accountId) trade.accountId = accountId;
  return trade;
}

/**
 * Core sync logic for one cTrader user.
 *
 * Order of operations:
 *   1. Load token + lastSyncTimestamp from Firestore
 *   2. Open MCP session
 *   3. Fetch verified symbol details (cached 6h)
 *   4. Fetch deals since lastSyncTimestamp
 *   5. For each deal:
 *        a. Resolve symbolInfo — if not found → abort entire sync (no partial writes)
 *        b. Check enabled flag — if false → skip + log
 *        c. Check trading hours + holidays — if outside → skip + log
 *        d. Validate required fields + numeric sanity
 *        e. Normalise to trade document
 *   6. If ANY validation error → abort entirely (refuse partial write)
 *   7. Batch upsert to Firestore
 *   8. Update broker doc: lastSyncTimestamp, lastSyncResult, connectedSymbols
 *
 * Returns { saved, skipped, errors, durationMs, symbolLog }
 */

// ─── Token refresh ───────────────────────────────────────────────────────────
//
// Called automatically before sync when token is within 7 days of expiry.
// Refresh endpoint: POST https://openapi.ctrader.com/apps/token
//   ?grant_type=refresh_token
//   &refresh_token=<token>
//   &client_id=<CTRADER_CLIENT_ID>
//   &client_secret=<CTRADER_CLIENT_SECRET>
//
// On success  → updates Firestore with new access + refresh tokens and new
//               tokenExpiresAt (derived from expiresIn in the API response —
//               never hardcoded).
// On failure  → marks connected: false so the user is prompted to reconnect.
//               Returns the error rather than throwing so the caller can
//               surface a user-friendly message.

const CTRADER_TOKEN_URL = "https://openapi.ctrader.com/apps/token";
const TOKEN_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

/**
 * Attempt to refresh the cTrader access token using the stored refresh token.
 * Returns the new bearer token string on success.
 * Marks the account disconnected and throws on failure.
 */
async function refreshCtraderToken(uid, brokerRef, brokerData) {
  const clientId     = getCtraderClientId();
  const clientSecret = getCtraderClientSecret();

  if (!clientId || !clientSecret) {
    const msg =
      `cTrader token refresh skipped for uid=${uid}: ` +
      `CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET not set in functions/.env. ` +
      `Add these to enable auto-refresh.`;
    console.warn(msg);
    // Return the existing token — sync will proceed, expiry will just tick down
    return decrypt(brokerData.accessToken);
  }

  if (!brokerData.refreshToken) {
    const msg = `cTrader uid=${uid}: no refresh token stored — user must reconnect to enable auto-refresh`;
    console.warn(msg);
    return decrypt(brokerData.accessToken); // proceed with current token
  }

  const refreshToken = decrypt(brokerData.refreshToken);
  console.log(`cTrader uid=${uid}: token within 7-day expiry window — attempting refresh`);

  const url = new URL(CTRADER_TOKEN_URL);
  url.searchParams.set("grant_type",    "refresh_token");
  url.searchParams.set("refresh_token", refreshToken);
  url.searchParams.set("client_id",     clientId);
  url.searchParams.set("client_secret", clientSecret);

  let tokenRes;
  try {
    tokenRes = await fetch(url.toString(), {
      method: "POST",
      headers: { "Accept": "application/json" },
    });
  } catch (netErr) {
    throw new Error(`cTrader token refresh network error for uid=${uid}: ${netErr.message}`);
  }

  const body = await tokenRes.text();
  let tokenData;
  try {
    tokenData = JSON.parse(body);
  } catch {
    throw new Error(`cTrader token refresh: non-JSON response (HTTP ${tokenRes.status}): ${body.slice(0, 200)}`);
  }

  if (!tokenRes.ok || tokenData.error) {
    // Refresh failed — token is revoked or invalid; mark disconnected
    const errDetail = tokenData.error_description ?? tokenData.error ?? body.slice(0, 200);
    console.error(
      `cTrader uid=${uid}: token refresh FAILED (HTTP ${tokenRes.status}) — ${errDetail}. ` +
      `Marking account disconnected. User must reconnect.`
    );
    await brokerRef.set(
      {
        connected:          false,
        tokenRefreshFailed: true,
        tokenRefreshError:  errDetail,
        tokenRefreshFailedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    const err = new Error(
      `cTrader token refresh failed — please reconnect your account. Reason: ${errDetail}`
    );
    err.code = "TOKEN_REFRESH_FAILED";
    throw err;
  }

  // Success — read expiry from API response, not hardcoded
  const newAccessToken  = tokenData.access_token  ?? tokenData.accessToken;
  const newRefreshToken = tokenData.refresh_token  ?? tokenData.refreshToken ?? refreshToken;
  const expiresIn       = Number(tokenData.expires_in ?? tokenData.expiresIn ?? 0);

  if (!newAccessToken) {
    throw new Error(`cTrader token refresh: response missing access_token — ${body.slice(0, 200)}`);
  }
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(
      `cTrader token refresh: response missing or invalid expires_in (got "${tokenData.expires_in}") — ` +
      `cannot calculate tokenExpiresAt`
    );
  }

  const newExpiresAtMs = Date.now() + expiresIn * 1000;
  console.log(
    `cTrader uid=${uid}: token refreshed successfully. ` +
    `New token expires in ${expiresIn}s (${new Date(newExpiresAtMs).toISOString()})`
  );

  await brokerRef.set(
    {
      accessToken:      encrypt(newAccessToken),
      refreshToken:     encrypt(newRefreshToken),
      tokenExpiresAt:   admin.firestore.Timestamp.fromMillis(newExpiresAtMs),
      tokenExpiresIn:   expiresIn,
      tokenRefreshFailed: false,
      tokenRefreshError:  null,
      lastTokenRefreshAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return newAccessToken;
}

// ─── reconcileOpenPositions ───────────────────────────────────────────────────
// Called at the end of every syncCtraderForUser run (both incremental and
// force). Fetches the last 7 days of deals in a single API call and patches
// any Firestore trade that is still marked isOpen=true but has a closing deal
// in that window, using the same price/P&L logic as buildPositionTrade.
async function reconcileOpenPositions(uid, db, bearerToken, sessionId, symbolDetails) {
  const openSnap = await db
    .collection("users").doc(uid)
    .collection("trades")
    .where("source", "==", "ctrader")
    .where("isOpen", "==", true)
    .get();

  if (openSnap.empty) {
    console.log(`cTrader reconcile uid=${uid}: no open positions — skipping`);
    return;
  }

  const openPositions = openSnap.docs.map(d => ({
    firestoreId: d.id,
    ...d.data(),
    positionId: d.data().brokerTradeId,
  }));
  console.log(`cTrader reconcile uid=${uid}: ${openPositions.length} open position(s) to check`);

  // One 7-day deal fetch covers positions open over weekends or multi-day gaps.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();

  const dealsRaw = await callCtraderTool(bearerToken, sessionId, "get_deals", {
    fromTimestamp: sevenDaysAgo,
    toTimestamp: nowIso,
  });

  let allDeals;
  if (Array.isArray(dealsRaw)) {
    allDeals = dealsRaw;
  } else if (dealsRaw && typeof dealsRaw === "object") {
    const arrayKey = Object.keys(dealsRaw).find(k => Array.isArray(dealsRaw[k]));
    allDeals = arrayKey ? dealsRaw[arrayKey] : [];
  } else {
    allDeals = [];
  }

  if (allDeals.length === 0) {
    console.log(`cTrader reconcile uid=${uid}: no deals in 7-day window`);
    return;
  }
  console.log(`cTrader reconcile uid=${uid}: ${allDeals.length} deal(s) in 7-day window`);

  // Reverse lookup: symbol name → symbolInfo (for P&L computation)
  const symbolDetailsByName = {};
  for (const info of Object.values(symbolDetails)) {
    if (info.name) symbolDetailsByName[info.name] = info;
  }

  const PRICE_FIELDS = ["executionPrice", "price", "dealPrice", "filledPrice", "closePrice"];
  const getPrice = (d) => { for (const f of PRICE_FIELDS) { if (d[f] != null) return Number(d[f]); } return null; };

  let closedCount = 0;

  for (const openPosition of openPositions) {
    const posId = String(openPosition.positionId);
    const relatedDeals = allDeals
      .filter(d => String(d.positionId) === posId)
      .sort((a, b) => Number(a.executionTimestamp) - Number(b.executionTimestamp));

    if (relatedDeals.length === 0) continue;

    const entryDeal = relatedDeals[0];
    const entryIsBuy = String(entryDeal.tradeSide ?? "BUY").toUpperCase() === "BUY";
    const exitDeals = relatedDeals.filter(d => {
      const side = String(d.tradeSide ?? "").toUpperCase();
      return entryIsBuy ? side === "SELL" : side === "BUY";
    });

    if (exitDeals.length === 0) continue;

    const lastExit = exitDeals[exitDeals.length - 1];

    // Weighted-average exit price (same as buildPositionTrade)
    const totalExitVol = exitDeals.reduce((s, d) => s + Number(d.filledVolume ?? d.volume ?? d.quantity ?? 0), 0);
    const weightedSum = exitDeals.reduce((s, d) => s + (getPrice(d) ?? 0) * Number(d.filledVolume ?? d.volume ?? d.quantity ?? 0), 0);
    const exitPrice = totalExitVol > 0
      ? parseFloat((weightedSum / totalExitVol).toFixed(8))
      : getPrice(lastExit);

    if (exitPrice == null) continue;

    const exitTime = toISTTime(Number(lastExit.executionTimestamp));

    // Reuse stored entry/size from Firestore — already correctly computed on import.
    const entry = openPosition.entry ?? 0;
    const size = openPosition.size ?? 0;
    const symbolInfo = symbolDetailsByName[openPosition.symbol] ?? {};
    const lotSize = symbolInfo.lotSize ?? 1;

    let pnl = null;
    if (entry && size > 0) {
      const priceDiff = openPosition.direction === "Long" ? exitPrice - entry : entry - exitPrice;
      let rawPnl = priceDiff * size * lotSize;
      if (getQuoteCurrency(openPosition.symbol) === "JPY" && exitPrice > 0) {
        rawPnl = rawPnl / exitPrice;
      }
      pnl = parseFloat(rawPnl.toFixed(2));
    }

    const docRef = db.collection("users").doc(uid).collection("trades").doc(openPosition.firestoreId);
    await docRef.set({ exit: exitPrice, pnl, isOpen: false, exitTime,
      syncedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    console.log(`cTrader reconcile uid=${uid}: closed position ${posId} exit=${exitPrice} pnl=${pnl}`);
    closedCount++;
  }

  console.log(`cTrader reconcile uid=${uid}: auto-closed ${closedCount} of ${openPositions.length} open position(s)`);
}

async function syncCtraderForUser(uid, { forceRefresh = false } = {}) {
  const syncStart = Date.now();

  // ── 1. Load broker state ────────────────────────────────────────────────────
  const brokerRef = db.collection("users").doc(uid).collection("brokers").doc("ctrader");
  const brokerSnap = await brokerRef.get();

  if (!brokerSnap.exists || !brokerSnap.data().connected) {
    throw new Error(`cTrader not connected for uid=${uid}`);
  }

  const brokerData = brokerSnap.data();

  // ── 1b. Check token expiry — auto-refresh if within 7 days ─────────────────
  let bearerToken;
  const tokenExpiresAt = brokerData.tokenExpiresAt?.toMillis?.() ?? null;
  const msUntilExpiry  = tokenExpiresAt ? tokenExpiresAt - Date.now() : null;
  const daysUntilExpiry = msUntilExpiry != null ? Math.floor(msUntilExpiry / 86400000) : null;

  if (msUntilExpiry !== null && msUntilExpiry <= TOKEN_REFRESH_THRESHOLD_MS) {
    console.log(
      `cTrader uid=${uid}: token expires in ${daysUntilExpiry} day(s) ` +
      `(${tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : "unknown"}) — triggering auto-refresh`
    );
    bearerToken = await refreshCtraderToken(uid, brokerRef, brokerData);
  } else {
    bearerToken = decrypt(brokerData.accessToken);
    if (daysUntilExpiry !== null) {
      console.log(`cTrader uid=${uid}: token valid for ${daysUntilExpiry} more day(s)`);
    }
  }

  // fromTimestamp: force=true → 24h ago; normal → lastSync minus 30min buffer to
  // catch closing deals that fall just before the previous sync window.
  let fromTimestamp;
  if (forceRefresh) {
    fromTimestamp = Date.now() - 24 * 60 * 60 * 1000;
  } else if (brokerData.lastSyncTimestamp) {
    const lastMs = brokerData.lastSyncTimestamp.toMillis
      ? brokerData.lastSyncTimestamp.toMillis()
      : Number(brokerData.lastSyncTimestamp);
    fromTimestamp = lastMs - 30 * 60 * 1000; // 30-min overlap buffer
  } else {
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    fromTimestamp = todayUtc.getTime();
  }

  const toTimestamp = Date.now();
  console.log(
    `cTrader syncCtraderForUser uid=${uid}: fetching deals from ` +
    `${new Date(fromTimestamp).toISOString()} → ${new Date(toTimestamp).toISOString()}`
  );

  // ── 2. Open MCP session ─────────────────────────────────────────────────────
  const sessionId = await initCtraderSession(bearerToken);

  // ── 3. Fetch symbol details (uses 6h cache) ─────────────────────────────────
  const symbolDetails = await getVerifiedSymbolMap(bearerToken, sessionId);
  const symbolCount = Object.keys(symbolDetails).length;
  console.log(`cTrader uid=${uid}: symbol map loaded — ${symbolCount} symbols`);

  // ── 4. Fetch deals ───────────────────────────────────────────────────────────
  // cTrader MCP get_deals requires fromTimestamp and toTimestamp as ISO 8601
  // strings, not numbers — confirmed from validation error in Cloud Logging.
  const dealsRaw = await callCtraderTool(bearerToken, sessionId, "get_deals", {
    fromTimestamp: new Date(fromTimestamp).toISOString(),
    toTimestamp:   new Date(toTimestamp).toISOString(),
  });

  // Log exact response shape on every sync so we can catch format changes
  console.log(
    `cTrader uid=${uid} get_deals: type =`, typeof dealsRaw,
    "| isArray =", Array.isArray(dealsRaw),
    "| keys =", (!Array.isArray(dealsRaw) && dealsRaw && typeof dealsRaw === "object")
      ? Object.keys(dealsRaw).join(", ")
      : "n/a",
    "| preview =", JSON.stringify(dealsRaw).slice(0, 200)
  );

  // Unwrap either format:
  //   {"deals": [...]}  →  use .deals
  //   [...]             →  use as-is
  //   {"data": [...]}  /  {"result": [...]}  /  {"transactions": [...]}  →  handled
  let rawDeals;
  if (Array.isArray(dealsRaw)) {
    rawDeals = dealsRaw;
  } else if (dealsRaw && typeof dealsRaw === "object") {
    if (Array.isArray(dealsRaw.deals))        rawDeals = dealsRaw.deals;
    else if (Array.isArray(dealsRaw.data))         rawDeals = dealsRaw.data;
    else if (Array.isArray(dealsRaw.result))       rawDeals = dealsRaw.result;
    else if (Array.isArray(dealsRaw.transactions)) rawDeals = dealsRaw.transactions;
    else if (Array.isArray(dealsRaw.items))        rawDeals = dealsRaw.items;
    else {
      const arrayKey = Object.keys(dealsRaw).find((k) => Array.isArray(dealsRaw[k]));
      if (arrayKey) {
        console.log(`cTrader uid=${uid} get_deals: unwrapping via key "${arrayKey}"`);
        rawDeals = dealsRaw[arrayKey];
      } else if (Object.keys(dealsRaw).length === 0) {
        // Empty object {} — treat as no deals
        console.log(`cTrader uid=${uid} get_deals: empty object response — treating as zero deals`);
        rawDeals = [];
      } else {
        throw new Error(
          `cTrader get_deals: response is an object but contains no array value — ` +
          `keys: ${Object.keys(dealsRaw).join(", ")} — full: ${JSON.stringify(dealsRaw).slice(0, 300)}`
        );
      }
    }
  } else {
    throw new Error(
      `cTrader get_deals: unexpected response type "${typeof dealsRaw}" — ${JSON.stringify(dealsRaw).slice(0, 200)}`
    );
  }

  console.log(`cTrader uid=${uid}: fetched ${rawDeals.length} raw deal(s)`);

  if (rawDeals.length === 0) {
    const durationMs = Date.now() - syncStart;
    console.log(`cTrader uid=${uid}: no new deals — duration ${durationMs}ms`);
    await brokerRef.set(
      {
        lastSyncTimestamp:  admin.firestore.Timestamp.fromMillis(toTimestamp),
        lastSyncAt:         admin.firestore.FieldValue.serverTimestamp(),
        lastSyncResult:     { saved: 0, skipped: 0, errors: 0, durationMs },
      },
      { merge: true }
    );
    await reconcileOpenPositions(uid, db, bearerToken, sessionId, symbolDetails);
    return { saved: 0, skipped: 0, errors: [], durationMs, symbolLog: {} };
  }

  // ── 4b. Resolve prop account ID (same logic as syncCtraderHistory) ─────────
  const liveAccountId = await resolvePropAccountId(uid);
  if (liveAccountId) {
    console.log(`cTrader uid=${uid}: matched prop account id="${liveAccountId}" for live sync`);
  }

  // ── 5. Validate all deals, group by positionId, build one trade per position ──
  const rawErrors   = [];  // { dealId, error }
  const skipped     = [];  // { positionId, symbol, reason }
  const symbolLog   = {};  // { symbolName: { count, skipped } }
  const seenSymbols = new Set();
  const tradesRef   = db.collection("users").doc(uid).collection("trades");

  // 5a. Per-deal: resolve symbol, validate required fields + numerics.
  //     Abort entire sync on first unresolved symbolId (same strict policy as before).
  const validatedDeals = [];
  for (const rawDeal of rawDeals) {
    const dealId   = String(rawDeal.dealId   ?? "(unknown)");
    const symbolId = rawDeal.symbolId != null ? String(rawDeal.symbolId) : null;

    if (!symbolId) {
      rawErrors.push({ dealId, error: "missing symbolId — aborting sync" });
      console.error(`cTrader uid=${uid} deal ${dealId}: missing symbolId`);
      break;
    }
    const symbolInfo = symbolDetails[symbolId];
    if (!symbolInfo) {
      rawErrors.push({
        dealId,
        error: `symbolId ${symbolId} not in verified symbol map — aborting. ` +
               `Known IDs sample: ${Object.keys(symbolDetails).slice(0, 8).join(", ")}`,
      });
      console.error(`cTrader uid=${uid} deal ${dealId}: symbolId ${symbolId} unresolved`);
      break;
    }

    try {
      validateDeal(rawDeal);
      validatedDeals.push({ ...rawDeal, _symbolInfo: symbolInfo });
    } catch (err) {
      rawErrors.push({ dealId, error: err.message });
      console.error(`cTrader uid=${uid} deal ${dealId}: validation FAILED — ${err.message}`);
    }
  }

  if (rawErrors.length > 0) {
    console.error(`cTrader uid=${uid}: ABORTING — ${rawErrors.length} error(s):`, rawErrors);
    throw new Error(`cTrader sync aborted — ${rawErrors.length} error(s). First: ${rawErrors[0].error}`);
  }

  // 5b. Group by positionId
  const byPosition = {};
  for (const deal of validatedDeals) {
    const pid = String(deal.positionId);
    if (!byPosition[pid]) byPosition[pid] = [];
    byPosition[pid].push(deal);
  }
  console.log(
    `cTrader uid=${uid}: ${validatedDeals.length} deal(s) → ` +
    `${Object.keys(byPosition).length} position(s)`
  );

  // 5c. Per-position: check enabled/hours, build trade document
  const toProcess = [];
  for (const [positionId, posDeals] of Object.entries(byPosition)) {
    const symbolInfo = posDeals[0]._symbolInfo;
    seenSymbols.add(symbolInfo.name);
    if (!symbolLog[symbolInfo.name]) symbolLog[symbolInfo.name] = { count: 0, skipped: 0 };

    if (symbolInfo.enabled === false) {
      const reason = `symbol ${symbolInfo.name} is disabled in API`;
      skipped.push({ positionId, symbol: symbolInfo.name, reason });
      symbolLog[symbolInfo.name].skipped++;
      console.log(`cTrader uid=${uid} pos ${positionId}: SKIP — ${reason}`);
      continue;
    }

    // Check trading hours against the ENTRY deal's timestamp (not "now")
    const entryDeal  = posDeals.find((d) => String(d.dealType).toUpperCase() === "ENTRY") ?? posDeals[0];
    const hoursCheck = checkTradingHours(symbolInfo, Number(entryDeal.executionTimestamp));
    if (hoursCheck.tradeable === false) {
      skipped.push({ positionId, symbol: symbolInfo.name, reason: hoursCheck.reason });
      symbolLog[symbolInfo.name].skipped++;
      console.log(`cTrader uid=${uid} pos ${positionId}: SKIP — ${hoursCheck.reason}`);
      continue;
    }
    if (hoursCheck.tradeable === null) {
      console.warn(
        `cTrader uid=${uid} pos ${positionId}: hours indeterminate — ` +
        `${hoursCheck.reason} — processing anyway`
      );
    }

    const trade = buildPositionTrade(positionId, posDeals, symbolInfo, liveAccountId);
    toProcess.push(trade);
    symbolLog[symbolInfo.name].count++;
    console.log(
      `cTrader uid=${uid} pos ${positionId}: OK — ${symbolInfo.name} ` +
      `${trade.direction} ${trade.size} @ entry=${trade.entry} exit=${trade.exit} ` +
      `pnl=${trade.pnl} isOpen=${trade.isOpen}`
    );
  }

  // ── 6. Batch write — always set+merge by positionId (preserves user-owned fields) ──
  // merge:true means notes/screenshots/strategy/psychology written by the user are never
  // overwritten; all broker-computed fields (including size, entry, exit, pnl) are always
  // updated to the latest computed value, so stale data from earlier buggy imports is fixed.
  const BATCH_SIZE = 400;
  let written      = 0;

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const trade of toProcess.slice(i, i + BATCH_SIZE)) {
      const docRef = tradesRef.doc(`ctrader_${trade.brokerTradeId}`);
      batch.set(docRef, { ...trade, syncedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    await batch.commit();
    written += toProcess.slice(i, i + BATCH_SIZE).length;
  }

  console.log(`cTrader uid=${uid}: written/updated=${written} skipped=${skipped.length}`);

  // ── 7. Update broker metadata ─────────────────────────────────────────────────
  const durationMs      = Date.now() - syncStart;
  const connectedSymbols = Array.from(seenSymbols).sort();

  await brokerRef.set(
    {
      lastSyncTimestamp: admin.firestore.Timestamp.fromMillis(toTimestamp),
      lastSyncAt:        admin.firestore.FieldValue.serverTimestamp(),
      lastSyncResult:    { saved: written, skipped: skipped.length, errors: 0, durationMs },
      connectedSymbols,
    },
    { merge: true }
  );

  // ── Summary log ───────────────────────────────────────────────────────────────
  console.log(
    `cTrader uid=${uid} sync complete — ` +
    `fetched=${rawDeals.length} positions=${Object.keys(byPosition).length} ` +
    `written=${written} skipped=${skipped.length} duration=${durationMs}ms`
  );
  console.log(`cTrader uid=${uid} symbol breakdown:`, JSON.stringify(symbolLog));
  if (skipped.length > 0) {
    console.log(`cTrader uid=${uid} skipped positions:`, JSON.stringify(skipped));
  }

  await reconcileOpenPositions(uid, db, bearerToken, sessionId, symbolDetails);

  return { saved: written, skipped: skipped.length, errors: [], durationMs, symbolLog };
}

// ─── Token input parser ───────────────────────────────────────────────────────
//
// Users can paste in any of these formats from the cTrader config screen:
//   1. Full JSON config:  {"url":"…","headers":{"Authorization":"Bearer eyJ…"}}
//   2. Header string:     Bearer eyJ…
//   3. Raw JWT:           eyJ…
//
// Always returns the bare token string, or null if nothing usable is found.

function parseCtraderBearerInput(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();

  // Format 1: looks like JSON — try to parse and extract the Authorization header
  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s);
      // {"headers":{"Authorization":"Bearer eyJ…"}}
      const auth = obj?.headers?.Authorization ?? obj?.headers?.authorization ?? "";
      if (auth) s = auth.trim();
      // Also handle {"token":"eyJ…"} or {"access_token":"eyJ…"}
      else if (obj?.token)        s = String(obj.token).trim();
      else if (obj?.access_token) s = String(obj.access_token).trim();
    } catch {
      // Not valid JSON — fall through and try string parsing
    }
  }

  // Format 2: "Bearer eyJ…" — strip the prefix
  if (/^Bearer\s+/i.test(s)) {
    s = s.replace(/^Bearer\s+/i, "").trim();
  }

  // Strip any stray surrounding quotes or whitespace left over
  s = s.replace(/^["'`]+|["'`]+$/g, "").trim();

  // Sanity: a JWT has at least two dots; reject anything that looks wrong
  if (!s || s.length < 20) return null;

  return s;
}

// ─── 7. ctraderConnect ────────────────────────────────────────────────────────
//
// POST /ctraderConnect  { bearerToken: "<token>" }
// Validates the token by calling get_balance, fetches the symbol map to confirm
// connectivity and symbol data, then stores the encrypted token in Firestore.

exports.ctraderConnect = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }

  try {
    const decoded = await verifyAuth(req);
    const uid = decoded.uid;

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { bearerToken, refreshToken } = req.body || {};
    if (!bearerToken || typeof bearerToken !== "string") {
      return res.status(400).json({ error: "bearerToken is required in request body" });
    }

    // Accept full JSON config, "Bearer eyJ…", or raw token — all formats work
    const cleanBearer = parseCtraderBearerInput(bearerToken);
    if (!cleanBearer) {
      return res.status(400).json({
        error:
          "Could not extract a valid Bearer token from the input. " +
          "Paste the full JSON config from cTrader, 'Bearer eyJ…', or just the raw token.",
      });
    }

    const cleanRefresh = (refreshToken && typeof refreshToken === "string") ? refreshToken.trim() : null;

    // Validate token by opening a session and fetching balance
    let sessionId;
    try {
      sessionId = await initCtraderSession(cleanBearer);
    } catch (err) {
      return res.status(401).json({ error: `cTrader authentication failed: ${err.message}` });
    }

    let balance;
    try {
      balance = await callCtraderTool(cleanBearer, sessionId, "get_balance");
    } catch (err) {
      return res.status(401).json({ error: `cTrader get_balance failed: ${err.message}` });
    }

    // Fetch and cache symbol map on first connect (force refresh)
    let symbolCount;
    try {
      const symbolMap = await getVerifiedSymbolMap(cleanBearer, sessionId, { forceRefresh: true });
      symbolCount = Object.keys(symbolMap).length;
    } catch (err) {
      return res.status(502).json({ error: `cTrader symbol map fetch failed: ${err.message}` });
    }

    // Token expiry: cTrader access tokens expire in expiresIn seconds per the Open API spec.
    // We cannot retrieve expiresIn from a pre-obtained bearer token, so we use the
    // documented value of 2,628,000 seconds (~30 days) as the initial calculation.
    // On every subsequent auto-refresh the actual expiresIn from the API response is used.
    const CTRADER_ACCESS_TOKEN_EXPIRY_S = 2_628_000; // from cTrader Open API docs
    const tokenExpiresAtMs = Date.now() + CTRADER_ACCESS_TOKEN_EXPIRY_S * 1000;

    const brokerPayload = {
      connected:       true,
      accessToken:     encrypt(cleanBearer),
      connectedAt:     admin.firestore.FieldValue.serverTimestamp(),
      symbolCount,
      tokenExpiresAt:  admin.firestore.Timestamp.fromMillis(tokenExpiresAtMs),
      tokenExpiresIn:  CTRADER_ACCESS_TOKEN_EXPIRY_S,
      tokenRefreshFailed: false,
      tokenRefreshError:  null,
      // Balance snapshot for UI display (no sensitive trading data)
      accountBalance:  typeof balance === "object" ? (balance.balance ?? balance.equity ?? null) : null,
      accountCurrency: typeof balance === "object" ? (balance.currency ?? null) : null,
    };

    // Store refresh token encrypted if provided — required for auto-refresh
    if (cleanRefresh) {
      brokerPayload.refreshToken = encrypt(cleanRefresh);
      console.log(`ctraderConnect: uid=${uid} refresh token provided — auto-refresh enabled`);
    } else {
      // Explicitly null out any stale refresh token
      brokerPayload.refreshToken = null;
      console.warn(
        `ctraderConnect: uid=${uid} no refresh token provided — auto-refresh disabled. ` +
        `Token will expire on ${new Date(tokenExpiresAtMs).toISOString()}.`
      );
    }

    await db
      .collection("users").doc(uid)
      .collection("brokers").doc("ctrader")
      .set(brokerPayload, { merge: true });

    console.log(
      `ctraderConnect: uid=${uid} connected — symbolCount=${symbolCount} ` +
      `tokenExpiresAt=${new Date(tokenExpiresAtMs).toISOString()} ` +
      `refreshToken=${cleanRefresh ? "stored" : "not provided"}`
    );

    return res.status(200).json({
      ok:                 true,
      message:            "cTrader connected successfully",
      symbolCount,
      tokenExpiresAt:     tokenExpiresAtMs,
      tokenExpiresAtISO:  new Date(tokenExpiresAtMs).toISOString(),
      autoRefreshEnabled: !!cleanRefresh,
      warning:            !cleanRefresh
        ? "No refresh token provided. Token will expire in ~30 days. Paste your refresh token to enable auto-renewal."
        : null,
    });

  } catch (err) {
    const status = err.status || 500;
    console.error("ctraderConnect error:", err);
    return res.status(status).json({ error: err.message });
  }
});

// ─── 8a. ctraderSymbolInfo ────────────────────────────────────────────────────
//
// POST /ctraderSymbolInfo  (no body required, or { filter: "XAUUSD" })
// Returns the RAW symbol objects from get_symbols exactly as the API sends them.
// Use this to discover which field names carry lotSize / contractSize / pipSize
// so we can trust the API without any hardcoded fallbacks.

exports.ctraderSymbolInfo = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const decoded = await verifyAuth(req);
    const uid = decoded.uid;

    const brokerRef  = db.collection("users").doc(uid).collection("brokers").doc("ctrader");
    const brokerSnap = await brokerRef.get();
    if (!brokerSnap.exists || !brokerSnap.data().connected) {
      return res.status(400).json({ error: "cTrader not connected. Connect it in Settings first." });
    }

    let bearerToken;
    try { bearerToken = decrypt(brokerSnap.data().accessToken); } catch {
      return res.status(400).json({ error: "Failed to decrypt cTrader token." });
    }

    const sessionId = await initCtraderSession(bearerToken);

    // Step 1: get light symbol list
    const symbolsRaw = await callCtraderTool(bearerToken, sessionId, "get_symbols");
    let rawSymbols;
    if (Array.isArray(symbolsRaw)) {
      rawSymbols = symbolsRaw;
    } else if (symbolsRaw && typeof symbolsRaw === "object") {
      rawSymbols = symbolsRaw.symbols ?? symbolsRaw.data ?? symbolsRaw.result ?? symbolsRaw.items
        ?? symbolsRaw[Object.keys(symbolsRaw).find((k) => Array.isArray(symbolsRaw[k]))]
        ?? [];
    } else {
      rawSymbols = [];
    }

    const { filter } = req.body || {};
    const filtered = filter
      ? rawSymbols.filter((s) => {
          const n = String(s.name ?? s.symbolName ?? s.symbol ?? "").toUpperCase();
          return n.includes(filter.toUpperCase());
        })
      : rawSymbols.slice(0, 5);

    // Step 2: for each filtered symbol, try get_symbol (singular) with its id
    // to discover the full contract specification fields (lotSize, pipSize, etc.)
    const enriched = [];
    for (const s of filtered) {
      const symId = s.symbolId ?? s.id ?? s.symbol_id;
      const symName = s.symbolName ?? s.name ?? s.symbol;
      let fullDetails = null;
      let detailsError = null;

      // Try every plausible endpoint name + parameter shape
      const attempts = [
        { tool: "get_symbol",         args: { symbolId: symId } },
        { tool: "get_symbol",         args: { id: symId } },
        { tool: "get_symbol",         args: { symbol: symName } },
        { tool: "get_symbol_details", args: { symbolId: symId } },
        { tool: "get_symbol_info",    args: { symbolId: symId } },
        { tool: "get_contract",       args: { symbolId: symId } },
      ];

      for (const attempt of attempts) {
        try {
          const raw = await callCtraderTool(bearerToken, sessionId, attempt.tool, attempt.args);
          fullDetails = { _endpoint: attempt.tool, _args: attempt.args, ...( Array.isArray(raw) ? { result: raw } : raw ) };
          break;
        } catch (e) {
          detailsError = `${attempt.tool}: ${e.message}`;
        }
      }

      enriched.push({
        light: s,
        fullDetails,
        detailsError: fullDetails ? null : detailsError,
      });
    }

    return res.status(200).json({
      total: rawSymbols.length,
      returned: filtered.length,
      filter: filter ?? null,
      lightSymbolFields: rawSymbols[0] ? Object.keys(rawSymbols[0]) : [],
      enriched,
    });

  } catch (err) {
    console.error("ctraderSymbolInfo error:", err);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── 8. syncCtraderTrades ─────────────────────────────────────────────────────
//
// POST /syncCtraderTrades  (no body required)
// Manually trigger a cTrader sync for the authenticated user.
// Returns full detail: saved, skipped, durationMs, symbolLog.

exports.syncCtraderTrades = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const decoded = await verifyAuth(req);
    const uid = decoded.uid;

    if (!uid) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const forceRefresh = req.body?.force === true;
    const result = await syncCtraderForUser(uid, { forceRefresh });

    const note = result.saved === 0
      ? "No new deals to save — all deals either already imported, outside trading hours, or no activity since last sync."
      : `${result.saved} deal(s) saved. ${result.skipped} skipped (outside hours / disabled).`;

    return res.status(200).json({ ok: true, ...result, note });

  } catch (err) {
    const status = err.status || 500;
    console.error("syncCtraderTrades error:", err);
    return res.status(status).json({ error: err.message });
  }
});

// ─── 8b. backfillCtraderTimes ────────────────────────────────────────────────
//
// POST /backfillCtraderTimes
// Runs once automatically after login (gated by localStorage flag).
// Fetches 90 days of deals, finds matching Firestore trade docs, and
// updates date/entryTime/exitTime to IST. Sets istFixed:true when done.

exports.backfillCtraderTimes = functions
  .runWith({ timeoutSeconds: 300, memory: "256MB" })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
      const decoded = await verifyAuth(req);
      const uid = decoded.uid;

      const brokerRef = db.collection("users").doc(uid).collection("brokers").doc("ctrader");
      const brokerSnap = await brokerRef.get();
      if (!brokerSnap.exists || !brokerSnap.data().connected) {
        return res.json({ message: "cTrader not connected", updated: 0 });
      }

      const brokerData = brokerSnap.data();
      let bearerToken;
      try { bearerToken = decrypt(brokerData.accessToken); } catch {
        return res.json({ message: "Token unavailable", updated: 0 });
      }

      const sessionId = await initCtraderSession(bearerToken);
      await getVerifiedSymbolMap(bearerToken, sessionId); // warm cache

      const fromTs = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const toTs   = new Date().toISOString();
      const dealsRaw = await callCtraderTool(bearerToken, sessionId, "get_deals", {
        fromTimestamp: fromTs, toTimestamp: toTs,
      });

      let allDeals = [];
      if (Array.isArray(dealsRaw)) { allDeals = dealsRaw; }
      else if (dealsRaw && typeof dealsRaw === "object") {
        const key = Object.keys(dealsRaw).find(k => Array.isArray(dealsRaw[k]));
        if (key) allDeals = dealsRaw[key];
      }

      // Group by positionId
      const byPosition = {};
      for (const deal of allDeals) {
        const pid = String(deal.positionId);
        if (!byPosition[pid]) byPosition[pid] = [];
        byPosition[pid].push(deal);
      }

      const tradesRef = db.collection("users").doc(uid).collection("trades");
      let updated = 0;

      for (const [positionId, deals] of Object.entries(byPosition)) {
        const docRef = tradesRef.doc(`ctrader_${positionId}`);
        const snap = await docRef.get();
        if (!snap.exists) continue;

        deals.sort((a, b) => Number(a.executionTimestamp) - Number(b.executionTimestamp));
        const entryDeal  = deals[0];
        const entryTs    = Number(entryDeal.executionTimestamp);
        const entryIsBuy = String(entryDeal.tradeSide ?? "BUY").toUpperCase() === "BUY";

        const exitDeals = deals.filter(d => {
          const side = String(d.tradeSide ?? "").toUpperCase();
          return entryIsBuy ? side === "SELL" : side === "BUY";
        });

        const patch = {
          date:      toISTDate(entryTs),
          entryTime: toISTTime(entryTs),
          istFixed:  true,
        };
        if (exitDeals.length > 0) {
          patch.exitTime = toISTTime(Number(exitDeals[exitDeals.length - 1].executionTimestamp));
        }

        await docRef.set(patch, { merge: true });
        updated++;
      }

      console.log(`cTrader IST backfill uid=${uid}: ${updated} trade(s) updated`);
      return res.json({ message: `IST backfill complete — ${updated} trade(s) updated`, updated });

    } catch (err) {
      console.error("backfillCtraderTimes error:", err);
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

// ─── 8c. forceReimportCtrader ────────────────────────────────────────────────
//
// POST /forceReimportCtrader
// Server-side full reset + reimport in one call:
//   1. Delete every doc in users/{uid}/trades whose ID starts with "ctrader_"
//   2. Run syncCtraderHistory from scratch
// No console commands needed — the Force re-import button calls this directly.

exports.forceReimportCtrader = functions
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
      const decoded = await verifyAuth(req);
      const uid = decoded.uid;

      // Step 1: read all cTrader docs and preserve user-owned fields before deleting
      const tradesRef   = db.collection("users").doc(uid).collection("trades");
      const allSnap     = await tradesRef.get();
      const ctraderDocs = allSnap.docs.filter((d) => d.id.startsWith("ctrader_"));
      console.log(`forceReimportCtrader uid=${uid}: found ${ctraderDocs.length} cTrader docs`);

      const USER_FIELDS = ["notes", "screenshots", "psychology", "strategy", "emotion", "tags"];
      const userFieldsMap = {};
      for (const doc of ctraderDocs) {
        const data = doc.data();
        const saved = {};
        let hasData = false;
        for (const f of USER_FIELDS) {
          if (data[f] != null) { saved[f] = data[f]; hasData = true; }
        }
        if (hasData) userFieldsMap[doc.id] = saved;
      }
      console.log(`forceReimportCtrader uid=${uid}: preserved user fields for ${Object.keys(userFieldsMap).length} doc(s)`);

      // Step 2: delete all cTrader trade docs
      const BATCH = 400;
      for (let i = 0; i < ctraderDocs.length; i += BATCH) {
        const batch = db.batch();
        ctraderDocs.slice(i, i + BATCH).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      console.log(`forceReimportCtrader uid=${uid}: delete complete`);

      // Step 3: run full history sync
      let result;
      try {
        result = await runCtraderHistorySync(uid, req.body?.fromTimestamp ?? null);
      } catch (err) {
        console.error(`forceReimportCtrader uid=${uid}: sync step failed:`, err.message);
        throw new Error("Sync failed: " + err.message);
      }

      // Step 4: re-apply preserved user fields to newly imported docs
      // Uses individual writes (not batch) so one bad doc never aborts the whole re-import.
      const preservedEntries = Object.entries(userFieldsMap);
      if (preservedEntries.length > 0) {
        console.log(`forceReimportCtrader uid=${uid}: re-applying user fields for ${preservedEntries.length} doc(s)`);
        const newSnap = await tradesRef.get();
        const newDocIds = new Set(newSnap.docs.filter((d) => d.id.startsWith("ctrader_")).map((d) => d.id));
        let reapplied = 0;

        for (const [docId, fields] of preservedEntries) {
          if (!newDocIds.has(docId)) continue;

          const hasUserData = fields.notes || fields.strategy || fields.emotion ||
            (fields.psychology && (
              fields.psychology.preThought ||
              fields.psychology.executionNote ||
              fields.psychology.review
            ));
          if (!hasUserData) continue;

          try {
            const clean = sanitizeUserFields(fields);
            console.log(`[reapply] docId=${docId} fields=${JSON.stringify(clean).slice(0, 200)}`);
            await tradesRef.doc(docId).set(clean, { merge: true });
            reapplied++;
          } catch (err) {
            console.error(`[reapply] FAILED docId=${docId} error=${err.message} raw=${JSON.stringify(fields).slice(0, 500)}`);
            // Continue — don't let one bad doc abort the entire re-import
          }
        }

        console.log(`forceReimportCtrader uid=${uid}: user fields restored for ${reapplied} doc(s)`);
      }

      return res.status(200).json({
        ok: true,
        deleted: ctraderDocs.length,
        ...result,
      });
    } catch (err) {
      console.error("forceReimportCtrader error:", err);
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

// ─── 9. ctraderScheduledSync ──────────────────────────────────────────────────
//
// Single job — every 5 minutes, 24/7 (*/5 * * * *).
// No hardcoded market-hours gate here: the per-deal checkTradingHours() function
// uses the schedule data from the API for each symbol. The API tells us what's
// trading — we don't decide.
//
// Each user's sync is independent; a failure for one user is logged but does
// not block other users.

// ─── 10. syncCtraderHistory ───────────────────────────────────────────────────
//
// POST /syncCtraderHistory  { fromTimestamp?: <unix-ms> }
//
// Imports ALL historical closed deals from cTrader — not just today's window.
// Safe to call multiple times: deals already in Firestore are skipped by dealId.
//
// Steps:
//   1. Load & refresh token
//   2. Open MCP session
//   3. Get verified symbol map
//   4. Probe get_deals response shape to detect pagination format
//   5. Fetch ALL pages of deals in the requested time range
//   6. Match a prop/100k/2step account from the user's Firestore settings
//   7. Load existing ctrader deal IDs to skip duplicates
//   8. Validate + normalise every new deal
//   9. Batch-write to Firestore
//  10. Return { imported, skipped, total, durationMs }
//
// We deliberately set a 540-second timeout (max for 1st-gen) because a full
// account history fetch can be large.

async function runCtraderHistorySync(uid, fromTimestamp) {
  const fnStart = Date.now();

  // ── 1. Load broker state + token ──────────────────────────────────────────
  const brokerRef  = db.collection("users").doc(uid).collection("brokers").doc("ctrader");
  const brokerSnap = await brokerRef.get();

  if (!brokerSnap.exists || !brokerSnap.data().connected) {
    const err = new Error("cTrader is not connected for this account");
    err.status = 403;
    throw err;
  }

  const brokerData = brokerSnap.data();

  let bearerToken;
  const tokenExpiresAt = brokerData.tokenExpiresAt?.toMillis?.() ?? null;
  const msUntilExpiry  = tokenExpiresAt ? tokenExpiresAt - Date.now() : null;
  if (msUntilExpiry !== null && msUntilExpiry <= TOKEN_REFRESH_THRESHOLD_MS) {
    console.log(`syncCtraderHistory uid=${uid}: token near expiry — auto-refreshing`);
    bearerToken = await refreshCtraderToken(uid, brokerRef, brokerData);
  } else {
    bearerToken = decrypt(brokerData.accessToken);
  }

  // ── 2. Open MCP session ───────────────────────────────────────────────────
  const sessionId = await initCtraderSession(bearerToken);

  // ── 3. Symbol map — always force-refresh ─────────────────────────────────
  const symbolDetails = await getVerifiedSymbolMap(bearerToken, sessionId, { forceRefresh: true });
  console.log(`syncCtraderHistory uid=${uid}: symbol map loaded (fresh) — ${Object.keys(symbolDetails).length} symbols`);

  // ── 4+5. Fetch all pages of historical deals ──────────────────────────────
  const explicitFrom = (fromTimestamp != null && Number.isFinite(Number(fromTimestamp)) && Number(fromTimestamp) >= 0)
    ? Number(fromTimestamp) : null;
  const toTimestamp  = Date.now();

  const allDeals = await fetchAllHistoricalDeals(bearerToken, sessionId, uid, explicitFrom, toTimestamp);
  console.log(`syncCtraderHistory uid=${uid}: total deals fetched = ${allDeals.length}`);

  // ── 6. Resolve prop account ───────────────────────────────────────────────
  const accountId = await resolvePropAccountId(uid);

  // ── 7. Validate + group by positionId ────────────────────────────────────
  const tradesRef      = db.collection("users").doc(uid).collection("trades");
  const validationErrs = [];
  const symbolLog      = {};
  const validatedDeals = [];

  for (const rawDeal of allDeals) {
    const dealId   = String(rawDeal.dealId ?? "(unknown)");
    const symbolId = rawDeal.symbolId != null ? String(rawDeal.symbolId) : null;

    if (!symbolId) {
      validationErrs.push(`deal ${dealId}: missing symbolId`);
      console.warn(`syncCtraderHistory uid=${uid} deal ${dealId}: missing symbolId — skipping`);
      continue;
    }
    const symbolInfo = symbolDetails[symbolId];
    if (!symbolInfo) {
      validationErrs.push(`deal ${dealId}: symbolId ${symbolId} unresolved`);
      console.warn(`syncCtraderHistory uid=${uid} deal ${dealId}: symbolId ${symbolId} not in map — skipping`);
      continue;
    }
    if (symbolInfo.enabled === false) {
      console.log(`syncCtraderHistory uid=${uid} deal ${dealId}: symbol ${symbolInfo.name} disabled — skipping`);
      continue;
    }
    try {
      validateDeal(rawDeal);
      validatedDeals.push({ ...rawDeal, _symbolInfo: symbolInfo });
    } catch (err) {
      validationErrs.push(`deal ${dealId}: ${err.message}`);
      console.warn(`syncCtraderHistory uid=${uid} deal ${dealId}: validation error — ${err.message}`);
    }
  }

  const byPosition = {};
  for (const deal of validatedDeals) {
    const pid = String(deal.positionId);
    if (!byPosition[pid]) byPosition[pid] = [];
    byPosition[pid].push(deal);
  }
  console.log(
    `syncCtraderHistory uid=${uid}: ${validatedDeals.length} valid deal(s) → ` +
    `${Object.keys(byPosition).length} position(s) | validationErrors=${validationErrs.length}`
  );

  // 7c. Build one trade per positionId
  const positionTrades = [];
  for (const [positionId, posDeals] of Object.entries(byPosition)) {
    const symbolInfo = posDeals[0]._symbolInfo;
    const trade = buildPositionTrade(positionId, posDeals, symbolInfo, accountId);
    trade.importSource = "history";
    positionTrades.push(trade);
    symbolLog[symbolInfo.name] = (symbolLog[symbolInfo.name] ?? 0) + 1;
  }

  if (positionTrades.length > 0) {
    console.log(
      `syncCtraderHistory uid=${uid}: SAMPLE trade:`,
      JSON.stringify(positionTrades[0], null, 2).slice(0, 1000)
    );
  }

  // ── 8. Batch write ────────────────────────────────────────────────────────
  const BATCH_SIZE = 400;
  let written = 0;
  for (let i = 0; i < positionTrades.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const trade of positionTrades.slice(i, i + BATCH_SIZE)) {
      const docRef = tradesRef.doc(`ctrader_${trade.brokerTradeId}`);
      batch.set(docRef, { ...trade, importedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    await batch.commit();
    written += positionTrades.slice(i, i + BATCH_SIZE).length;
    console.log(`syncCtraderHistory uid=${uid}: wrote batch (${written} positions so far)`);
  }

  if (Object.keys(symbolLog).length > 0) {
    console.log(`syncCtraderHistory uid=${uid}: per-symbol →`, JSON.stringify(symbolLog));
  }

  await brokerRef.set(
    { lastHistoryImportAt: admin.firestore.FieldValue.serverTimestamp(), lastHistoryImportCount: written },
    { merge: true }
  );

  const durationMs = Date.now() - fnStart;
  console.log(
    `syncCtraderHistory uid=${uid}: COMPLETE — ` +
    `deals=${allDeals.length} positions=${Object.keys(byPosition).length} ` +
    `written=${written} errors=${validationErrs.length} duration=${durationMs}ms`
  );

  return {
    ok:        true,
    total:     allDeals.length,
    positions: Object.keys(byPosition).length,
    imported:  written,
    errors:    validationErrs.length,
    symbolLog,
    durationMs,
    note: written === 0
      ? "No positions found in the requested range."
      : `${written} position(s) written to Firestore.`,
  };
}

exports.syncCtraderHistory = functions
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      const decoded = await verifyAuth(req);
      const result  = await runCtraderHistorySync(decoded.uid, req.body?.fromTimestamp ?? null);
      return res.status(200).json(result);
    } catch (err) {
      console.error("syncCtraderHistory error:", err);
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

// ─── Helpers for syncCtraderHistory ──────────────────────────────────────────

/**
 * Probe the cTrader MCP for the account creation date using any available
 * account-info endpoints. If none of them returns a usable date, we fall back
 * to 2 years ago and log clearly so the fallback is visible in Cloud Logging.
 *
 * Endpoints tried (in order):
 *   get_account  → looks for createdAt / created_at / registrationDate / openDate
 *   get_accountinfo → same field names
 *   get_account_info → same field names
 */
async function getCtraderAccountStartDate(bearerToken, sessionId, uid) {
  const ENDPOINTS = ["get_account", "get_accountinfo", "get_account_info"];
  const DATE_FIELDS = [
    "createdAt", "created_at", "registrationDate", "registration_date",
    "openDate", "open_date", "accountDate", "startDate", "start_date",
  ];

  for (const endpoint of ENDPOINTS) {
    try {
      const raw = await callCtraderTool(bearerToken, sessionId, endpoint, {});
      // Could be an object or an array-wrapped object
      const obj = Array.isArray(raw) ? raw[0] : raw;
      if (!obj || typeof obj !== "object") continue;

      for (const field of DATE_FIELDS) {
        const val = obj[field];
        if (val == null) continue;
        // Could be a Unix ms number, a Unix s number, or an ISO string
        let ts = typeof val === "string" ? Date.parse(val) : Number(val);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        // If it looks like Unix seconds (< year 3000 in ms but < 1e12), convert
        if (ts < 1e12) ts *= 1000;
        if (ts > 0 && ts < Date.now()) {
          console.log(
            `getCtraderAccountStartDate uid=${uid}: found via ${endpoint}.${field} → ` +
            `${new Date(ts).toISOString()}`
          );
          return ts;
        }
      }
      console.log(
        `getCtraderAccountStartDate uid=${uid}: ${endpoint} responded but no date field found. ` +
        `Keys: ${Object.keys(obj).join(", ")}`
      );
    } catch (err) {
      console.log(
        `getCtraderAccountStartDate uid=${uid}: ${endpoint} failed (${err.message}) — trying next`
      );
    }
  }

  // Fallback: 2 years ago
  const fallback = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000;
  console.log(
    `getCtraderAccountStartDate uid=${uid}: FALLBACK — no account-date endpoint found. ` +
    `Using 2 years ago = ${new Date(fallback).toISOString()}. ` +
    `To import further back, pass an explicit fromTimestamp in the request body.`
  );
  return fallback;
}

/**
 * Extract a flat deals array from whatever shape the cTrader API returns.
 * Returns the array (possibly empty), or null if the shape is unrecognised.
 */
function extractDealsArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.deals))       return raw.deals;
    if (Array.isArray(raw.data))        return raw.data;
    if (Array.isArray(raw.result))      return raw.result;
    if (Array.isArray(raw.items))       return raw.items;
    if (Array.isArray(raw.positions))   return raw.positions;
    if (Array.isArray(raw.orders))      return raw.orders;
    if (Array.isArray(raw.history))     return raw.history;
    const key = Object.keys(raw).find((k) => Array.isArray(raw[k]));
    if (key) return raw[key];
    if (Object.keys(raw).length === 0) return [];
  }
  return null;
}

/**
 * Probe the cTrader MCP to find which endpoint + parameter format actually
 * returns historical deal data.  Tries a recent 30-day window (guaranteed to
 * have data if the account has any trades) across every candidate combination.
 *
 * Returns the winning { label, endpoint, makeParams } object, or null if
 * nothing worked (caller falls back to the original default).
 */
async function probeDealsEndpoint(bearerToken, sessionId, uid, toTs) {
  const probeFrom    = toTs - 30 * 24 * 60 * 60 * 1000; // last 30 days
  const probeFromISO = new Date(probeFrom).toISOString();
  const probeToISO   = new Date(toTs).toISOString();

  const CANDIDATES = [
    // (fISO, tISO, fMs, tMs) → params object
    {
      label: "get_deals {fromTimestamp/toTimestamp ISO}",
      endpoint: "get_deals",
      makeParams: (fISO, tISO)       => ({ fromTimestamp: fISO, toTimestamp: tISO }),
    },
    {
      label: "get_deals {from/to ISO}",
      endpoint: "get_deals",
      makeParams: (fISO, tISO)       => ({ from: fISO, to: tISO }),
    },
    {
      label: "get_deals {from/to ms}",
      endpoint: "get_deals",
      makeParams: (fISO, tISO, fMs, tMs) => ({ from: fMs, to: tMs }),
    },
    {
      label: "get_deals {startTime/endTime ISO}",
      endpoint: "get_deals",
      makeParams: (fISO, tISO)       => ({ startTime: fISO, endTime: tISO }),
    },
    {
      label: "get_deals {dateFrom/dateTo ISO}",
      endpoint: "get_deals",
      makeParams: (fISO, tISO)       => ({ dateFrom: fISO, dateTo: tISO }),
    },
    {
      label: "get_deals {} (no date filter)",
      endpoint: "get_deals",
      makeParams: ()                 => ({}),
    },
    {
      label: "get_deal_history {fromTimestamp/toTimestamp ISO}",
      endpoint: "get_deal_history",
      makeParams: (fISO, tISO)       => ({ fromTimestamp: fISO, toTimestamp: tISO }),
    },
    {
      label: "get_deal_history {from/to ISO}",
      endpoint: "get_deal_history",
      makeParams: (fISO, tISO)       => ({ from: fISO, to: tISO }),
    },
    {
      label: "get_closed_positions {from/to ISO}",
      endpoint: "get_closed_positions",
      makeParams: (fISO, tISO)       => ({ from: fISO, to: tISO }),
    },
    {
      label: "get_position_history {from/to ISO}",
      endpoint: "get_position_history",
      makeParams: (fISO, tISO)       => ({ from: fISO, to: tISO }),
    },
    {
      label: "get_orders_history {from/to ISO}",
      endpoint: "get_orders_history",
      makeParams: (fISO, tISO)       => ({ from: fISO, to: tISO }),
    },
  ];

  console.log(
    `probeDealsEndpoint uid=${uid}: probing ${CANDIDATES.length} endpoint/param combos ` +
    `on window ${probeFromISO} → ${probeToISO}`
  );

  for (const candidate of CANDIDATES) {
    const params = candidate.makeParams(probeFromISO, probeToISO, probeFrom, toTs);
    try {
      console.log(
        `probeDealsEndpoint uid=${uid}: trying [${candidate.label}] ` +
        `params=${JSON.stringify(params)}`
      );
      const raw = await callCtraderTool(bearerToken, sessionId, candidate.endpoint, params);
      const preview = JSON.stringify(raw).slice(0, 300);
      const keys    = (!Array.isArray(raw) && raw && typeof raw === "object")
        ? Object.keys(raw).join(", ") : "n/a";
      console.log(
        `probeDealsEndpoint uid=${uid}: [${candidate.label}] → ` +
        `type=${typeof raw} isArray=${Array.isArray(raw)} keys=[${keys}] preview=${preview}`
      );
      const deals = extractDealsArray(raw);
      if (deals !== null && deals.length > 0) {
        console.log(
          `probeDealsEndpoint uid=${uid}: ✓ WINNER [${candidate.label}] — ` +
          `${deals.length} deal(s) returned. Will use this for all chunks.`
        );
        return candidate;
      }
    } catch (err) {
      console.log(
        `probeDealsEndpoint uid=${uid}: [${candidate.label}] threw: ${err.message}`
      );
    }
  }

  console.warn(
    `probeDealsEndpoint uid=${uid}: no candidate returned deals. ` +
    `Check logs above for raw API response shapes. ` +
    `Falling back to get_deals + fromTimestamp/toTimestamp ISO for all chunks.`
  );
  return null;
}

/**
 * Fetch ALL historical deals across the full date range by splitting into
 * 720-hour (30-day) chunks — the hard cap enforced by the cTrader MCP API.
 *
 * @param {string}      bearerToken  - Decrypted access token
 * @param {string}      sessionId    - Active MCP session ID
 * @param {string}      uid          - Firestore user ID (for logging)
 * @param {number|null} fromTs       - Start of range (Unix ms), or null to auto-discover
 * @param {number}      toTs         - End of range (Unix ms), usually Date.now()
 * @returns {Array}  All deals across all chunks, combined
 */
async function fetchAllHistoricalDeals(bearerToken, sessionId, uid, fromTs, toTs) {
  // Fixed lookback: always start from Jan 1 2026 when no explicit date is given.
  // Avoids unreliable account-start discovery endpoints and ensures all trades
  // since account opening are included regardless of previous lastSyncTimestamp.
  if (fromTs === null || fromTs === undefined) {
    fromTs = new Date("2026-01-01T00:00:00.000Z").getTime();
    console.log(
      `syncCtraderHistory uid=${uid}: no fromTimestamp supplied — ` +
      `using fixed lookback from 2026-01-01T00:00:00.000Z`
    );
  }

  const CHUNK_MS  = 720 * 60 * 60 * 1000; // 720 hours = 30 days in ms
  const MAX_PAGES = 50;                    // per-chunk pagination safety cap

  // Build the list of chunk boundaries up front so we can log "chunk X / N"
  const chunks = [];
  let cursor = fromTs;
  while (cursor < toTs) {
    const end = Math.min(cursor + CHUNK_MS, toTs);
    chunks.push({ from: cursor, to: end });
    cursor = end;
  }

  console.log(
    `syncCtraderHistory uid=${uid}: ` +
    `range ${new Date(fromTs).toISOString()} → ${new Date(toTs).toISOString()} ` +
    `split into ${chunks.length} chunk(s) of ≤720h each`
  );

  // Discover which endpoint + param format the API actually accepts.
  // Probes a recent 30-day window; if nothing returns data, falls back to defaults.
  const probe       = await probeDealsEndpoint(bearerToken, sessionId, uid, toTs);
  const useEndpoint = probe?.endpoint  ?? "get_deals";
  const makeParams  = probe?.makeParams ?? ((fISO, tISO) => ({ fromTimestamp: fISO, toTimestamp: tISO }));
  console.log(
    `syncCtraderHistory uid=${uid}: using endpoint="${useEndpoint}" ` +
    `param format="${probe?.label ?? "get_deals {fromTimestamp/toTimestamp ISO} (default)"}"`
  );

  const allDeals = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    const { from: chunkFrom, to: chunkTo } = chunks[ci];
    const fromISO = new Date(chunkFrom).toISOString();
    const toISO   = new Date(chunkTo).toISOString();

    console.log(
      `syncCtraderHistory uid=${uid}: querying chunk ${ci + 1}/${chunks.length}: ` +
      `${fromISO.slice(0, 10)} → ${toISO.slice(0, 10)}`
    );

    // Within each chunk handle any pagination the API may return
    let chunkDeals   = [];
    let page         = 0;
    let pageCursor   = null;
    let pageOffset   = 0;
    let chunkFromMs  = chunkFrom; // may advance for hasMore+nextFrom pagination

    while (page < MAX_PAGES) {
      const args = makeParams(
        new Date(chunkFromMs).toISOString(),
        toISO,
        chunkFromMs,
        chunkTo
      );
      if (pageCursor)     args.cursor = pageCursor;
      if (pageOffset > 0) args.offset = pageOffset;

      console.log(
        `syncCtraderHistory uid=${uid} chunk ${ci + 1}/${chunks.length} page ${page + 1} ` +
        `request: ${useEndpoint} params=${JSON.stringify(args)}`
      );

      const raw = await callCtraderTool(bearerToken, sessionId, useEndpoint, args);

      // Log raw response shape every page (critical for diagnosing API format issues)
      console.log(
        `syncCtraderHistory uid=${uid} chunk ${ci + 1}/${chunks.length} page ${page + 1} ` +
        `response: type=${typeof raw} isArray=${Array.isArray(raw)} ` +
        `keys=[${(!Array.isArray(raw) && raw && typeof raw === "object") ? Object.keys(raw).join(", ") : "n/a"}] ` +
        `preview=${JSON.stringify(raw).slice(0, 400)}`
      );

      // API error returned as a string — log and skip chunk (don't abort entire import)
      if (typeof raw === "string") {
        console.warn(
          `syncCtraderHistory uid=${uid} chunk ${ci + 1}/${chunks.length} page ${page + 1}: ` +
          `API returned error string — skipping chunk. Error: ${raw}`
        );
        break; // move to next chunk
      }

      // Unwrap deals array; keep object envelope as meta for pagination fields
      const pageDeals = extractDealsArray(raw);
      const meta      = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};

      if (pageDeals === null) {
        console.warn(
          `syncCtraderHistory uid=${uid} chunk ${ci + 1}/${chunks.length} page ${page + 1}: ` +
          `response has no recognisable deals array — skipping chunk`
        );
        break;
      }

      if (pageDeals.length === 0) {
        console.log(
          `syncCtraderHistory uid=${uid}: ` +
          `chunk ${ci + 1}/${chunks.length} page ${page + 1} → 0 deals — moving to next chunk`
        );
        break;
      }

      console.log(
        `syncCtraderHistory uid=${uid}: ` +
        `chunk ${ci + 1}/${chunks.length} page ${page + 1} → ${pageDeals.length} deals`
      );
      chunkDeals.push(...pageDeals);

      // ── Advance pagination within this chunk ────────────────────────────────

      // Format A: hasMore + nextFrom
      if (meta.hasMore === true && meta.nextFrom != null) {
        chunkFromMs = Number(meta.nextFrom);
        pageCursor  = null;
        page++;
        continue;
      }

      // Format B: cursor-based (cursor / nextCursor / next_cursor)
      const nextCur = meta.cursor ?? meta.nextCursor ?? meta.next_cursor ?? null;
      if (nextCur && nextCur !== pageCursor) {
        pageCursor = nextCur;
        page++;
        continue;
      }

      // Format C: offset + total
      if (meta.total != null && meta.limit != null) {
        pageOffset += pageDeals.length > 0 ? pageDeals.length : Number(meta.limit);
        if (pageOffset >= Number(meta.total) || pageDeals.length === 0) {
          console.log(
            `syncCtraderHistory uid=${uid} chunk ${ci + 1}: ` +
            `offset pagination done (offset=${pageOffset} total=${meta.total})`
          );
          break;
        }
        page++;
        continue;
      }

      // No pagination → single-page response
      console.log(
        `syncCtraderHistory uid=${uid}: ` +
        `chunk ${ci + 1}/${chunks.length} complete (${chunkDeals.length} deals, no further pages)`
      );
      break;
    }

    if (page >= MAX_PAGES) {
      console.warn(
        `syncCtraderHistory uid=${uid}: chunk ${ci + 1} hit MAX_PAGES=${MAX_PAGES} safety limit`
      );
    }

    allDeals.push(...chunkDeals);
    console.log(
      `syncCtraderHistory uid=${uid}: chunk ${ci + 1}/${chunks.length} returned ${chunkDeals.length} deals ` +
      `(running total: ${allDeals.length})`
    );
  }

  console.log(
    `syncCtraderHistory uid=${uid}: DONE — ` +
    `${chunks.length} chunks fetched, ${allDeals.length} deals total`
  );
  return allDeals;
}

/**
 * Look up the user's prop/funded account from their Firestore settings.
 * Matches any account whose name contains "prop", "100k", "2step", "funded",
 * or "the5ers" (all case-insensitive).
 * Returns the account id string, or null if none found.
 */
async function resolvePropAccountId(uid) {
  const PROP_KEYWORDS = ["prop", "100k", "2step", "two step", "funded", "the5ers", "ftmo", "myfunded"];
  try {
    const settingsSnap = await db
      .collection("users").doc(uid)
      .collection("meta").doc("settings")
      .get();

    if (!settingsSnap.exists) {
      console.log(`resolvePropAccountId uid=${uid}: no settings document found`);
      return null;
    }

    const accounts = settingsSnap.data()?.accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      console.log(`resolvePropAccountId uid=${uid}: no accounts in settings`);
      return null;
    }

    const match = accounts.find((a) => {
      const name = (a.name ?? "").toLowerCase();
      return PROP_KEYWORDS.some((kw) => name.includes(kw));
    });

    if (match) {
      console.log(
        `resolvePropAccountId uid=${uid}: matched account "${match.name}" (id=${match.id}) ` +
        `from ${accounts.length} account(s)`
      );
      return match.id;
    }

    // No keyword match — if there's only one account, use it and log a note
    if (accounts.length === 1) {
      console.log(
        `resolvePropAccountId uid=${uid}: no prop-keyword match — ` +
        `only one account exists ("${accounts[0].name}"), using it`
      );
      return accounts[0].id;
    }

    console.log(
      `resolvePropAccountId uid=${uid}: ${accounts.length} accounts but none matched prop keywords: ` +
      accounts.map((a) => `"${a.name}"`).join(", ")
    );
    return null;

  } catch (err) {
    console.warn(`resolvePropAccountId uid=${uid}: error reading settings — ${err.message}`);
    return null;
  }
}

exports.ctraderScheduledSync = functions.pubsub
  .schedule("*/5 * * * *")
  .timeZone("UTC")
  .onRun(async () => {
    const jobStart = Date.now();
    console.log("ctraderScheduledSync: starting");

    const snapshot = await db
      .collectionGroup("brokers")
      .where("connected", "==", true)
      .get();

    // Filter to cTrader broker documents only (Zerodha has its own scheduler)
    const ctraderDocs = snapshot.docs.filter((doc) => doc.id === "ctrader");

    console.log(`ctraderScheduledSync: ${ctraderDocs.length} connected cTrader account(s)`);

    if (ctraderDocs.length === 0) {
      console.log("ctraderScheduledSync: no connected accounts — done");
      return;
    }

    const results = await Promise.allSettled(
      ctraderDocs.map(async (doc) => {
        const uid = doc.ref.parent.parent.id;
        try {
          const result = await syncCtraderForUser(uid);
          console.log(
            `ctraderScheduledSync: uid=${uid} saved=${result.saved} ` +
            `skipped=${result.skipped} duration=${result.durationMs}ms`
          );
          return { uid, ...result };
        } catch (err) {
          console.error(`ctraderScheduledSync: uid=${uid} FAILED — ${err.message}`);
          throw err;
        }
      })
    );

    const ok   = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.filter((r) => r.status === "rejected").length;
    console.log(
      `ctraderScheduledSync: done — ${ok} ok, ${fail} failed, ` +
      `total job duration ${Date.now() - jobStart}ms`
    );
  });
