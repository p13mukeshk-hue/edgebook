import type { FastifyInstance } from "fastify";
import type { UserEvent } from "../../events/event-bus.js";

export function eventFrame(event: UserEvent): string {
  // The browser adapter consumes EventSource.onmessage. Keep every business
  // event on the default message channel and carry its type in the JSON body.
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

type SessionHeartbeatOptions = {
  intervalMs: number;
  validate: () => Promise<boolean>;
  heartbeat: () => void;
  close: () => void;
};

export function createSessionHeartbeat(options: SessionHeartbeatOptions): {
  stop: () => void;
  runNow: () => Promise<void>;
} {
  let stopped = false;
  let checking = false;
  let timer: NodeJS.Timeout | null = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
  const runNow = async (): Promise<void> => {
    if (stopped || checking) return;
    checking = true;
    try {
      if (!await options.validate()) {
        stop();
        options.close();
        return;
      }
      if (!stopped) options.heartbeat();
    } catch {
      // A stream whose session cannot be verified must fail closed. EventSource
      // can reconnect and pass through the ordinary authentication guard once
      // the database is healthy again.
      stop();
      options.close();
    } finally {
      checking = false;
    }
  };

  timer = setInterval(() => { void runNow(); }, options.intervalMs);
  timer.unref();
  return { stop, runNow };
}

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/events", { preHandler: [app.authenticate] }, async (request, reply) => {
    const auth = request.auth!;
    const rawLastId = request.headers["last-event-id"];
    const lastIdValue = Array.isArray(rawLastId) ? rawLastId[0] : rawLastId;
    const lastId = lastIdValue && /^\d+$/.test(lastIdValue) ? Number(lastIdValue) : 0;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ connected: true })}\n\n`);

    if (lastId > 0) {
      const missed = await app.events.replay(auth.user.id, lastId);
      for (const event of missed) reply.raw.write(eventFrame(event));
    }

    const unsubscribe = app.events.subscribe(auth.user.id, (event) => {
      if (!reply.raw.destroyed) reply.raw.write(eventFrame(event));
    });
    let cleaned = false;
    let heartbeat: ReturnType<typeof createSessionHeartbeat> | null = null;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      heartbeat?.stop();
      unsubscribe();
    };
    heartbeat = createSessionHeartbeat({
      intervalMs: app.config.sseHeartbeatMs,
      validate: () => app.isSessionActive(auth.sessionId, auth.user.id),
      heartbeat: () => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
        }
      },
      close: () => {
        cleanup();
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      },
    });
    request.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
  });
}
