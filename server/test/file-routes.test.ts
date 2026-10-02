import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { hashToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";
import type { ScreenshotStorage } from "../src/uploads/storage.js";

const pepper = "p".repeat(48);
const userId = "00000000-0000-4000-8000-000000000002";
const tradeId = "00000000-0000-4000-8000-000000000003";
const fileId = "00000000-0000-4000-8000-000000000004";
const idempotencyKey = "00000000-0000-4000-8000-000000000005";
const otherTradeId = "00000000-0000-4000-8000-000000000006";

function multipartBody(contents = "DATA") {
  const boundary = "edgebook-test-boundary";
  return {
    boundary,
    body: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chart.png"\r\n`
      + `Content-Type: image/png\r\n\r\n${contents}\r\n--${boundary}--\r\n`,
    ),
  };
}

function config() {
  return loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3210",
    PUBLIC_ORIGIN: "http://localhost:3210",
    DATABASE_URL: "postgresql://localhost/unused",
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    SESSION_PEPPER: pepper,
    COOKIE_SECURE: "false",
    UPLOAD_ROOT: path.resolve("test-uploads"),
  });
}

function sessionRow(id = userId) {
  return {
    session_id: "00000000-0000-4000-8000-000000000001",
    csrf_hash: hashToken("csrf-test", pepper),
    user_id: id,
    legacy_firebase_uid: null,
    email: "user@example.com",
    display_name: "User",
    avatar_url: null,
  };
}

function events() {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    publish: vi.fn(async () => ({ id: 1 })),
    replay: vi.fn(async () => []),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as EventBus;
}

