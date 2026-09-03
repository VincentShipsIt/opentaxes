#!/usr/bin/env node
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { parseEnv } from "../core/env.ts";
import { summary } from "../core/reconcile.ts";
import { GOOGLE_TOKEN_FILENAME } from "../core/registry.ts";
import type { RunDeps } from "../core/run.ts";
import { extractMonth, fetchMonth, publishMonth, reconcileMonth, runMonth } from "../core/run.ts";
import type { Month } from "../core/types.ts";
import { startMcpServer } from "../mcp/server.ts";
import { createGoogleAuth } from "../sources/google-auth.ts";
import { DEFAULT_ENV_EXAMPLE, ensureInit } from "./config-file.ts";
import {
	type DepsOptions,
	loadRunDeps,
	resolveConfigPath,
	resolveMonth,
	resolveStateDir,
} from "./deps.ts";
import {
	formatMissing,
	formatMissingJson,
	formatPublishJson,
	formatPublishTable,
	formatSummaryJson,
	formatSummaryTable,
} from "./format.ts";

interface CliOptions {
	readonly month?: string;
	readonly state?: string;
	readonly config?: string;
	readonly json?: boolean;
}

function log(message: string): void {
	process.stderr.write(`${message}\n`);
}

function toDepsOptions(options: CliOptions): DepsOptions {
	return {
		...(options.config !== undefined ? { configPath: options.config } : {}),
		...(options.state !== undefined ? { stateDir: options.state } : {}),
	};
}

function addCommonOptions(command: Command): Command {
	return command
		.option("--month <yyyy-mm>", "month to operate on, defaults to last month")
		.option("--state <dir>", "state directory, defaults to .opentaxes")
		.option("--config <path>", "config file path, defaults to opentaxes.config.json")
		.option("--json", "print machine-readable JSON instead of a table");
}

