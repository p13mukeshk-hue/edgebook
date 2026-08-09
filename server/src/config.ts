import path from "node:path";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const optionalSecret = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const blankAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const databaseConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

const storageCleanupConfigSchema = databaseConfigSchema.extend({
  UPLOAD_ROOT: z.string().min(1),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(64 * 1024).max(50 * 1024 * 1024).default(8 * 1024 * 1024),
  MAX_IMAGE_PIXELS: z.coerce.number().int().min(1_000_000).max(100_000_000).default(40_000_000),
  USER_STORAGE_QUOTA_BYTES: z.coerce.number().int().min(1_048_576).default(250 * 1024 * 1024),
  TOTAL_STORAGE_QUOTA_BYTES: z.coerce.number().int().min(1_048_576).default(10 * 1024 * 1024 * 1024),
  MIN_DISK_FREE_BYTES: z.coerce.number().int().min(0).default(1024 * 1024 * 1024),
});

const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3210),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    TRUST_PROXY: booleanString.default(false),
    PUBLIC_ORIGIN: z.string().url(),
    DATABASE_URL: z.string().min(1),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    GOOGLE_CLIENT_ID: z.string().min(10),
    SESSION_PEPPER: z.string().min(32),
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(129_600).default(1_440),
    COOKIE_SECURE: booleanString.default(true),
    UPLOAD_ROOT: z.string().min(1),
    MAX_UPLOAD_BYTES: z.coerce.number().int().min(64 * 1024).max(50 * 1024 * 1024).default(8 * 1024 * 1024),
    MAX_IMAGE_PIXELS: z.coerce.number().int().min(1_000_000).max(100_000_000).default(40_000_000),
    USER_STORAGE_QUOTA_BYTES: z.coerce.number().int().min(1_048_576).default(250 * 1024 * 1024),
    TOTAL_STORAGE_QUOTA_BYTES: z.coerce.number().int().min(1_048_576).default(10 * 1024 * 1024 * 1024),
    MIN_DISK_FREE_BYTES: z.coerce.number().int().min(0).default(1024 * 1024 * 1024),
    SSE_HEARTBEAT_MS: z.coerce.number().int().min(5_000).max(60_000).default(20_000),
    CTRADER_CLIENT_ID: optionalSecret,
    CTRADER_CLIENT_SECRET: optionalSecret,
    CTRADER_REDIRECT_URI: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().url().optional(),
    ),
    CTRADER_ENCRYPTION_KEYS: optionalSecret,
    CTRADER_ACTIVE_KEY_VERSION: z.preprocess(blankAsUndefined, z.coerce.number().int().positive().optional()),
    CTRADER_OAUTH_STATE_TTL_SECONDS: z.preprocess(blankAsUndefined, z.coerce.number().int().min(60).max(900).default(300)),
    CTRADER_GRANT_TTL_SECONDS: z.preprocess(blankAsUndefined, z.coerce.number().int().min(60).max(1_800).default(600)),
    CTRADER_REQUEST_TIMEOUT_MS: z.preprocess(blankAsUndefined, z.coerce.number().int().min(1_000).max(60_000).default(15_000)),
    CTRADER_SYNC_INTERVAL_SECONDS: z.preprocess(blankAsUndefined, z.coerce.number().int().min(30).max(86_400).default(300)),
    CTRADER_STALE_AFTER_SECONDS: z.preprocess(blankAsUndefined, z.coerce.number().int().min(120).max(86_400).default(900)),
    CTRADER_SYNC_OVERLAP_SECONDS: z.preprocess(blankAsUndefined, z.coerce.number().int().min(1).max(86_400).default(300)),
    CTRADER_HISTORY_START_TIMESTAMP: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.coerce.number().int().min(0).max(2_147_483_646_000).optional(),
    ),
    CTRADER_REFRESH_SKEW_SECONDS: z.preprocess(blankAsUndefined, z.coerce.number().int().min(30).max(86_400).default(300)),
    CTRADER_MAX_DEALS_PER_REQUEST: z.preprocess(blankAsUndefined, z.coerce.number().int().min(1).max(10_000).default(1_000)),
    CTRADER_SYMBOL_CACHE_SECONDS: z.preprocess(blankAsUndefined, z.coerce.number().int().min(60).max(604_800).default(86_400)),
    CTRADER_TRADING_TIME_ZONE: z.preprocess(blankAsUndefined, z.string().min(1).default("Asia/Kolkata")),
    SCHEDULER_ENABLED: z.preprocess(blankAsUndefined, booleanString.default(false)),
  })
  .superRefine((value, context) => {
    if (!path.isAbsolute(value.UPLOAD_ROOT)) {
      context.addIssue({
        code: "custom",
        path: ["UPLOAD_ROOT"],
        message: "UPLOAD_ROOT must be an absolute path",
      });
    }
    if (value.NODE_ENV === "production" && !value.COOKIE_SECURE) {
      context.addIssue({
        code: "custom",
        path: ["COOKIE_SECURE"],
        message: "COOKIE_SECURE must be true in production",
      });
    }
    if (value.NODE_ENV === "production" && !value.PUBLIC_ORIGIN.startsWith("https://")) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_ORIGIN"],
        message: "PUBLIC_ORIGIN must use HTTPS in production",
      });
    }

    const cTraderInputs = [
      value.CTRADER_CLIENT_ID,
      value.CTRADER_CLIENT_SECRET,
      value.CTRADER_REDIRECT_URI,
      value.CTRADER_ENCRYPTION_KEYS,
      value.CTRADER_ACTIVE_KEY_VERSION,
    ];
    const configuredCount = cTraderInputs.filter((entry) => entry !== undefined).length;
    if (configuredCount !== 0 && configuredCount !== cTraderInputs.length) {
      context.addIssue({
        code: "custom",
        path: ["CTRADER_CLIENT_ID"],
        message: "All cTrader client, redirect, keyring, and active-key variables must be set together",
      });
    }
    if (value.CTRADER_REDIRECT_URI !== undefined) {
      const redirect = new URL(value.CTRADER_REDIRECT_URI);
      const publicOrigin = new URL(value.PUBLIC_ORIGIN);
      if (
        redirect.origin !== publicOrigin.origin
        || redirect.pathname !== "/api/auth/ctrader/callback"
        || redirect.search !== ""
        || redirect.hash !== ""
      ) {
        context.addIssue({
          code: "custom",
          path: ["CTRADER_REDIRECT_URI"],
          message: "CTRADER_REDIRECT_URI must be the same-origin /api/auth/ctrader/callback URL",
        });
      }
    }
    if (value.SCHEDULER_ENABLED && configuredCount !== cTraderInputs.length) {
      context.addIssue({
        code: "custom",
        path: ["SCHEDULER_ENABLED"],
        message: "SCHEDULER_ENABLED requires a complete cTrader configuration",
      });
    }
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: value.CTRADER_TRADING_TIME_ZONE }).format();
    } catch {
      context.addIssue({
        code: "custom",
        path: ["CTRADER_TRADING_TIME_ZONE"],
        message: "CTRADER_TRADING_TIME_ZONE must be a valid IANA time zone",
      });
    }
  });

