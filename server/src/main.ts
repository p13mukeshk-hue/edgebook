import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp(config);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "Graceful shutdown requested");
  const forceExit = setTimeout(() => {
    app.log.error("Graceful shutdown timed out");
    process.exit(1);
  }, 15_000);
  forceExit.unref();
  await app.close();
  clearTimeout(forceExit);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ error }, "Failed to start Edgebook server");
  await app.close().catch(() => undefined);
  process.exitCode = 1;
}