/** Wraps an action so any thrown error prints a one-line message to stderr and exits 1. */
function withErrorHandling(
	action: (options: CliOptions) => Promise<void>
): (options: CliOptions) => Promise<void> {
	return async (options: CliOptions) => {
		try {
			await action(options);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Error: ${message}\n`);
			if (process.env.OPENTAXES_DEBUG === "1" && error instanceof Error && error.stack) {
				process.stderr.write(`${error.stack}\n`);
			}
			process.exitCode = 1;
		}
	};
}

async function runSummaryVerb<T>(
	options: CliOptions,
	action: (month: Month, deps: RunDeps) => Promise<T>,
	format: { readonly table: (value: T) => string; readonly json: (value: T) => string }
): Promise<void> {
	const month = resolveMonth(options.month);
	const { deps } = await loadRunDeps(toDepsOptions(options), month, log);
	const result = await action(month, deps);
	process.stdout.write(options.json ? format.json(result) : format.table(result));
}

async function doFetch(options: CliOptions): Promise<void> {
	await runSummaryVerb(options, fetchMonth, { table: formatSummaryTable, json: formatSummaryJson });
}

async function doExtract(options: CliOptions): Promise<void> {
	await runSummaryVerb(options, extractMonth, {
		table: formatSummaryTable,
		json: formatSummaryJson,
	});
}

async function doReconcile(options: CliOptions): Promise<void> {
	await runSummaryVerb(options, reconcileMonth, {
		table: formatSummaryTable,
		json: formatSummaryJson,
	});
}

async function doPublish(options: CliOptions): Promise<void> {
	await runSummaryVerb(options, publishMonth, {
		table: formatPublishTable,
		json: formatPublishJson,
	});
}

async function doRun(options: CliOptions): Promise<void> {
	await runSummaryVerb(options, runMonth, { table: formatSummaryTable, json: formatSummaryJson });
}

async function doMissing(options: CliOptions): Promise<void> {
	const month = resolveMonth(options.month);
	const { deps } = await loadRunDeps(toDepsOptions(options), month, log);
	const ledger = await deps.store.load(month);
	process.stdout.write(options.json ? formatMissingJson(ledger) : formatMissing(ledger));
	if (
		!options.json &&
		deps.config.sources.folder &&
		summary(ledger).unmatchedTransactions.length > 0
	) {
		const dropDir = join(deps.config.sources.folder.dir, month);
		process.stdout.write(
			`\nGot a receipt for one of these? Drop it into ${dropDir}/ ` +
				`and run "opentaxes fetch" then "opentaxes extract".\n`
		);
	}
}

async function doInit(options: CliOptions): Promise<void> {
	const configPath = resolveConfigPath(options.config);
	await ensureInit(configPath, ".env.example", log);
	process.stdout.write(
		`Ready. Fill in .env from .env.example, then run "opentaxes auth google" if you use ` +
			`Gmail, Drive, or Sheets, and "opentaxes run" to fetch and publish a month.\n`
	);
}

async function doAuthGoogle(options: CliOptions): Promise<void> {
	const env = parseEnv(process.env);
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		throw new Error(
			'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env before running "opentaxes auth google"'
		);
	}
	const stateDir = resolveStateDir(options.state);
	const auth = createGoogleAuth({
		clientId: env.GOOGLE_CLIENT_ID,
		clientSecret: env.GOOGLE_CLIENT_SECRET,
		tokenPath: join(stateDir, GOOGLE_TOKEN_FILENAME),
		log,
	});
	await auth.authorizeInteractive();
	process.stdout.write("Google authorization complete.\n");
}

async function doMcp(options: CliOptions): Promise<void> {
	await startMcpServer(toDepsOptions(options));
}

function buildProgram(): Command {
	const program = new Command();
	program
		.name("opentaxes")
		.description(
			"Agent-first bookkeeping collector: pull transactions and documents, reconcile them, and publish a clean monthly folder."
		)
		.version("0.1.0");

	addCommonOptions(
		program.command("fetch").description("pull transactions and documents for a month")
	).action(withErrorHandling(doFetch));
	addCommonOptions(
		program.command("extract").description("extract every document that has no extraction yet")
	).action(withErrorHandling(doExtract));
	addCommonOptions(
		program.command("reconcile").description("recompute matches between transactions and documents")
	).action(withErrorHandling(doReconcile));
	addCommonOptions(
		program.command("publish").description("publish the month's ledger to every configured sink")
	).action(withErrorHandling(doPublish));
	addCommonOptions(
		program.command("run").description("fetch, extract, reconcile, and publish, in sequence")
	).action(withErrorHandling(doRun));
	addCommonOptions(
		program
			.command("missing")
			.description("list unmatched transactions and orphan documents to chase")
	).action(withErrorHandling(doMissing));

	program
		.command("init")
		.description("write opentaxes.config.json and .env.example if they don't exist yet")
		.option("--config <path>", "config file path, defaults to opentaxes.config.json")
		.action(withErrorHandling(doInit));

	const auth = program.command("auth").description("authorization commands");
	auth
		.command("google")
		.description("run the interactive Google OAuth flow for Gmail, Drive, and Sheets")
		.option("--state <dir>", "state directory, defaults to .opentaxes")
		.action(withErrorHandling(doAuthGoogle));

	program
		.command("mcp")
		.description("start the MCP server over stdio")
		.option("--state <dir>", "state directory, defaults to .opentaxes")
		.option("--config <path>", "config file path, defaults to opentaxes.config.json")
		.action(withErrorHandling(doMcp));

	return program;
}

// Referenced only so DEFAULT_ENV_EXAMPLE stays part of this module's public surface for tests
// that assert `opentaxes init`'s output shape without re-deriving it.
export { buildProgram, DEFAULT_ENV_EXAMPLE };

// Node's stable way to ask "was this module run directly?" (import.meta.main is Bun-only and
// still experimental on Node 22) — compare the resolved module path against argv[1].
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	await buildProgram().parseAsync(process.argv);
}
