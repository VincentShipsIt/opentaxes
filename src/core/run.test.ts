import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "./config.ts";
import { parseIsoDate, parseMonth } from "./dates.ts";
import { currency, money } from "./money.ts";
import { summary } from "./reconcile.ts";
import type {
	DocumentSource,
	Extractor,
	FetchedDocument,
	PublishInput,
	PublishResult,
	Registry,
	Sink,
	TransactionSource,
} from "./registry.ts";
import { extractMonth, fetchMonth, runMonth } from "./run.ts";
import { LedgerStore } from "./store.ts";
import type { Document, Extraction, Month, Transaction, TransactionId } from "./types.ts";

const MONTH = parseMonth("2026-08");
const USD = currency("USD");
const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "opentaxes-run-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeTransactionSource implements TransactionSource {
	readonly name = "fake-bank";
	constructor(private readonly transactions: readonly Transaction[]) {}
	async fetchTransactions(_month: Month): Promise<readonly Transaction[]> {
		return this.transactions;
	}
}

class FakeDocumentSource implements DocumentSource {
	readonly name = "fake-mail";
	constructor(private readonly documents: readonly FetchedDocument[]) {}
	async fetchDocuments(_month: Month): Promise<readonly FetchedDocument[]> {
		return this.documents;
	}
}

class FakeExtractor implements Extractor {
	readonly name = "fake-extractor";
	calls = 0;
	constructor(private readonly byFilename: ReadonlyMap<string, Extraction>) {}
	async extract(document: Document, _bytes: Uint8Array): Promise<Extraction> {
		this.calls += 1;
		const extraction = this.byFilename.get(document.filename);
		if (!extraction) throw new Error(`no fixture extraction for ${document.filename}`);
		return extraction;
	}
}

class FakeSink implements Sink {
	readonly name = "fake-sink";
	readonly calls: PublishInput[] = [];
	private readonly seen = new Set<string>();

	async publish(input: PublishInput): Promise<PublishResult> {
		this.calls.push(input);
		let created = 0;
		let unchanged = 0;
		for (const document of Object.values(input.ledger.documents)) {
			const name = input.filenames[document.id];
			if (name !== undefined && this.seen.has(name)) {
				unchanged += 1;
				continue;
			}
			if (name !== undefined) this.seen.add(name);
			created += 1;
		}
		return { sink: this.name, created, unchanged };
	}
}

function bytesFor(label: string): Uint8Array {
	return new TextEncoder().encode(`fixture body: ${label}`);
}

describe("runMonth end to end", () => {
	test("fetches, extracts, reconciles and publishes, then converges on a second run", async () => {
		const acmeTransaction: Transaction = {
			id: "fake-bank:1" as TransactionId,
			source: "fake-bank",
			bookedAt: parseIsoDate("2026-08-10"),
			direction: "out",
			amount: money(5000, USD),
			counterparty: "Acme Supplies",
			reference: "",
		};
		const betaTransaction: Transaction = {
			id: "fake-bank:2" as TransactionId,
			source: "fake-bank",
			bookedAt: parseIsoDate("2026-08-12"),
			direction: "out",
			amount: money(1200, USD),
			counterparty: "Beta LLC",
			reference: "",
		};

		const acmeDoc: FetchedDocument = {
			origin: { kind: "file", path: "/inbox/acme.pdf" },
			filename: "acme.pdf",
			mime: "application/pdf",
			bytes: bytesFor("acme"),
		};
		const betaDoc: FetchedDocument = {
			origin: { kind: "file", path: "/inbox/beta.pdf" },
			filename: "beta.pdf",
			mime: "application/pdf",
			bytes: bytesFor("beta"),
		};

		const acmeExtraction: Extraction = {
			kind: "invoice",
			side: "expense",
			party: "Acme Supplies",
			issuedAt: parseIsoDate("2026-08-10"),
			total: money(5000, USD),
			tax: null,
			number: "INV-1",
			category: null,
			confidence: 0.95,
			by: "claude",
		};
		const betaExtraction: Extraction = {
			kind: "receipt",
			side: "expense",
			party: "Beta LLC",
			issuedAt: parseIsoDate("2026-08-12"),
			total: money(1200, USD),
			tax: null,
			number: null,
			category: null,
			confidence: 0.9,
			by: "claude",
		};

		const extractor = new FakeExtractor(
			new Map([
				["acme.pdf", acmeExtraction],
				["beta.pdf", betaExtraction],
			])
		);
		const sink = new FakeSink();
		const config = parseConfig({ categories: { "acme-supplies": "software" } });
		const registry: Registry = {
			transactionSources: [new FakeTransactionSource([acmeTransaction, betaTransaction])],
			documentSources: [new FakeDocumentSource([acmeDoc, betaDoc])],
			extractor,
			sinks: [sink],
		};
		const store = new LedgerStore(await tempDir());
		const deps = { registry, store, config };

		const firstSummary = await runMonth(MONTH, deps);

		expect(firstSummary.transactions).toBe(2);
		expect(firstSummary.documents).toBe(2);
		expect(firstSummary.matched).toBe(2);
		expect(firstSummary.unmatchedTransactions).toEqual([]);
		expect(firstSummary.orphanDocuments).toEqual([]);
		expect(extractor.calls).toBe(2);
		expect(sink.calls).toHaveLength(1);
		expect(sink.calls[0]).toMatchObject({ created: 2, unchanged: 0 });

		const ledgerAfterFirst = await store.load(MONTH);
		const acmeExtracted = Object.values(ledgerAfterFirst.extractions).find(
			(extraction) => extraction.party === "Acme Supplies"
		);
		expect(acmeExtracted?.category).toBe("software");
		const betaExtracted = Object.values(ledgerAfterFirst.extractions).find(
			(extraction) => extraction.party === "Beta LLC"
		);
		expect(betaExtracted?.category).toBeNull();

		const secondSummary = await runMonth(MONTH, deps);
		const ledgerAfterSecond = await store.load(MONTH);

		expect(secondSummary).toEqual(firstSummary);
		expect(ledgerAfterSecond).toEqual(ledgerAfterFirst);
		expect(extractor.calls).toBe(2);
		expect(sink.calls).toHaveLength(2);
		expect(sink.calls[1]).toMatchObject({ created: 0, unchanged: 2 });
	});
});

describe("extractMonth", () => {
	test("throws naming the CLI and MCP path when work remains and no extractor is configured", async () => {
		const store = new LedgerStore(await tempDir());
		const registry: Registry = {
			transactionSources: [],
			documentSources: [
				new FakeDocumentSource([
					{
						origin: { kind: "file", path: "/inbox/unread.pdf" },
						filename: "unread.pdf",
						mime: "application/pdf",
						bytes: bytesFor("unread"),
					},
				]),
			],
			extractor: null,
			sinks: [],
		};
		const config = parseConfig({});
		const deps = { registry, store, config };

		const fetchResult = await fetchMonth(MONTH, deps);
		expect(fetchResult.documents).toBe(1);

		await expect(extractMonth(MONTH, deps)).rejects.toThrow(/opentaxes extract/);
		await expect(extractMonth(MONTH, deps)).rejects.toThrow(/set_extraction/);
	});

	test("is a no-op when there is nothing pending", async () => {
		const store = new LedgerStore(await tempDir());
		const registry: Registry = {
			transactionSources: [],
			documentSources: [],
			extractor: null,
			sinks: [],
		};
		const config = parseConfig({});
		const result = await extractMonth(MONTH, { registry, store, config });
		expect(result).toEqual(summary(await store.load(MONTH)));
	});
});
