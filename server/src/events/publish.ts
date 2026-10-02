import type { FastifyInstance } from "fastify";

/**
 * Persisted application state is canonical; realtime events are only refresh
 * hints. A failed event insert must therefore never turn an already-committed
 * mutation into an apparent failed request (and trigger unsafe retries).
 */
export async function publishBestEffort(
  app: FastifyInstance,
  userId: string,
  eventType: string,
  payload: unknown,
): Promise<void> {
  try {
    await app.events.publish(userId, eventType, payload);
  } catch (error) {
    app.log.warn(
      {
        eventType,
        errorName: error instanceof Error ? error.name : "UnknownError",
      },
      "Realtime event publication failed after canonical write",
    );
  }
}
