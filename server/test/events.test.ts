import { describe, expect, it, vi } from "vitest";
import { createSessionHeartbeat, eventFrame } from "../src/modules/events/routes.js";

describe("SSE wire contract", () => {
  it("uses the default message channel consumed by EventSource.onmessage", () => {
    const frame = eventFrame({
      id: 42,
      userId: "00000000-0000-4000-8000-000000000001",
      type: "trade.updated",
      payload: { id: "trade-1" },
      occurredAt: "2026-08-09T00:00:00.000Z",
    });
    expect(frame).toContain("id: 42\n");
    expect(frame).toContain('"type":"trade.updated"');
    expect(frame).not.toContain("event: trade.updated");
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("closes a revoked session stream and emits no later heartbeat", async () => {
    const validate = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const heartbeat = vi.fn();
    const close = vi.fn();
    const monitor = createSessionHeartbeat({ intervalMs: 60_000, validate, heartbeat, close });

    await monitor.runNow();
    expect(heartbeat).toHaveBeenCalledOnce();
    await monitor.runNow();
    expect(close).toHaveBeenCalledOnce();
    await monitor.runNow();
    expect(validate).toHaveBeenCalledTimes(2);
    expect(heartbeat).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it("fails a stream closed when session liveness cannot be checked", async () => {
    const close = vi.fn();
    const heartbeat = vi.fn();
    const monitor = createSessionHeartbeat({
      intervalMs: 60_000,
      validate: vi.fn(async () => { throw new Error("database unavailable"); }),
      heartbeat,
      close,
    });
    await monitor.runNow();
    expect(close).toHaveBeenCalledOnce();
    expect(heartbeat).not.toHaveBeenCalled();
    monitor.stop();
  });
});
