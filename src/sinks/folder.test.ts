import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
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

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

interface BuildInputOptions {
	readonly invoiceBytes: Uint8Array;
	readonly statementBytes: Uint8Array;
}

/**
 * Document ids are content-addressed: they always equal the sha256 of the bytes supplied. The
 * bank statement document is never matched to a transaction (statements are never invoices), so
 * every ledger built here always has at least one orphan document.
 */
function buildInput(options: BuildInputOptions): PublishInput {
	const invoiceId = sha256Hex(options.invoiceBytes);
	const statementId = sha256Hex(options.statementBytes);
	const invoice = doc({ id: invoiceId, filename: "invoice.pdf" });
	const statement = doc({
		id: statementId,
		filename: "statement.csv",
		origin: { kind: "statement", source: "wise", account: "multi" },
		fetchedAt: parseIsoDate("2026-01-02"),
	});
	const t = txn({ id: "wise:1" });
	const ledger = ledgerFixture({
		transactions: [t],
		documents: [invoice, statement],
		extractions: { [invoiceId]: extraction({ party: "Acme Supplies", category: "software" }) },
		matches: [match({ transactionId: "wise:1", documentId: invoiceId })],
	});
	const bytesById: Readonly<Record<string, Uint8Array>> = {
		[invoiceId]: options.invoiceBytes,
		[statementId]: options.statementBytes,
	};
	return {
		ledger,
		filenames: { [invoiceId]: "invoice.pdf", [statementId]: "statement.csv" },
		readDocument: async (document: Document) => {
			const bytes = bytesById[document.id];
			if (!bytes) throw new Error(`no fixture bytes for document "${document.id}"`);
			return bytes;
		},
	};
}

describe("createFolderSink", () => {
	it("writes each document under <YYYY>/<MM>/<folder>/<filename> plus csv, unmatched csv, and json", async () => {
		await withTempDir(async (dir) => {
			const input = buildInput({
				invoiceBytes: new TextEncoder().encode("invoice-bytes"),
				statementBytes: new TextEncoder().encode("statement-bytes"),
			});
			const sink = createFolderSink({ path: dir });

			const result = await sink.publish(input);

			// invoice, statement, reconciliation.csv, unmatched-documents.csv (the statement is
			// never matched), ledger.json
			expect(result).toEqual({ sink: "folder", created: 5, unchanged: 0 });
			const monthDir = nodePath.join(dir, "2026", "01");
			expect(await readFile(nodePath.join(monthDir, "expenses", "invoice.pdf"), "utf8")).toBe(
				"invoice-bytes"
			);
			expect(await readFile(nodePath.join(monthDir, "bank", "statement.csv"), "utf8")).toBe(
				"statement-bytes"
			);
			const csv = await readFile(nodePath.join(monthDir, "reconciliation.csv"), "utf8");
			expect(csv).toContain("invoice.pdf");
			const unmatched = await readFile(nodePath.join(monthDir, "unmatched-documents.csv"), "utf8");
			expect(unmatched).toBe("filename,party,issued_at\nstatement.csv,,\n");
			const ledgerJson = await readFile(nodePath.join(monthDir, "ledger.json"), "utf8");
			expect(JSON.parse(ledgerJson).month).toBe("2026-01");
		});
	});

	it("is idempotent: a second identical publish creates nothing", async () => {
		await withTempDir(async (dir) => {
			const input = buildInput({
				invoiceBytes: new TextEncoder().encode("invoice-bytes"),
				statementBytes: new TextEncoder().encode("statement-bytes"),
			});
			const sink = createFolderSink({ path: dir });

			await sink.publish(input);
			const second = await sink.publish(input);

			expect(second).toEqual({ sink: "folder", created: 0, unchanged: 5 });
		});
	});

	it("rewrites a document whose bytes changed but stayed the same length, leaving an identical one alone", async () => {
		await withTempDir(async (dir) => {
			const sink = createFolderSink({ path: dir });
			const first = buildInput({
				invoiceBytes: new TextEncoder().encode("invoice-bytes-A"),
				statementBytes: new TextEncoder().encode("statement-bytes"),
			});
			await sink.publish(first);

			// same byte length as "invoice-bytes-A", different content and therefore a different
			// content-addressed id -- a size check alone would wrongly call this unchanged
			const second = buildInput({
				invoiceBytes: new TextEncoder().encode("invoice-bytes-B"),
				statementBytes: new TextEncoder().encode("statement-bytes"),
			});
			const result = await sink.publish(second);

			// invoice rewritten under a new content-addressed id, and ledger.json (which embeds
			// document ids) changes with it; the statement file, reconciliation.csv (filenames
			// only, no ids), and unmatched-documents.csv are all byte-identical to the first run
			expect(result).toEqual({ sink: "folder", created: 2, unchanged: 3 });
			const monthDir = nodePath.join(dir, "2026", "01");
			expect(await readFile(nodePath.join(monthDir, "expenses", "invoice.pdf"), "utf8")).toBe(
				"invoice-bytes-B"
			);
		});
	});

	it("writes unmatched-documents.csv only while at least one orphan document exists", async () => {
		await withTempDir(async (dir) => {
			const sink = createFolderSink({ path: dir });
			const monthDir = nodePath.join(dir, "2026", "01");

			const invoiceBytes = new TextEncoder().encode("invoice-bytes");
			const invoiceId = sha256Hex(invoiceBytes);
			const invoice = doc({ id: invoiceId, filename: "invoice.pdf" });
			const t = txn({ id: "wise:1" });
			const matchedInput: PublishInput = {
				ledger: ledgerFixture({
					transactions: [t],
					documents: [invoice],
					extractions: { [invoiceId]: extraction({ party: "Acme Supplies" }) },
					matches: [match({ transactionId: "wise:1", documentId: invoiceId })],
				}),
				filenames: { [invoiceId]: "invoice.pdf" },
				readDocument: async () => invoiceBytes,
			};
			await sink.publish(matchedInput);
			await expect(
				readFile(nodePath.join(monthDir, "unmatched-documents.csv"), "utf8")
			).rejects.toThrow();

			const orphanBytes = new TextEncoder().encode("orphan-bytes");
			const orphanId = sha256Hex(orphanBytes);
			const orphanDoc = doc({ id: orphanId, filename: "orphan.pdf" });
			const orphanInput: PublishInput = {
				ledger: ledgerFixture({
					transactions: [t],
					documents: [invoice, orphanDoc],
					extractions: {
						[invoiceId]: extraction({ party: "Acme Supplies" }),
						[orphanId]: extraction({ party: "Loose Vendor" }),
					},
					matches: [match({ transactionId: "wise:1", documentId: invoiceId })],
				}),
				filenames: { [invoiceId]: "invoice.pdf", [orphanId]: "orphan.pdf" },
				readDocument: async (document: Document) =>
					document.id === invoiceId ? invoiceBytes : orphanBytes,
			};
			await sink.publish(orphanInput);
			const unmatched = await readFile(nodePath.join(monthDir, "unmatched-documents.csv"), "utf8");
			expect(unmatched).toBe("filename,party,issued_at\norphan.pdf,Loose Vendor,2026-01-03\n");
		});
	});
});
