import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseMonth } from "../core/dates.ts";
import { addDocument } from "../core/ledger.ts";
import { LedgerStore } from "../core/store.ts";
import type { DocumentId, TransactionId } from "../core/types.ts";
import { doc, extraction, txn } from "../sinks/test-fixtures.ts";
import { createServer } from "./server.ts";

const MONTH = "2026-01";
const RESOLVED_MONTH = parseMonth(MONTH);

interface ToolTextResult {
	readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
	readonly isError?: boolean;
}

function textOf(result: ToolTextResult): string {
	const first = result.content[0];
	if (!first || first.text === undefined) throw new Error("expected a text content block");
	return first.text;
}

function jsonOf(result: ToolTextResult): { result?: unknown; warnings?: unknown; error?: string } {
	return JSON.parse(textOf(result));
}

describe("mcp server", () => {
	let stateDir: string;
	let configPath: string;
	let client: Client;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "opentaxes-mcp-"));
		configPath = join(stateDir, "opentaxes.config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				sources: {},
				sinks: {},
				matching: { dateWindowDays: 5, threshold: 0.6 },
				categories: {},
			}),
			"utf8"
		);

		const server = createServer({ configPath, stateDir });
		const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
		client = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	});

	afterEach(async () => {
		await client.close();
		await rm(stateDir, { recursive: true, force: true });
	});

	it("reports an empty summary for a month with no state yet", async () => {
		const result = jsonOf(
			(await client.callTool({ name: "summary", arguments: { month: MONTH } })) as ToolTextResult
		);
		expect(result.result).toMatchObject({
			month: MONTH,
			transactions: 0,
			documents: 0,
			matched: 0,
			unmatchedTransactions: [],
			orphanDocuments: [],
			unextractedDocuments: [],
		});
		expect(result.warnings).toEqual([]);
	});

	it("read_document returns the document's bytes as base64 with its mime type", async () => {
		const store = new LedgerStore(stateDir);
		const bytes = new TextEncoder().encode("a synthetic pdf body");
		const { id } = await store.putDocument(RESOLVED_MONTH, bytes, "invoice.pdf", "application/pdf");
		let ledger = await store.load(RESOLVED_MONTH);
		ledger = addDocument(ledger, doc({ id, mime: "application/pdf", filename: "invoice.pdf" }));
		await store.save(ledger);

		const result = jsonOf(
			(await client.callTool({
				name: "read_document",
				arguments: { month: MONTH, documentId: id },
			})) as ToolTextResult
		);
		expect(result.result).toMatchObject({ mime: "application/pdf" });
		const base64 = (result.result as { base64: string }).base64;
		expect(Buffer.from(base64, "base64")).toEqual(Buffer.from(bytes));
	});

	it("read_document reports a clear error for an unknown document id", async () => {
		const result = (await client.callTool({
			name: "read_document",
			arguments: { month: MONTH, documentId: "does-not-exist" },
		})) as ToolTextResult;
		expect(result.isError).toBe(true);
		expect(jsonOf(result).error).toContain("does-not-exist");
	});

	it("set_extraction records a well-formed extraction", async () => {
		const store = new LedgerStore(stateDir);
		let ledger = await store.load(RESOLVED_MONTH);
		ledger = addDocument(ledger, doc({ id: "d1" }));
		await store.save(ledger);

		const validExtraction = {
			kind: "invoice",
			side: "expense",
			party: "Acme Supplies",
			issuedAt: "2026-01-03",
			total: { minor: 10_000, currency: "USD" },
			tax: null,
			number: "INV-100",
			category: null,
			confidence: 0.9,
		};
		const result = jsonOf(
			(await client.callTool({
				name: "set_extraction",
				arguments: { month: MONTH, documentId: "d1", extraction: validExtraction },
			})) as ToolTextResult
		);
		expect(result.result).toMatchObject({ documentId: "d1" });

		const saved = await store.load(RESOLVED_MONTH);
		expect(saved.extractions["d1" as DocumentId]).toMatchObject({
			party: "Acme Supplies",
			by: "agent",
		});
	});

	it("set_extraction rejects an extraction missing required fields", async () => {
		const store = new LedgerStore(stateDir);
		let ledger = await store.load(RESOLVED_MONTH);
		ledger = addDocument(ledger, doc({ id: "d1" }));
		await store.save(ledger);

		const result = (await client.callTool({
			name: "set_extraction",
			arguments: { month: MONTH, documentId: "d1", extraction: { kind: "invoice" } },
		})) as ToolTextResult;
		expect(result.isError).toBe(true);

		const saved = await store.load(RESOLVED_MONTH);
		expect(saved.extractions["d1" as DocumentId]).toBeUndefined();
	});

	it("set_extraction rejects an unknown document id before touching the ledger", async () => {
		const result = (await client.callTool({
			name: "set_extraction",
			arguments: {
				month: MONTH,
				documentId: "missing",
				extraction: extraction(),
			},
		})) as ToolTextResult;
		expect(result.isError).toBe(true);
		expect(jsonOf(result).error).toContain("missing");
	});

	it("missing lists an unmatched transaction with no state written yet", async () => {
		const store = new LedgerStore(stateDir);
		let ledger = await store.load(RESOLVED_MONTH);
		ledger = {
			...ledger,
			transactions: { ...ledger.transactions, ["t1" as TransactionId]: txn({ id: "t1" }) },
		};
		await store.save(ledger);

		const result = jsonOf(
			(await client.callTool({ name: "missing", arguments: { month: MONTH } })) as ToolTextResult
		);
		const unmatched = (result.result as { unmatchedTransactions: readonly { id: string }[] })
			.unmatchedTransactions;
		expect(unmatched).toHaveLength(1);
		expect(unmatched[0]?.id).toBe("t1");
	});
});
