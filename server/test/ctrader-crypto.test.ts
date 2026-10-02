import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AesGcmTokenCipher, connectionTokenAad } from "../src/ctrader/crypto.js";

describe("cTrader token envelopes", () => {
  it("round-trips only with the exact connection and token kind AAD", () => {
    const cipher = new AesGcmTokenCipher(new Map([[7, randomBytes(32)]]), 7);
    const envelope = cipher.encrypt("secret-refresh-token", connectionTokenAad("connection-a", "refresh"));
    expect(envelope).not.toContain("secret-refresh-token");
    expect(cipher.decrypt(envelope, connectionTokenAad("connection-a", "refresh"))).toBe("secret-refresh-token");
    expect(() => cipher.decrypt(envelope, connectionTokenAad("connection-b", "refresh"))).toThrow(/authentication/);
    expect(() => cipher.decrypt(envelope, connectionTokenAad("connection-a", "access"))).toThrow(/authentication/);
  });
});
