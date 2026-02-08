#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { createProxyServer } from "./proxy.js";

const config = loadConfig(process.argv.slice(2));
const server = createProxyServer(config);

server.listen(config.port, () => {
  console.log(`
╔══════════════════════════════════════════╗
║           HydraProxy v0.1.0              ║
╠══════════════════════════════════════════╣
║  Port:        ${String(config.port).padEnd(27)}║
║  Target:      ${config.targetModel.padEnd(27)}║
║  Spoofing as: ${config.spoofModel.padEnd(27)}║
║  Passthrough: ${(config.passthroughModels.length ? config.passthroughModels.join(", ") : "none").padEnd(27)}║
╚══════════════════════════════════════════╝

Ready. Set ANTHROPIC_BASE_URL=http://localhost:${config.port} on teammate processes.
`);
});

server.on("error", (err: Error) => {
  console.error("Server error:", err.message);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\nShutting down HydraProxy...");
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
