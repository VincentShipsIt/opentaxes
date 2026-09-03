import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { parseIsoDate } from "../core/dates.ts";
import type { PublishInput } from "../core/registry.ts";
import type { Document } from "../core/types.ts";
import { createFolderSink } from "./folder.ts";
import { doc, extraction, ledgerFixture, match, txn } from "./test-fixtures.ts";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(nodePath.join(tmpdir(), "opentaxes-folder-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function buildInput(bytesByDocId: Readonly<Record<string, Uint8Array>>): PublishInput {
	const invoice = doc({ id: "d1", filename: "invoice.pdf" });
	const statement = doc({
		id: "d2",
		filename: "statement.csv",
		origin: { kind: "statement", source: "wise", account: "multi" },
		fetchedAt: parseIsoDate("2026-01-02"),
	});
	const t = txn({ id: "wise:1" });
	const ledger = ledgerFixture({
		transactions: [t],
		documents: [invoice, statement],
		extractions: { d1: extraction({ party: "Acme Supplies", category: "software" }) },
		matches: [match({ transactionId: "wise:1", documentId: "d1" })],
	});
	return {
		ledger,
		filenames: { d1: "invoice.pdf", d2: "statement.csv" },
		readDocument: async (document: Document) => {
			const bytes = bytesByDocId[document.id];
			if (!bytes) throw new Error(`no fixture bytes for document "${document.id}"`);
			return bytes;
		},
	};
}

describe("createFolderSink", () => {
	it("writes each document under <YYYY>/<MM>/<folder>/<filename> plus csv and json", async () => {
		await withTempDir(async (dir) => {
			const input = buildInput({
				d1: new TextEncoder().encode("invoice-bytes"),
				d2: new TextEncoder().encode("statement-bytes"),
			});
			const sink = createFolderSink({ path: dir });

			const result = await sink.publish(input);

			expect(result).toEqual({ sink: "folder", created: 4, unchanged: 0 });
			const monthDir = nodePath.join(dir, "2026", "01");
			expect(await readFile(nodePath.join(monthDir, "expenses", "invoice.pdf"), "utf8")).toBe(
				"invoice-bytes"
			);
			expect(await readFile(nodePath.join(monthDir, "bank", "statement.csv"), "utf8")).toBe(
				"statement-bytes"
			);
			const csv = await readFile(nodePath.join(monthDir, "reconciliation.csv"), "utf8");
			expect(csv).toContain("invoice.pdf");
			const ledgerJson = await readFile(nodePath.join(monthDir, "ledger.json"), "utf8");
			expect(JSON.parse(ledgerJson).month).toBe("2026-01");
		});
	});

	it("is idempotent: a second identical publish creates nothing", async () => {
		await withTempDir(async (dir) => {
			const input = buildInput({
				d1: new TextEncoder().encode("invoice-bytes"),
				d2: new TextEncoder().encode("statement-bytes"),
			});
			const sink = createFolderSink({ path: dir });

			await sink.publish(input);
			const second = await sink.publish(input);

			expect(second).toEqual({ sink: "folder", created: 0, unchanged: 4 });
		});
	});

	it("rewrites a document whose bytes changed length, but leaves an identical one alone", async () => {
		await withTempDir(async (dir) => {
			const sink = createFolderSink({ path: dir });
			const first = buildInput({
				d1: new TextEncoder().encode("invoice-bytes"),
				d2: new TextEncoder().encode("statement-bytes"),
			});
			await sink.publish(first);

			const second = buildInput({
				d1: new TextEncoder().encode("invoice-bytes-but-longer"),
				d2: new TextEncoder().encode("statement-bytes"),
			});
			const result = await sink.publish(second);

			// d1 rewritten (created), d2 unchanged, csv/json content identical to the first run -> unchanged
			expect(result).toEqual({ sink: "folder", created: 1, unchanged: 3 });
			const monthDir = nodePath.join(dir, "2026", "01");
			expect(await readFile(nodePath.join(monthDir, "expenses", "invoice.pdf"), "utf8")).toBe(
				"invoice-bytes-but-longer"
			);
		});
	});
});
