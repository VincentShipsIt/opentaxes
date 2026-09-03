import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIsoDate, parseMonth } from "./dates.ts";
import { addDocument, emptyLedger, upsertTransactions } from "./ledger.ts";
import { currency, money } from "./money.ts";
import { LedgerStore } from "./store.ts";
import type { Document, DocumentId, Transaction, TransactionId } from "./types.ts";

const MONTH = parseMonth("2026-08");
const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "opentaxes-store-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const transaction: Transaction = {
	id: "wise:tx-1" as TransactionId,
	source: "wise",
	bookedAt: parseIsoDate("2026-08-05"),
	direction: "out",
	amount: money(10324, currency("USD")),
	original: money(8888, currency("EUR")),
	counterparty: "Acme Supplies",
	reference: "INV-9",
};

describe("LedgerStore", () => {
	test("load returns an empty ledger when nothing was saved", async () => {
		const store = new LedgerStore(await tempDir());
		const ledger = await store.load(MONTH);
		expect(ledger).toEqual(emptyLedger(MONTH));
	});

	test("save then load round-trips the ledger, including a transaction's original amount", async () => {
		const store = new LedgerStore(await tempDir());
		const ledger = upsertTransactions(emptyLedger(MONTH), [transaction]);
		await store.save(ledger);
		const loaded = await store.load(MONTH);
		expect(loaded).toEqual(ledger);
		expect(loaded.transactions[transaction.id]?.original).toEqual(transaction.original);
	});

	test("load fails loudly on a corrupt ledger file", async () => {
		const dir = await tempDir();
		await mkdir(join(dir, MONTH), { recursive: true });
		await writeFile(
			join(dir, MONTH, "ledger.json"),
			JSON.stringify({ month: "2026-08", transactions: { bad: {} } })
		);
		const store = new LedgerStore(dir);
		await expect(store.load(MONTH)).rejects.toThrow();
	});

	test("putDocument is content-addressed and idempotent", async () => {
		const store = new LedgerStore(await tempDir());
		const bytes = new TextEncoder().encode("invoice bytes");
		const first = await store.putDocument(MONTH, bytes, "invoice.pdf", "application/pdf");
		const second = await store.putDocument(MONTH, bytes, "invoice-renamed.pdf", "application/pdf");

		expect(second.id).toBe(first.id);
		expect(second.path).toBe(first.path);
		expect(first.id as string).toBe(createHash("sha256").update(bytes).digest("hex"));
	});

	test("putDocument distinguishes different content", async () => {
		const store = new LedgerStore(await tempDir());
		const a = await store.putDocument(
			MONTH,
			new TextEncoder().encode("a"),
			"a.pdf",
			"application/pdf"
		);
		const b = await store.putDocument(
			MONTH,
			new TextEncoder().encode("b"),
			"b.pdf",
			"application/pdf"
		);
		expect(a.id).not.toBe(b.id);
	});

	test("readDocument returns exactly the stored bytes", async () => {
		const store = new LedgerStore(await tempDir());
		const bytes = new TextEncoder().encode("hello world");
		const { id } = await store.putDocument(MONTH, bytes, "note.txt", "text/plain");
		const read = await store.readDocument(MONTH, id);
		expect(Buffer.from(read).equals(Buffer.from(bytes))).toBe(true);
	});

	test("documentPath resolves the extension from the stored file", async () => {
		const store = new LedgerStore(await tempDir());
		const bytes = new TextEncoder().encode("csv,data");
		const { id, path } = await store.putDocument(MONTH, bytes, "statement.csv", "text/csv");
		expect(await store.documentPath(MONTH, id)).toBe(path);
		expect(path.endsWith(".csv")).toBe(true);
	});

	test("documentPath throws for an unknown id", async () => {
		const store = new LedgerStore(await tempDir());
		await expect(store.documentPath(MONTH, "deadbeef" as DocumentId)).rejects.toThrow();
	});

	test("save is idempotent: saving twice keeps the ledger stable", async () => {
		const store = new LedgerStore(await tempDir());
		let ledger = upsertTransactions(emptyLedger(MONTH), [transaction]);
		const document: Document = {
			id: "aa".repeat(32) as DocumentId,
			origin: { kind: "file", path: "/tmp/a.pdf" },
			filename: "a.pdf",
			mime: "application/pdf",
			fetchedAt: parseIsoDate("2026-08-05"),
		};
		ledger = addDocument(ledger, document);
		await store.save(ledger);
		await store.save(ledger);
		const loaded = await store.load(MONTH);
		expect(loaded).toEqual(ledger);
	});
});
