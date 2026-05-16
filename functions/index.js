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
    if (snapshot.empty) {
      console.log("marketHoursTradeSync: no connected users");
      return;
    }

    const results = await Promise.allSettled(
      snapshot.docs.map(async (doc) => {
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
    const results = await Promise.allSettled(
      snapshot.docs.map(async (doc) => {
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
