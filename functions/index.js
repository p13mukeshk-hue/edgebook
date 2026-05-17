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
// Uses the cTrader MCP server (JSON-RPC over HTTP with SSE responses).
// Safety guarantee: symbol map is ALWAYS fetched and verified before any deal
// data is written. Any deal with an unresolvable symbolId aborts the entire
// import — we never write a trade with a wrong or missing instrument name.
// We are dealing with real money.

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
 * Build a verified symbolId → symbolName map by calling get_symbols.
 *
 * Caching strategy:
 *   - Stored in Firestore at system/ctrader document, field: symbolMap (JSON) + symbolMapUpdatedAt
 *   - If cached data is < SYMBOL_MAP_TTL_MS old, return the cached version
 *   - Otherwise, re-fetch from cTrader and update cache
 *
 * This avoids a get_symbols call on every scheduled sync (which would be 4 calls/hour).
 */
async function getVerifiedSymbolMap(bearerToken, sessionId, { forceRefresh = false } = {}) {
  const cacheRef = db.collection("system").doc("ctrader");

  if (!forceRefresh) {
    const cacheSnap = await cacheRef.get();
    if (cacheSnap.exists) {
      const { symbolMap, symbolMapUpdatedAt } = cacheSnap.data();
      const age = Date.now() - (symbolMapUpdatedAt?.toMillis?.() ?? 0);
      if (symbolMap && age < SYMBOL_MAP_TTL_MS) {
        console.log(`cTrader: using cached symbol map (${Object.keys(symbolMap).length} symbols, age ${Math.round(age / 60000)}m)`);
        return symbolMap; // { "41": "XAUUSD", "42": "XAGUSD", ... }
      }
    }
  }

  console.log("cTrader: fetching fresh symbol map from get_symbols");
  const rawSymbols = await callCtraderTool(bearerToken, sessionId, "get_symbols");

  // rawSymbols should be an array of objects with at minimum { id, name }
  if (!Array.isArray(rawSymbols)) {
    throw new Error(`cTrader get_symbols: expected array, got ${typeof rawSymbols} — ${JSON.stringify(rawSymbols).slice(0, 300)}`);
  }
  if (rawSymbols.length === 0) {
    throw new Error("cTrader get_symbols: returned empty array — cannot build symbol map");
  }

  const symbolMap = {};
  for (const s of rawSymbols) {
    const id   = String(s.id   ?? s.symbolId ?? "");
    const name = String(s.name ?? s.symbolName ?? "").trim();
    if (!id || !name) {
      console.warn("cTrader get_symbols: skipping entry with missing id or name:", JSON.stringify(s));
      continue;
    }
    symbolMap[id] = name;
  }

  if (Object.keys(symbolMap).length === 0) {
    throw new Error("cTrader get_symbols: could not extract any id→name pairs from API response");
  }

  // Persist to cache
  await cacheRef.set(
    { symbolMap, symbolMapUpdatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  console.log(`cTrader: symbol map cached — ${Object.keys(symbolMap).length} symbols`);

  return symbolMap;
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
 * Validate and normalise a raw deal object from get_deals.
 * Throws a descriptive error if any required field is missing or symbolId is unresolved.
 * Returns a clean trade document ready for Firestore.
 */
function normaliseDeal(rawDeal, symbolMap) {
  // Check required fields
  const missing = REQUIRED_DEAL_FIELDS.filter((f) => rawDeal[f] == null);
  if (missing.length > 0) {
    throw new Error(
      `cTrader deal ${rawDeal.dealId ?? "(unknown)"} is missing required fields: ${missing.join(", ")} — aborting import`
    );
  }

  const symbolId = String(rawDeal.symbolId);
  const symbolName = symbolMap[symbolId];
  if (!symbolName) {
    throw new Error(
      `cTrader deal ${rawDeal.dealId}: symbolId ${symbolId} not found in verified symbol map — ` +
      `cannot write trade with unknown instrument. ` +
      `Known IDs: ${Object.keys(symbolMap).slice(0, 10).join(", ")}...`
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

  return {
    broker:           "CTRADER",
    dealId:           String(rawDeal.dealId),
    orderId:          String(rawDeal.orderId),
    positionId:       String(rawDeal.positionId),
    symbolId:         symbolId,
    symbol:           symbolName,          // verified, human-readable
    side:             String(rawDeal.tradeSide).toUpperCase(),   // "BUY" | "SELL"
    volume:           Number(rawDeal.volume),
    filledVolume:     filledVolume,
    executionPrice:   executionPrice,
    dealStatus:       String(rawDeal.dealStatus),
    executedAt:       admin.firestore.Timestamp.fromMillis(executionTimestamp),
    // Optional enrichment fields (include only if present)
    ...(rawDeal.commission    != null && { commission:    Number(rawDeal.commission) }),
    ...(rawDeal.swap          != null && { swap:          Number(rawDeal.swap) }),
    ...(rawDeal.pnl           != null && { pnl:           Number(rawDeal.pnl) }),
    ...(rawDeal.balance       != null && { balanceAfter:  Number(rawDeal.balance) }),
    ...(rawDeal.label         != null && { label:         String(rawDeal.label) }),
    ...(rawDeal.comment       != null && { comment:       String(rawDeal.comment) }),
    importedAt: admin.firestore.FieldValue.serverTimestamp(),
    _raw: rawDeal,  // keep original for debugging; can be removed once stable
  };
}

/**
 * Core sync logic: fetch deals for a cTrader-connected user, validate every
 * deal against the verified symbol map, and upsert to Firestore.
 * Returns { trades, skipped, errors[] }.
 */
async function syncCtraderForUser(uid) {
  // 1. Load encrypted bearer token from Firestore
  const brokerRef = db.collection("users").doc(uid).collection("brokers").doc("ctrader");
  const brokerSnap = await brokerRef.get();

  if (!brokerSnap.exists || !brokerSnap.data().connected) {
    throw new Error(`cTrader not connected for uid=${uid}`);
  }

  const bearerToken = decrypt(brokerSnap.data().accessToken);

  // 2. Open MCP session
  const sessionId = await initCtraderSession(bearerToken);

  // 3. Fetch verified symbol map (uses cache when fresh)
  const symbolMap = await getVerifiedSymbolMap(bearerToken, sessionId);

  // 4. Fetch deals — default: today's deals
  //    get_deals accepts optional fromTimestamp / toTimestamp (Unix ms)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const rawDeals = await callCtraderTool(bearerToken, sessionId, "get_deals", {
    fromTimestamp: todayStart.getTime(),
    toTimestamp:   Date.now(),
  });

  if (!Array.isArray(rawDeals)) {
    throw new Error(`cTrader get_deals: expected array, got ${typeof rawDeals}`);
  }

  console.log(`cTrader syncCtraderForUser uid=${uid}: raw deal count = ${rawDeals.length}`);

  if (rawDeals.length === 0) {
    console.log(`cTrader syncCtraderForUser uid=${uid}: no deals today`);
    return { trades: 0, skipped: 0, errors: [] };
  }

  // 5. Validate and normalise ALL deals before writing ANY — fail loud
  //    If even one deal has a bad symbolId or missing field, abort entirely.
  const normalisedDeals = [];
  const validationErrors = [];

  for (const rawDeal of rawDeals) {
    try {
      normalisedDeals.push(normaliseDeal(rawDeal, symbolMap));
    } catch (err) {
      validationErrors.push(err.message);
    }
  }

  if (validationErrors.length > 0) {
    // Log all errors but throw the first — we refuse to write a partial import
    console.error(`cTrader uid=${uid}: deal validation FAILED (${validationErrors.length} errors):`, validationErrors);
    throw new Error(
      `cTrader deal validation failed — refusing partial write. First error: ${validationErrors[0]}`
    );
  }

  // 6. Upsert to Firestore (dealId as document ID prevents duplicates)
  const tradesRef = db.collection("users").doc(uid).collection("trades");
  const BATCH_SIZE = 400; // Firestore batch limit is 500
  let written = 0;

  for (let i = 0; i < normalisedDeals.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = normalisedDeals.slice(i, i + BATCH_SIZE);

    for (const trade of chunk) {
      // Use broker + dealId as composite key to avoid clashes with Zerodha trade IDs
      const docId = `ctrader_${trade.dealId}`;
      batch.set(tradesRef.doc(docId), trade, { merge: true });
    }

    await batch.commit();
    written += chunk.length;
  }

  // 7. Update broker document with last sync metadata
  await brokerRef.set(
    {
      lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSyncTradeCount: written,
    },
    { merge: true }
  );

  console.log(`cTrader syncCtraderForUser uid=${uid}: wrote ${written} trades`);
  return { trades: written, skipped: 0, errors: [] };
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

    const { bearerToken } = req.body || {};
    if (!bearerToken || typeof bearerToken !== "string" || bearerToken.trim() === "") {
      return res.status(400).json({ error: "bearerToken is required in request body" });
    }

    // Validate token by opening a session and fetching balance
    let sessionId;
    try {
      sessionId = await initCtraderSession(bearerToken);
    } catch (err) {
      return res.status(401).json({ error: `cTrader authentication failed: ${err.message}` });
    }

    let balance;
    try {
      balance = await callCtraderTool(bearerToken, sessionId, "get_balance");
    } catch (err) {
      return res.status(401).json({ error: `cTrader get_balance failed: ${err.message}` });
    }

    // Fetch and cache symbol map on first connect (force refresh)
    let symbolCount;
    try {
      const symbolMap = await getVerifiedSymbolMap(bearerToken, sessionId, { forceRefresh: true });
      symbolCount = Object.keys(symbolMap).length;
    } catch (err) {
      // Symbol map failure is fatal — we cannot safely import trades without it
      return res.status(502).json({ error: `cTrader symbol map fetch failed: ${err.message}` });
    }

    // Store encrypted token
    await db
      .collection("users").doc(uid)
      .collection("brokers").doc("ctrader")
      .set({
        connected:    true,
        accessToken:  encrypt(bearerToken.trim()),
        connectedAt:  admin.firestore.FieldValue.serverTimestamp(),
        symbolCount,
        // Store a snippet of balance info for the UI (no sensitive data)
        accountBalance: typeof balance === "object" ? (balance.balance ?? balance.equity ?? null) : null,
        accountCurrency: typeof balance === "object" ? (balance.currency ?? null) : null,
      }, { merge: true });

    console.log(`ctraderConnect: uid=${uid} connected, symbolCount=${symbolCount}`);
    return res.status(200).json({
      ok: true,
      message: "cTrader connected successfully",
      symbolCount,
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

exports.syncCtraderTrades = functions.https.onRequest(async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const decoded = await verifyAuth(req);
    const uid = decoded.uid;

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const result = await syncCtraderForUser(uid);

    const note =
      result.trades === 0
        ? "No deals found for today — market may be closed or no trades have been executed yet."
        : `${result.trades} deal(s) written to journal.`;

    return res.status(200).json({ ok: true, ...result, note });

  } catch (err) {
    const status = err.status || 500;
    console.error("syncCtraderTrades error:", err);
    return res.status(status).json({ error: err.message });
  }
});

// ─── 9. ctraderScheduledSync ──────────────────────────────────────────────────
//
// Runs every 15 minutes Mon–Fri.
// No market-hours guard here — cTrader is a global 24/5 broker (FX/indices/metals
// trade around the clock from Sunday 22:00 UTC to Friday 22:00 UTC).
// Each user's sync is independent; failures are logged but don't block others.

exports.ctraderScheduledSync = functions.pubsub
  .schedule("*/15 * * * 1-5")
  .timeZone("UTC")
  .onRun(async () => {
    console.log("ctraderScheduledSync: starting");

    const snapshot = await db
      .collectionGroup("brokers")
      .where("connected", "==", true)
      .get();

    // Filter to cTrader broker documents only
    const ctraderDocs = snapshot.docs.filter((doc) => doc.id === "ctrader");

    console.log(`ctraderScheduledSync: ${ctraderDocs.length} connected cTrader account(s)`);

    const results = await Promise.allSettled(
      ctraderDocs.map(async (doc) => {
        const uid = doc.ref.parent.parent.id;
        try {
          const result = await syncCtraderForUser(uid);
          console.log(`ctraderScheduledSync: uid=${uid} trades=${result.trades}`);
          return { uid, ...result };
        } catch (err) {
          console.error(`ctraderScheduledSync: uid=${uid} FAILED:`, err.message);
          throw err;
        }
      })
    );

    const ok   = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.filter((r) => r.status === "rejected").length;
    console.log(`ctraderScheduledSync: done — ${ok} ok, ${fail} failed`);
  });