export type CTraderConfig = {
  enabled: boolean;
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string | null;
  encryptionKeysJson: string | null;
  activeKeyVersion: number | null;
  oauthStateTtlSeconds: number;
  grantTtlSeconds: number;
  requestTimeoutMs: number;
  syncIntervalSeconds: number;
  staleAfterSeconds: number;
  syncOverlapSeconds: number;
  historyStartTimestamp: number | null;
  refreshSkewSeconds: number;
  maxDealsPerRequest: number;
  symbolCacheSeconds: number;
  tradingTimeZone: string;
  schedulerEnabled: boolean;
};

export type DatabaseConfig = {
  databaseUrl: string;
  dbPoolMax: number;
};

export type ScreenshotStorageConfig = {
  uploadRoot: string;
  maxUploadBytes: number;
  maxImagePixels: number;
  userStorageQuotaBytes: number;
  totalStorageQuotaBytes: number;
  minDiskFreeBytes: number;
};

export type StorageCleanupConfig = DatabaseConfig & ScreenshotStorageConfig;

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  trustProxy: boolean;
  publicOrigin: string;
  databaseUrl: string;
  dbPoolMax: number;
  googleClientId: string;
  sessionPepper: string;
  sessionTtlDays: number;
  sessionIdleMinutes: number;
  cookieSecure: boolean;
  uploadRoot: string;
  maxUploadBytes: number;
  maxImagePixels: number;
  userStorageQuotaBytes: number;
  totalStorageQuotaBytes: number;
  minDiskFreeBytes: number;
  sseHeartbeatMs: number;
  cTrader: CTraderConfig;
};

