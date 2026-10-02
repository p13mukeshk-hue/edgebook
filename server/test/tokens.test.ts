import { describe, expect, it } from "vitest";
import { createOpaqueToken, hashToken, safeBufferEqual, safeEqual } from "../src/auth/tokens.js";

describe("session token primitives", () => {
  it("creates high-entropy opaque values", () => {
    const first = createOpaqueToken();
    const second = createOpaqueToken();
    expect(first).not.toBe(second);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
  });

  it("hashes with the deployment pepper", () => {
    const token = "opaque-session-token";
    const first = hashToken(token, "a".repeat(32));
    const second = hashToken(token, "b".repeat(32));
    expect(safeBufferEqual(first, hashToken(token, "a".repeat(32)))).toBe(true);
    expect(safeBufferEqual(first, second)).toBe(false);
  });

  it("compares csrf values without accepting prefix matches", () => {
    expect(safeEqual("same", "same")).toBe(true);
    expect(safeEqual("same", "same-longer")).toBe(false);
  });
});