describe("screenshot upload durability", () => {
  it("reconciles a lost COMMIT acknowledgement and keeps the committed file", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM trades")) return { rows: [{ id: tradeId }], rowCount: 1 };
        if (sql.includes("FROM api_idempotency_keys")) return { rows: [], rowCount: 0 };
        if (sql.includes("count(*)::text")) return { rows: [{ count: "0" }], rowCount: 1 };
        if (sql.includes("AS user_bytes")) return { rows: [{ user_bytes: "0", total_bytes: "0" }], rowCount: 1 };
        if (sql.includes("INSERT INTO file_objects")) {
          return {
            rows: [{
              id: fileId,
              trade_id: tradeId,
              storage_key: `00/${userId}/${tradeId}/${fileId}.png`,
              original_name: "chart.png",
              content_type: "image/png",
              byte_size: "4",
              width: 1,
              height: 1,
              created_at: new Date("2026-08-09T00:00:00.000Z"),
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("INSERT INTO api_idempotency_keys")) return { rows: [], rowCount: 1 };
        if (sql === "COMMIT") throw new Error("connection lost after commit");
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const database = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM sessions s")) {
          return {
            rows: [{
              session_id: "00000000-0000-4000-8000-000000000001",
              csrf_hash: hashToken("csrf-test", pepper),
              user_id: userId,
              legacy_firebase_uid: null,
              email: "user@example.com",
              display_name: "User",
              avatar_url: null,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM file_objects")) {
          return {
            rows: [{
              id: fileId,
              trade_id: tradeId,
              storage_key: `00/${userId}/${tradeId}/${fileId}.png`,
              original_name: "chart.png",
              content_type: "image/png",
              byte_size: "4",
              width: 1,
              height: 1,
              created_at: new Date("2026-08-09T00:00:00.000Z"),
            }],
            rowCount: 1,
          };
        }
        return { rows: [{ ready: 1 }], rowCount: 1 };
      }),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const events = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      publish: vi.fn(async () => { throw new Error("event bus unavailable"); }),
      replay: vi.fn(async () => []),
      subscribe: vi.fn(() => () => undefined),
    } as unknown as EventBus;
    const screenshotStorage = {
      ensureRoot: vi.fn(async () => undefined),
      process: vi.fn(async () => ({
        bytes: Buffer.from([1, 2, 3, 4]),
        contentType: "image/png",
        extension: "png",
        sha256: Buffer.alloc(32, 1),
        width: 1,
        height: 1,
      })),
      save: vi.fn(async () => `00/${userId}/${tradeId}/${fileId}.png`),
      open: vi.fn(),
      remove: vi.fn(async () => undefined),
      assertDiskCapacity: vi.fn(async () => undefined),
    } as unknown as ScreenshotStorage;
    const app = await buildApp(config(), { database, events, screenshotStorage, ctraderService: null });

    const { boundary, body } = multipartBody();
    const response = await app.inject({
      method: "POST",
      url: `/api/trades/${tradeId}/screenshots`,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test",
        "idempotency-key": idempotencyKey,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().file.id).toBe(fileId);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledWith(true);
    expect(screenshotStorage.remove).not.toHaveBeenCalled();
    expect(events.publish).toHaveBeenCalledOnce();
    await app.close();
  });

  it("replays the same key and processed image without saving another object", async () => {
    const fingerprint = createHash("sha256")
      .update("edgebook:screenshots.upload:v1\0", "utf8")
      .update(tradeId, "utf8")
      .update("\0", "utf8")
      .update(Buffer.alloc(32, 1))
      .digest();
    const replayRow = {
      request_hash: fingerprint,
      resource_id: fileId,
      id: fileId,
      trade_id: tradeId,
      storage_key: `00/${userId}/${tradeId}/${fileId}.png`,
      original_name: "chart.png",
      content_type: "image/png",
      byte_size: "4",
      width: 1,
      height: 1,
      created_at: new Date("2026-08-09T00:00:00.000Z"),
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM trades")) return { rows: [{ id: tradeId }], rowCount: 1 };
        if (sql.includes("FROM api_idempotency_keys")) return { rows: [replayRow], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const database = {
      query: vi.fn(async (sql: string) => sql.includes("FROM sessions s")
        ? { rows: [sessionRow()], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const storage = {
      ensureRoot: vi.fn(async () => undefined),
      process: vi.fn(async () => ({
        bytes: Buffer.from([1, 2, 3, 4]),
        contentType: "image/png",
        extension: "png",
        sha256: Buffer.alloc(32, 1),
        width: 1,
        height: 1,
      })),
      save: vi.fn(), open: vi.fn(), remove: vi.fn(), assertDiskCapacity: vi.fn(),
    } as unknown as ScreenshotStorage;

    client.query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("FROM trades")) return { rows: [{ id: tradeId }], rowCount: 1 };
      if (sql.includes("FROM api_idempotency_keys")) {
        return { rows: [replayRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as typeof client.query;
    const app = await buildApp(config(), { database, events: events(), screenshotStorage: storage, ctraderService: null });
    const { boundary, body } = multipartBody();
    const response = await app.inject({
      method: "POST", url: `/api/trades/${tradeId}/screenshots`,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test", "idempotency-key": idempotencyKey,
      }, payload: body,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().file.id).toBe(fileId);
    expect(storage.save).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO file_objects"), expect.anything());
    await app.close();
  });

  it.each([
    {
      label: "different trade",
      requestTradeId: otherTradeId,
      priorTradeId: tradeId,
      imageSha: Buffer.alloc(32, 1),
    },
    {
      label: "different bytes",
      requestTradeId: tradeId,
      priorTradeId: tradeId,
      imageSha: Buffer.alloc(32, 2),
    },
  ])("rejects key reuse with $label", async ({ requestTradeId, priorTradeId, imageSha }) => {
    const originalFingerprint = createHash("sha256")
      .update("edgebook:screenshots.upload:v1\0", "utf8")
      .update(priorTradeId, "utf8")
      .update("\0", "utf8")
      .update(Buffer.alloc(32, 1))
      .digest();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM trades")) return { rows: [{ id: requestTradeId }], rowCount: 1 };
        if (sql.includes("FROM api_idempotency_keys")) {
          return {
            rows: [{
              request_hash: originalFingerprint,
              resource_id: fileId,
              id: fileId,
              trade_id: priorTradeId,
              storage_key: `00/${userId}/${priorTradeId}/${fileId}.png`,
              original_name: "chart.png",
              content_type: "image/png",
              byte_size: "4",
              width: 1, height: 1,
              created_at: new Date("2026-08-09T00:00:00.000Z"),
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const database = {
      query: vi.fn(async (sql: string) => sql.includes("FROM sessions s")
        ? { rows: [sessionRow()], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const storage = {
      ensureRoot: vi.fn(async () => undefined),
      process: vi.fn(async () => ({
        bytes: Buffer.from([1, 2, 3, 4]), contentType: "image/png", extension: "png",
        sha256: imageSha, width: 1, height: 1,
      })),
      save: vi.fn(), open: vi.fn(), remove: vi.fn(), assertDiskCapacity: vi.fn(),
    } as unknown as ScreenshotStorage;
    const app = await buildApp(config(), { database, events: events(), screenshotStorage: storage, ctraderService: null });
    const { boundary, body } = multipartBody();
    const response = await app.inject({
      method: "POST", url: `/api/trades/${requestTradeId}/screenshots`,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test", "idempotency-key": idempotencyKey,
      }, payload: body,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(storage.save).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires a stable UUID key before starting an upload transaction", async () => {
    const database = {
      query: vi.fn(async (sql: string) => sql.includes("FROM sessions s")
        ? { rows: [sessionRow()], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const storage = {
      ensureRoot: vi.fn(async () => undefined), process: vi.fn(), save: vi.fn(),
      open: vi.fn(), remove: vi.fn(), assertDiskCapacity: vi.fn(),
    } as unknown as ScreenshotStorage;
    const app = await buildApp(config(), { database, events: events(), screenshotStorage: storage, ctraderService: null });
    const { boundary, body } = multipartBody();
    const response = await app.inject({
      method: "POST", url: `/api/trades/${tradeId}/screenshots`,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test",
      }, payload: body,
    });
    expect(response.statusCode).toBe(428);
    expect(response.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(database.connect).not.toHaveBeenCalled();
    expect(storage.process).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not resolve another user's idempotency key or file", async () => {
    const otherUserId = "00000000-0000-4000-8000-000000000009";
    const client = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("FROM trades")) {
          expect(values[0]).toBe(otherUserId);
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM api_idempotency_keys")) {
          throw new Error("idempotency lookup must not happen before owned trade resolution");
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const database = {
      query: vi.fn(async (sql: string) => sql.includes("FROM sessions s")
        ? { rows: [sessionRow(otherUserId)], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const storage = {
      ensureRoot: vi.fn(async () => undefined),
      process: vi.fn(async () => ({
        bytes: Buffer.from([1]), contentType: "image/png", extension: "png",
        sha256: Buffer.alloc(32, 1), width: 1, height: 1,
      })),
      save: vi.fn(), open: vi.fn(), remove: vi.fn(), assertDiskCapacity: vi.fn(),
    } as unknown as ScreenshotStorage;
    const app = await buildApp(config(), { database, events: events(), screenshotStorage: storage, ctraderService: null });
    const { boundary, body } = multipartBody();
    const response = await app.inject({
      method: "POST", url: `/api/trades/${tradeId}/screenshots`,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test", "idempotency-key": idempotencyKey,
      }, payload: body,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    expect(storage.save).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns resource-gone without revealing a deleted replay object", async () => {
    const fingerprint = createHash("sha256")
      .update("edgebook:screenshots.upload:v1\0", "utf8")
      .update(tradeId, "utf8").update("\0", "utf8").update(Buffer.alloc(32, 1)).digest();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM trades")) return { rows: [{ id: tradeId }], rowCount: 1 };
        if (sql.includes("FROM api_idempotency_keys")) {
          return { rows: [{ request_hash: fingerprint, resource_id: fileId, id: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const database = {
      query: vi.fn(async (sql: string) => sql.includes("FROM sessions s")
        ? { rows: [sessionRow()], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
      connect: vi.fn(async () => client), end: vi.fn(async () => undefined),
    } as unknown as Database;
    const storage = {
      ensureRoot: vi.fn(async () => undefined),
      process: vi.fn(async () => ({
        bytes: Buffer.from([1]), contentType: "image/png", extension: "png",
        sha256: Buffer.alloc(32, 1), width: 1, height: 1,
      })),
      save: vi.fn(), open: vi.fn(), remove: vi.fn(), assertDiskCapacity: vi.fn(),
    } as unknown as ScreenshotStorage;
    const app = await buildApp(config(), { database, events: events(), screenshotStorage: storage, ctraderService: null });
    const { boundary, body } = multipartBody();
    const response = await app.inject({
      method: "POST", url: `/api/trades/${tradeId}/screenshots`,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test", "idempotency-key": idempotencyKey,
      }, payload: body,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("IDEMPOTENCY_RESOURCE_GONE");
    expect(response.body).not.toContain(fileId);
    expect(storage.save).not.toHaveBeenCalled();
    await app.close();
  });
});
