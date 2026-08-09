import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { publishBestEffort } from "../src/events/publish.js";

describe("best-effort realtime publication", () => {
  it("does not fail a committed mutation or log the event error contents", async () => {
    const warn = vi.fn();
    const publish = vi.fn(async () => {
      throw new Error("SENTINEL_EVENT_PAYLOAD");
    });
    const app = {
      events: { publish },
      log: { warn },
    } as unknown as FastifyInstance;

    await expect(publishBestEffort(app, "user-1", "journal.updated", { private: true }))
      .resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledWith("user-1", "journal.updated", { private: true });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SENTINEL_EVENT_PAYLOAD");
  });
});
