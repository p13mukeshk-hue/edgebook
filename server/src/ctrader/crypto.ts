import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CTraderConfig } from "../config.js";

type TokenEnvelope = {
  format: 1;
  algorithm: "A256GCM";
  keyVersion: number;
  iv: string;
  ciphertext: string;
  tag: string;
};

export interface TokenCipher {
  readonly activeKeyVersion: number;
  encrypt(plaintext: string, associatedData: string): string;
  decrypt(envelope: string, associatedData: string): string;
}

function decodeKey(encoded: string, version: number): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(encoded, "base64url");
  } catch {
    throw new Error(`CTRADER_ENCRYPTION_KEYS version ${version} is not base64/base64url`);
  }
  if (key.byteLength !== 32) {
    throw new Error(`CTRADER_ENCRYPTION_KEYS version ${version} must decode to exactly 32 bytes`);
  }
  return key;
}

export class AesGcmTokenCipher implements TokenCipher {
  readonly activeKeyVersion: number;
  readonly #keys: ReadonlyMap<number, Buffer>;

  constructor(keys: ReadonlyMap<number, Buffer>, activeKeyVersion: number) {
    const active = keys.get(activeKeyVersion);
    if (!active) throw new Error(`Active cTrader encryption key version ${activeKeyVersion} is missing`);
    this.#keys = new Map([...keys].map(([version, key]) => [version, Buffer.from(key)]));
    this.activeKeyVersion = activeKeyVersion;
  }

  static fromConfig(config: CTraderConfig): AesGcmTokenCipher {
    if (!config.storageEnabled || config.encryptionKeysJson === null || config.activeKeyVersion === null) {
      throw new Error("cTrader encryption is not configured");
    }
    let input: unknown;
    try {
      input = JSON.parse(config.encryptionKeysJson);
    } catch {
      throw new Error("CTRADER_ENCRYPTION_KEYS must be a JSON object of version-to-base64-key entries");
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("CTRADER_ENCRYPTION_KEYS must be a JSON object");
    }
    const keys = new Map<number, Buffer>();
    for (const [rawVersion, rawKey] of Object.entries(input)) {
      if (!/^[1-9]\d*$/.test(rawVersion) || typeof rawKey !== "string") {
        throw new Error("CTRADER_ENCRYPTION_KEYS entries must use positive integer versions and string keys");
      }
      const version = Number(rawVersion);
      if (!Number.isSafeInteger(version)) throw new Error("cTrader key version is too large");
      keys.set(version, decodeKey(rawKey, version));
    }
    return new AesGcmTokenCipher(keys, config.activeKeyVersion);
  }

  encrypt(plaintext: string, associatedData: string): string {
    if (plaintext.length === 0) throw new Error("Refusing to encrypt an empty cTrader token");
    const key = this.#keys.get(this.activeKeyVersion);
    if (!key) throw new Error("The active cTrader encryption key is unavailable");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const envelope: TokenEnvelope = {
      format: 1,
      algorithm: "A256GCM",
      keyVersion: this.activeKeyVersion,
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
    return JSON.stringify(envelope);
  }

  decrypt(serialized: string, associatedData: string): string {
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new Error("The cTrader token envelope is malformed");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("The cTrader token envelope is malformed");
    }
    const envelope = value as Partial<TokenEnvelope>;
    if (
      envelope.format !== 1
      || envelope.algorithm !== "A256GCM"
      || !Number.isInteger(envelope.keyVersion)
      || typeof envelope.iv !== "string"
      || typeof envelope.ciphertext !== "string"
      || typeof envelope.tag !== "string"
    ) {
      throw new Error("The cTrader token envelope has an unsupported format");
    }
    const key = this.#keys.get(envelope.keyVersion as number);
    if (!key) throw new Error(`cTrader encryption key version ${String(envelope.keyVersion)} is unavailable`);
    const iv = Buffer.from(envelope.iv, "base64url");
    const tag = Buffer.from(envelope.tag, "base64url");
    if (iv.byteLength !== 12 || tag.byteLength !== 16) throw new Error("The cTrader token envelope is malformed");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(associatedData, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("The cTrader token envelope failed authentication");
    }
  }
}

export function grantTokenAad(grantId: string, kind: "access" | "refresh"): string {
  return `edgebook:ctrader:grant:${grantId}:${kind}`;
}

export function connectionTokenAad(connectionId: string, kind: "access" | "refresh"): string {
  return `edgebook:ctrader:connection:${connectionId}:${kind}`;
}
