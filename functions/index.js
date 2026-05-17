"use strict";

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { KiteConnect } = require("kiteconnect");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// ─── Constants ───────────────────────────────────────────────────────────────

const KITE_API_KEY = "ee7h02pr0g6bmxjj";

const ALLOWED_ORIGINS = new Set([
  "https://edgebook.trade",
  "https://edgebook-2dce2.web.app",
  "https://edgebook-2dce2.firebaseapp.com",
]);

// ─── CORS — manual header injection (most reliable in Firebase Functions) ────
//
// Call this as the FIRST line of every HTTP function.
// Returns true if the request is an OPTIONS preflight (caller must return immediately).

function handleCors(req, res) {
  const origin = req.headers.origin;

  // Echo back the origin if it's on the allowlist; otherwise omit the header
  // (browser will block the request — correct behavior for unknown origins)
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }

  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Max-Age", "3600");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true; // caller must return immediately
  }
  return false;
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
async function syncTradesForUser(uid) {
  const kite = await getKiteForUser(uid);

  // Validate the token is still alive with a lightweight profile call before
  // making the real data requests — gives a clear error if it's expired.
  let profile;
  try {
    profile = await kite.getProfile();
    console.log(`syncZerodhaTrades [${uid}]: token valid, Kite user=${profile.user_id} (${profile.user_name})`);
  } catch (tokenErr) {
    console.error(`syncZerodhaTrades [${uid}]: token validation failed —`, tokenErr.message, "| error_type:", tokenErr.error_type);
    if (isTokenExpiredError(tokenErr)) {
      await markZerodhaDisconnected(uid, "access_token_expired");
      const err = new Error("Zerodha access token has expired. Please reconnect via Settings → Brokers.");
      err.status = 401;
      err.code = "TOKEN_EXPIRED";
      throw err;
    }
    throw tokenErr;
  }

  // Fetch trades and orders for the current trading day
  let trades = [], orders = [];
  try {
    [trades, orders] = await Promise.all([kite.getTrades(), kite.getOrders()]);
  } catch (apiErr) {
    console.error(`syncZerodhaTrades [${uid}]: Kite API error —`, apiErr.message, "| error_type:", apiErr.error_type, "| full:", JSON.stringify(apiErr));
    if (isTokenExpiredError(apiErr)) {
      await markZerodhaDisconnected(uid, "access_token_expired");
      const err = new Error("Zerodha access token has expired. Please reconnect via Settings → Brokers.");
      err.status = 401;
      err.code = "TOKEN_EXPIRED";
      throw err;
    }
    throw apiErr;
  }

  // Log the raw response so we can diagnose future issues in Cloud Logging
  const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(`syncZerodhaTrades [${uid}]: date(IST)=${today} trades=${trades.length} orders=${orders.length}`);
  if (trades.length > 0) {
    console.log(`syncZerodhaTrades [${uid}]: sample trade —`, JSON.stringify(trades[0]));
  }
  if (orders.length > 0) {
    console.log(`syncZerodhaTrades [${uid}]: sample order —`, JSON.stringify(orders[0]));
  }

  // Persist whatever the exchange returned (may be [] on weekends/holidays)
  if (trades.length > 0 || orders.length > 0) {
    const batch = db.batch();
    const tradesRef = db.collection("users").doc(uid).collection("trades");
    const ordersRef = db.collection("users").doc(uid).collection("orders");

    for (const trade of trades) {
      batch.set(
        tradesRef.doc(String(trade.trade_id)),
        { ...trade, broker: "zerodha", syncedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
    for (const order of orders) {
      batch.set(
        ordersRef.doc(String(order.order_id)),
        { ...order, broker: "zerodha", syncedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
    await batch.commit();
  }

  await db.collection("users").doc(uid).collection("brokers").doc("zerodha")
    .update({ lastSync: admin.firestore.FieldValue.serverTimestamp() });

  // Derive a human-readable reason for the caller when counts are 0
  const dayOfWeek = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long" });
  const isWeekend = ["Saturday", "Sunday"].includes(dayOfWeek);
  const noTradesReason = isWeekend
    ? `No trades today (${dayOfWeek} — market closed)`
    : "No trades executed today";

  return {
    trades: trades.length,
    orders: orders.length,
    note: trades.length === 0
      ? `${noTradesReason}. Kite Connect only provides same-day data; 30-day history accumulates automatically via the daily scheduled sync.`
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
  if (handleCors(req, res)) return;
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    await verifyAuth(req);
    const kite = new KiteConnect({ api_key: KITE_API_KEY });
    res.json({ loginUrl: kite.getLoginURL() });
  } catch (err) {
    console.error("zerodhaLogin:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── 2. zerodhaCallback ───────────────────────────────────────────────────────
//
// POST /zerodhaCallback  (Authorization: Bearer <Firebase ID token>)
// Body: { request_token: "…" }
// Exchanges request_token → access_token, stores encrypted in Firestore.

exports.zerodhaCallback = functions.https.onRequest(async (req, res) => {
  if (handleCors(req, res)) return;
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
  if (handleCors(req, res)) return;
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

// ─── 4. zerodhaPostback ───────────────────────────────────────────────────────
//
// POST /zerodhaPostback  (no auth — called by Zerodha's servers)
// Set this URL as the Postback URL in your Kite developer console.
// Always returns 200 immediately; Zerodha retries on anything else.

exports.zerodhaPostback = functions.https.onRequest(async (req, res) => {
  if (handleCors(req, res)) return;

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
  const rawSymbols = await callCtraderTool(bearerToken, sessionId, "get_symbols");

  if (!Array.isArray(rawSymbols)) {
    throw new Error(
      `cTrader get_symbols: expected array, got ${typeof rawSymbols} — ${JSON.stringify(rawSymbols).slice(0, 300)}`
    );
  }
  if (rawSymbols.length === 0) {
    throw new Error("cTrader get_symbols: returned empty array — cannot build symbol map");
  }

  // Log the first symbol's raw shape so we can see the exact API field names
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

    // Extract every field the user requested. Use null when absent — never default.
    const entry = {
      id,
      name,
      // Is this symbol currently tradeable?
      enabled: s.enabled ?? s.tradingEnabled ?? s.isEnabled ?? null,
      // Asset class: Forex / Crypto / Commodity / Index / etc.
      symbolCategory: s.symbolCategory ?? s.category ?? s.assetClass ?? s.type ?? null,
      // Contract / volume sizing — from API only
      lotSize:  extractNumber(s, ["lotSize", "lot_size", "contractSize", "contract_size"]),
      pipSize:  extractNumber(s, ["pipSize", "pip_size", "pipPosition", "point"]),
      pipValue: extractNumber(s, ["pipValue", "pip_value", "pipValuePerLot"]),
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
        `category=${found.symbolCategory} lotSize=${found.lotSize} pipSize=${found.pipSize} ` +
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

// ─── Required deal fields — ALL must be present. No defaults, no guessing. ───

const REQUIRED_DEAL_FIELDS = [
  "dealId",
  "orderId",
  "positionId",
  "symbolId",
  "tradeSide",
  "volume",
  "filledVolume",
  "executionPrice",
  "executionTimestamp",
  "dealStatus",
];

/**
 * Validate and normalise a raw deal from get_deals.
 * symbolInfo is the full entry from symbolDetails (not just the name string).
 *
 * P&L fields use pipValue / pipSize / lotSize from the API symbol entry.
 * If those fields aren't in the API response they are stored as null —
 * the frontend can recalculate once we have values.
 *
 * Throws if any required field is missing or symbolId unresolved.
 */
function normaliseDeal(rawDeal, symbolInfo) {
  // 1. Required field check
  const missing = REQUIRED_DEAL_FIELDS.filter((f) => rawDeal[f] == null);
  if (missing.length > 0) {
    throw new Error(
      `cTrader deal ${rawDeal.dealId ?? "(unknown)"} missing required fields: ${missing.join(", ")}`
    );
  }

  const symbolId = String(rawDeal.symbolId);

  // 2. Numeric field validation
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

  // 3. P&L metadata — from symbol API data only, null if unavailable
  const lotSize  = symbolInfo.lotSize  ?? null;
  const pipSize  = symbolInfo.pipSize  ?? null;
  const pipValue = symbolInfo.pipValue ?? null;

  // Compute lots traded (filledVolume / lotSize) only if lotSize is known
  const lotsTraded = (lotSize != null && lotSize > 0)
    ? parseFloat((filledVolume / lotSize).toFixed(8))
    : null;

  return {
    broker:          "CTRADER",
    dealId:          String(rawDeal.dealId),
    orderId:         String(rawDeal.orderId),
    positionId:      String(rawDeal.positionId),
    symbolId,
    symbol:          symbolInfo.name,          // verified name from API
    symbolCategory:  symbolInfo.symbolCategory ?? null,
    side:            String(rawDeal.tradeSide).toUpperCase(),  // "BUY" | "SELL"
    volume:          Number(rawDeal.volume),
    filledVolume,
    lotsTraded,      // derived, null if lotSize unknown
    executionPrice,
    dealStatus:      String(rawDeal.dealStatus),
    executedAt:      admin.firestore.Timestamp.fromMillis(executionTimestamp),
    // P&L sizing from API — stored so frontend can recalculate
    lotSize,
    pipSize,
    pipValue,
    // Optional deal-level fields (include only if present in API response)
    ...(rawDeal.commission != null && { commission:   Number(rawDeal.commission) }),
    ...(rawDeal.swap       != null && { swap:         Number(rawDeal.swap) }),
    ...(rawDeal.pnl        != null && { pnl:          Number(rawDeal.pnl) }),
    ...(rawDeal.balance    != null && { balanceAfter: Number(rawDeal.balance) }),
    ...(rawDeal.label      != null && { label:        String(rawDeal.label) }),
    ...(rawDeal.comment    != null && { comment:      String(rawDeal.comment) }),
    importedAt:      admin.firestore.FieldValue.serverTimestamp(),
    _raw:            rawDeal,  // keep for debugging; prune once stable
  };
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

async function syncCtraderForUser(uid) {
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

  // Use lastSyncTimestamp for incremental sync; default to start of today (UTC)
  let fromTimestamp;
  if (brokerData.lastSyncTimestamp) {
    fromTimestamp = brokerData.lastSyncTimestamp.toMillis
      ? brokerData.lastSyncTimestamp.toMillis()
      : Number(brokerData.lastSyncTimestamp);
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
  const rawDeals = await callCtraderTool(bearerToken, sessionId, "get_deals", {
    fromTimestamp,
    toTimestamp,
  });

  if (!Array.isArray(rawDeals)) {
    throw new Error(`cTrader get_deals: expected array, got ${typeof rawDeals} — ${JSON.stringify(rawDeals).slice(0, 200)}`);
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
    return { saved: 0, skipped: 0, errors: [], durationMs, symbolLog: {} };
  }

  // ── 5. Per-deal: resolve, validate, check hours ─────────────────────────────
  const nowMs = toTimestamp;
  const toProcess   = [];   // deals ready to write
  const skipped     = [];   // { dealId, symbol, reason }
  const errors      = [];   // { dealId, error }
  const symbolLog   = {};   // { symbolName: { count, skippedCount, reason? } }
  const seenSymbols = new Set();

  for (const rawDeal of rawDeals) {
    const dealId = String(rawDeal.dealId ?? "(unknown)");

    // 5a. Resolve symbolInfo — unknown symbolId → abort entire sync
    const symbolId = rawDeal.symbolId != null ? String(rawDeal.symbolId) : null;
    if (!symbolId) {
      errors.push({ dealId, error: "missing symbolId field — aborting sync" });
      console.error(`cTrader uid=${uid} deal ${dealId}: missing symbolId`);
      break; // will abort below
    }

    const symbolInfo = symbolDetails[symbolId];
    if (!symbolInfo) {
      errors.push({
        dealId,
        error: `symbolId ${symbolId} not in verified symbol map — aborting sync. ` +
               `Known IDs sample: ${Object.keys(symbolDetails).slice(0, 8).join(", ")}`,
      });
      console.error(`cTrader uid=${uid} deal ${dealId}: symbolId ${symbolId} unresolved`);
      break; // abort entire sync
    }

    seenSymbols.add(symbolInfo.name);
    if (!symbolLog[symbolInfo.name]) symbolLog[symbolInfo.name] = { count: 0, skipped: 0 };

    // 5b. Check enabled flag
    if (symbolInfo.enabled === false) {
      const reason = `symbol ${symbolInfo.name} is marked disabled in API`;
      skipped.push({ dealId, symbol: symbolInfo.name, reason });
      symbolLog[symbolInfo.name].skipped++;
      symbolLog[symbolInfo.name].skipReason = reason;
      console.log(`cTrader uid=${uid} deal ${dealId}: SKIP — ${reason}`);
      continue;
    }

    // 5c. Check trading hours + holidays (all data from API)
    const hoursCheck = checkTradingHours(symbolInfo, nowMs);
    if (hoursCheck.tradeable === false) {
      skipped.push({ dealId, symbol: symbolInfo.name, reason: hoursCheck.reason });
      symbolLog[symbolInfo.name].skipped++;
      symbolLog[symbolInfo.name].skipReason = hoursCheck.reason;
      console.log(`cTrader uid=${uid} deal ${dealId}: SKIP — ${hoursCheck.reason}`);
      continue;
    }
    if (hoursCheck.tradeable === null) {
      // Cannot determine hours from API — log but still process (we can't confirm it's outside)
      console.warn(`cTrader uid=${uid} deal ${dealId}: trading hours indeterminate — ${hoursCheck.reason} — processing anyway`);
    }

    // 5d. Validate required fields + numeric sanity
    try {
      const normalised = normaliseDeal(rawDeal, symbolInfo);
      toProcess.push(normalised);
      symbolLog[symbolInfo.name].count++;
      console.log(
        `cTrader uid=${uid} deal ${dealId}: OK — ${symbolInfo.name} ` +
        `${normalised.side} ${normalised.filledVolume} @ ${normalised.executionPrice} ` +
        `[${hoursCheck.reason}]`
      );
    } catch (err) {
      errors.push({ dealId, error: err.message });
      console.error(`cTrader uid=${uid} deal ${dealId}: validation FAILED — ${err.message}`);
    }
  }

  // ── 6. Abort if any symbolId was unresolved or validation errors exist ───────
  if (errors.length > 0) {
    console.error(
      `cTrader uid=${uid}: ABORTING — ${errors.length} error(s), refusing partial write:`,
      errors
    );
    throw new Error(
      `cTrader sync aborted — ${errors.length} error(s). First: ${errors[0].error}`
    );
  }

  // ── 7. Batch upsert ──────────────────────────────────────────────────────────
  const tradesRef  = db.collection("users").doc(uid).collection("trades");
  const BATCH_SIZE = 400;
  let written      = 0;

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const trade of toProcess.slice(i, i + BATCH_SIZE)) {
      batch.set(tradesRef.doc(`ctrader_${trade.dealId}`), trade, { merge: true });
    }
    await batch.commit();
    written += toProcess.slice(i, i + BATCH_SIZE).length;
  }

  // ── 8. Update broker metadata ─────────────────────────────────────────────────
  const durationMs = Date.now() - syncStart;
  const connectedSymbols = Array.from(seenSymbols).sort();

  await brokerRef.set(
    {
      lastSyncTimestamp:  admin.firestore.Timestamp.fromMillis(toTimestamp),
      lastSyncAt:         admin.firestore.FieldValue.serverTimestamp(),
      lastSyncResult:     { saved: written, skipped: skipped.length, errors: 0, durationMs },
      connectedSymbols,
    },
    { merge: true }
  );

  // ── Summary log ──────────────────────────────────────────────────────────────
  console.log(
    `cTrader uid=${uid} sync complete — ` +
    `fetched=${rawDeals.length} saved=${written} skipped=${skipped.length} duration=${durationMs}ms`
  );
  console.log(`cTrader uid=${uid} symbol breakdown:`, JSON.stringify(symbolLog));
  if (skipped.length > 0) {
    console.log(`cTrader uid=${uid} skipped deals:`, JSON.stringify(skipped));
  }

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
  if (handleCors(req, res)) return;

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

// ─── 8. syncCtraderTrades ─────────────────────────────────────────────────────
//
// POST /syncCtraderTrades  (no body required)
// Manually trigger a cTrader sync for the authenticated user.
// Returns full detail: saved, skipped, durationMs, symbolLog.

exports.syncCtraderTrades = functions.https.onRequest(async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const decoded = await verifyAuth(req);
    const uid = decoded.uid;

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const result = await syncCtraderForUser(uid);

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

// ─── 9. ctraderScheduledSync ──────────────────────────────────────────────────
//
// Single job — every 5 minutes, 24/7 (*/5 * * * *).
// No hardcoded market-hours gate here: the per-deal checkTradingHours() function
// uses the schedule data from the API for each symbol. The API tells us what's
// trading — we don't decide.
//
// Each user's sync is independent; a failure for one user is logged but does
// not block other users.

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
