import { CONFIG_FILENAME } from "../core/config.ts";
import { parseMonth, previousMonth } from "../core/dates.ts";
import { parseEnv } from "../core/env.ts";
import { createRegistry, DEFAULT_STATE_DIR } from "../core/registry.ts";
import type { RunDeps } from "../core/run.ts";
import { LedgerStore } from "../core/store.ts";
import type { Month } from "../core/types.ts";
import { loadConfigFile } from "./config-file.ts";

export interface DepsOptions {
	readonly configPath?: string;
	readonly stateDir?: string;
}

/** Parses `--month`, defaulting to last month. Pure: no filesystem or environment access. */
export function resolveMonth(option: string | undefined, now: Date = new Date()): Month {
	return option === undefined ? previousMonth(now) : parseMonth(option);
}

export function resolveStateDir(option: string | undefined): string {
	return option ?? DEFAULT_STATE_DIR;
}

export function resolveConfigPath(option: string | undefined): string {
	return option ?? CONFIG_FILENAME;
}

/**
 * Builds a fresh `RunDeps` for one command or one MCP tool call. Not cached: rebuilding every
 * call means an edit to the config file or .env takes effect on the very next fetch/extract/etc,
 * with no server restart needed for MCP.
 */
export async function loadRunDeps(
	options: DepsOptions,
	month: Month,
	log: (message: string) => void
): Promise<{ readonly deps: RunDeps; readonly stateDir: string }> {
	const stateDir = resolveStateDir(options.stateDir);
	// createRegistry and LedgerStore must agree on where the Google token and ledgers live;
	// OPENTAXES_STATE_DIR is how they do, since createRegistry only takes (config, env, month, log).
	process.env.OPENTAXES_STATE_DIR = stateDir;
	const configPath = resolveConfigPath(options.configPath);
	const config = await loadConfigFile(configPath);
	const env = parseEnv(process.env);
	const registry = createRegistry(config, env, month, log);
	const store = new LedgerStore(stateDir);
	return { deps: { registry, store, config }, stateDir };
}