/** Minimal configuration for one-shot schema tooling. */
export function loadDatabaseConfig(environment: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const parsed = databaseConfigSchema.parse(environment);
  return { databaseUrl: parsed.DATABASE_URL, dbPoolMax: parsed.DB_POOL_MAX };
}

/** Minimal configuration for the screenshot deletion-queue worker. */
export function loadStorageCleanupConfig(environment: NodeJS.ProcessEnv = process.env): StorageCleanupConfig {
  const parsed = storageCleanupConfigSchema.parse(environment);
  if (!path.isAbsolute(parsed.UPLOAD_ROOT)) {
    throw new Error("UPLOAD_ROOT must be an absolute path");
  }
  return {
    databaseUrl: parsed.DATABASE_URL,
    dbPoolMax: parsed.DB_POOL_MAX,
    uploadRoot: path.resolve(parsed.UPLOAD_ROOT),
    maxUploadBytes: parsed.MAX_UPLOAD_BYTES,
    maxImagePixels: parsed.MAX_IMAGE_PIXELS,
    userStorageQuotaBytes: parsed.USER_STORAGE_QUOTA_BYTES,
    totalStorageQuotaBytes: parsed.TOTAL_STORAGE_QUOTA_BYTES,
    minDiskFreeBytes: parsed.MIN_DISK_FREE_BYTES,
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(environment);
  const cTraderEnabled = parsed.CTRADER_CLIENT_ID !== undefined;
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    trustProxy: parsed.TRUST_PROXY,
    publicOrigin: parsed.PUBLIC_ORIGIN,
    databaseUrl: parsed.DATABASE_URL,
    dbPoolMax: parsed.DB_POOL_MAX,
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    sessionPepper: parsed.SESSION_PEPPER,
    sessionTtlDays: parsed.SESSION_TTL_DAYS,
    sessionIdleMinutes: parsed.SESSION_IDLE_MINUTES,
    cookieSecure: parsed.COOKIE_SECURE,
    uploadRoot: path.resolve(parsed.UPLOAD_ROOT),
    maxUploadBytes: parsed.MAX_UPLOAD_BYTES,
    maxImagePixels: parsed.MAX_IMAGE_PIXELS,
    userStorageQuotaBytes: parsed.USER_STORAGE_QUOTA_BYTES,
    totalStorageQuotaBytes: parsed.TOTAL_STORAGE_QUOTA_BYTES,
    minDiskFreeBytes: parsed.MIN_DISK_FREE_BYTES,
    sseHeartbeatMs: parsed.SSE_HEARTBEAT_MS,
    cTrader: {
      enabled: cTraderEnabled,
      clientId: parsed.CTRADER_CLIENT_ID ?? null,
      clientSecret: parsed.CTRADER_CLIENT_SECRET ?? null,
      redirectUri: parsed.CTRADER_REDIRECT_URI ?? null,
      encryptionKeysJson: parsed.CTRADER_ENCRYPTION_KEYS ?? null,
      activeKeyVersion: parsed.CTRADER_ACTIVE_KEY_VERSION ?? null,
      oauthStateTtlSeconds: parsed.CTRADER_OAUTH_STATE_TTL_SECONDS,
      grantTtlSeconds: parsed.CTRADER_GRANT_TTL_SECONDS,
      requestTimeoutMs: parsed.CTRADER_REQUEST_TIMEOUT_MS,
      syncIntervalSeconds: parsed.CTRADER_SYNC_INTERVAL_SECONDS,
      staleAfterSeconds: parsed.CTRADER_STALE_AFTER_SECONDS,
      syncOverlapSeconds: parsed.CTRADER_SYNC_OVERLAP_SECONDS,
      historyStartTimestamp: parsed.CTRADER_HISTORY_START_TIMESTAMP ?? null,
      refreshSkewSeconds: parsed.CTRADER_REFRESH_SKEW_SECONDS,
      maxDealsPerRequest: parsed.CTRADER_MAX_DEALS_PER_REQUEST,
      symbolCacheSeconds: parsed.CTRADER_SYMBOL_CACHE_SECONDS,
      tradingTimeZone: parsed.CTRADER_TRADING_TIME_ZONE,
      schedulerEnabled: parsed.SCHEDULER_ENABLED,
    },
  };
}
