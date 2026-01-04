import { logger } from "./logger.js";
import { initTelemetry, shutdownTelemetry } from "./telemetry.js";
import { BridgeServer } from "./server.js";

const DEFAULT_PORT = 8647;
const DEFAULT_COMMAND = "claude-code-acp";

async function main(): Promise<void> {
  const port = parseInt(process.env.OOK_PORT ?? String(DEFAULT_PORT), 10);
  const command = process.env.OOK_COMMAND ?? DEFAULT_COMMAND;
  const commandArgs = process.env.OOK_COMMAND_ARGS?.split(" ").filter(Boolean) ?? [];

  logger.info({ port, command, commandArgs }, "Starting Ook Bridge");

  // Initialize telemetry first
  initTelemetry();

  const server = new BridgeServer({
    port,
    command,
    commandArgs,
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal");
    await server.stop();
    await shutdownTelemetry();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    logger.fatal(err, "Uncaught exception");
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "Unhandled rejection");
    process.exit(1);
  });

  server.start();
}

main().catch((err) => {
  logger.fatal(err, "Failed to start");
  process.exit(1);
});
