import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "./config.ts";
import { parseMonth } from "./dates.ts";
import { parseEnv } from "./env.ts";
import { createRegistry, resolveSheetName } from "./registry.ts";

/** Synthetic fixtures only — no real tokens, ids, or business names. */
const MONTH = parseMonth("2026-03");

function names(items: readonly { readonly name: string }[]): string[] {
	return items.map((item) => item.name);
}

describe("createRegistry", () => {
	it("builds no sources or sinks when config and env are both empty, but keeps the claude-cli extractor fallback", () => {
		const registry = createRegistry(parseConfig({}), parseEnv({}), MONTH);
		expect(registry.transactionSources).toEqual([]);
		expect(registry.documentSources).toEqual([]);
		expect(registry.extractor?.name).toBe("claude-cli");
		expect(registry.sinks).toEqual([]);
	});

	it("adds a Wise transaction and document source when WISE_API_TOKEN is set", () => {
		const registry = createRegistry(
			parseConfig({}),
			parseEnv({ WISE_API_TOKEN: "test-token" }),
			MONTH
		);
		expect(names(registry.transactionSources)).toEqual(["wise"]);
		expect(names(registry.documentSources)).toEqual(["wise"]);
	});

	it("adds a Wise CSV transaction source independently of the API source", () => {
		const registry = createRegistry(
			parseConfig({ sources: { wiseCsv: { dir: "/tmp/does-not-matter" } } }),
			parseEnv({}),
			MONTH
		);
		expect(names(registry.transactionSources)).toEqual(["wise"]);
		expect(registry.documentSources).toEqual([]);
	});

	it("keeps both Wise sources active when the API token and a CSV dir are both configured", () => {
		const registry = createRegistry(
			parseConfig({ sources: { wiseCsv: { dir: "/tmp/does-not-matter" } } }),
			parseEnv({ WISE_API_TOKEN: "test-token" }),
			MONTH
		);
		expect(names(registry.transactionSources)).toEqual(["wise", "wise"]);
	});

	it("adds a folder document source when sources.folder is configured", () => {
		const registry = createRegistry(
			parseConfig({ sources: { folder: { dir: "/tmp/does-not-matter" } } }),
			parseEnv({}),
			MONTH
		);
		expect(names(registry.documentSources)).toEqual(["folder"]);
	});

	it("adds a Stripe document source when STRIPE_SECRET_KEY is set", () => {
		const registry = createRegistry(
			parseConfig({}),
			parseEnv({ STRIPE_SECRET_KEY: "sk_test_fake" }),
			MONTH
		);
		expect(names(registry.documentSources)).toEqual(["stripe"]);
	});

	it("adds the Claude extractor when ANTHROPIC_API_KEY is set", () => {
		const registry = createRegistry(
			parseConfig({}),
			parseEnv({ ANTHROPIC_API_KEY: "sk-ant-fake" }),
			MONTH
		);
		expect(registry.extractor?.name).toBe("claude");
	});

	it("falls back to the claude-cli extractor when ANTHROPIC_API_KEY is unset", () => {
		const registry = createRegistry(parseConfig({}), parseEnv({}), MONTH);
		expect(registry.extractor?.name).toBe("claude-cli");
	});

	it("uses claude-cli even with a key present when extractor.kind is claude-cli", () => {
		const registry = createRegistry(
			parseConfig({ extractor: { kind: "claude-cli" } }),
			parseEnv({ ANTHROPIC_API_KEY: "sk-ant-fake" }),
			MONTH
		);
		expect(registry.extractor?.name).toBe("claude-cli");
	});

	it("throws a clear error when extractor.kind is claude-api but the key is missing", () => {
		expect(() =>
			createRegistry(parseConfig({ extractor: { kind: "claude-api" } }), parseEnv({}), MONTH)
		).toThrow(/ANTHROPIC_API_KEY/);
	});

	it("adds a folder sink when sinks.folder is configured", () => {
		const registry = createRegistry(
			parseConfig({ sinks: { folder: { path: "/tmp/out" } } }),
			parseEnv({}),
			MONTH
		);
		expect(names(registry.sinks)).toEqual(["folder"]);
	});

	it("does not add drive or sheets sinks when configured without Google auth vars", () => {
		const registry = createRegistry(
			parseConfig({
				sinks: {
					drive: { folderId: "folder-id" },
					sheets: { spreadsheetId: "sheet-id" },
				},
			}),
			parseEnv({}),
			MONTH
		);
		expect(registry.sinks).toEqual([]);
	});

	it("adds drive and sheets sinks once Google auth vars and their config are both present", () => {
		const registry = createRegistry(
			parseConfig({
				sinks: {
					drive: { folderId: "folder-id" },
					sheets: { spreadsheetId: "sheet-id" },
				},
			}),
			parseEnv({ GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret" }),
			MONTH
		);
		expect(names(registry.sinks).sort()).toEqual(["drive", "sheets"]);
	});

	it("does not add a Gmail source when Google auth vars are set but no token file exists", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "opentaxes-registry-test-"));
		try {
			const registry = createRegistry(
				parseConfig({}),
				parseEnv({
					GOOGLE_CLIENT_ID: "client-id",
					GOOGLE_CLIENT_SECRET: "client-secret",
					OPENTAXES_STATE_DIR: stateDir,
				}),
				MONTH
			);
			expect(registry.documentSources).toEqual([]);
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("adds a Gmail source when a token file exists at <stateDir>/google-token.json", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "opentaxes-registry-test-"));
		try {
			writeFileSync(join(stateDir, "google-token.json"), "{}");
			const registry = createRegistry(
				parseConfig({}),
				parseEnv({
					GOOGLE_CLIENT_ID: "client-id",
					GOOGLE_CLIENT_SECRET: "client-secret",
					OPENTAXES_STATE_DIR: stateDir,
				}),
				MONTH
			);
			expect(names(registry.documentSources)).toEqual(["gmail"]);
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("forwards a log callback into a source that accepts one", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "opentaxes-registry-test-"));
		const messages: string[] = [];
		try {
			writeFileSync(join(stateDir, "google-token.json"), "not valid json");
			const registry = createRegistry(
				parseConfig({}),
				parseEnv({
					GOOGLE_CLIENT_ID: "client-id",
					GOOGLE_CLIENT_SECRET: "client-secret",
					OPENTAXES_STATE_DIR: stateDir,
				}),
				MONTH,
				(message) => messages.push(message)
			);
			const gmail = registry.documentSources.find((source) => source.name === "gmail");
			expect(gmail).toBeDefined();
			// A broken token file must not throw out of fetchDocuments; it surfaces via `log` so
			// other sources in the same run.ts loop still get a chance to fetch.
			const documents = await gmail?.fetchDocuments(MONTH);
			expect(documents).toEqual([]);
			expect(messages.length).toBeGreaterThan(0);
			expect(messages[0]).toContain("gmail");
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});
});

describe("resolveSheetName", () => {
	it("keeps an explicit sheetName", () => {
		expect(resolveSheetName("Ledger", MONTH)).toBe("Ledger");
	});

	it("falls back to the month when sheetName is omitted", () => {
		expect(resolveSheetName(undefined, MONTH)).toBe(MONTH);
	});
});
