#!/usr/bin/env node
import { resolveConfigPath, resolveStateDir } from "../cli/deps.ts";
import { startMcpServer } from "./server.ts";

/**
 * Standalone stdio entrypoint, for running the MCP server without the `opentaxes` CLI wrapper
 * (e.g. `node dist/mcp/index.js`). `opentaxes mcp` calls `startMcpServer` directly instead, using
 * its own `--config`/`--state` flags; this file exists so the built `dist/mcp/index.js` from
 * package.json's build script is a working entrypoint on its own.
 */
await startMcpServer({
	configPath: resolveConfigPath(process.env.OPENTAXES_CONFIG),
	stateDir: resolveStateDir(process.env.OPENTAXES_STATE_DIR),
});
