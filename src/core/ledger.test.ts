import { describe, expect, test } from "bun:test";
import { parseIsoDate, parseMonth } from "./dates.ts";
import {
	addDocument,
	addManualMatch,
	emptyLedger,
	setDecision,
	setExtraction,
	sideOf,
	upsertTransactions,
} from "./ledger.ts";
import { currency, money } from "./money.ts";
import type {
	Document,
	DocumentId,
	Extraction,
	Match,
	Transaction,
	TransactionId,
} from "./types.ts";

const MONTH = parseMonth("2026-08");
const USD = currency("USD");

function transaction(overrides: Partial<Transaction> = {}): Transaction {
	return {
		id: "wise:1" as TransactionId,
		source: "wise",
		bookedAt: parseIsoDate("2026-08-05"),
		direction: "out",
		amount: money(1000, USD),
		counterparty: "Acme",
		reference: "",
		...overrides,
	};
}

function document(overrides: Partial<Document> = {}): Document {
	return {
		id: "aa".repeat(32) as DocumentId,
		origin: { kind: "file", path: "/tmp/a.pdf" },
		filename: "a.pdf",
		mime: "application/pdf",
		fetchedAt: parseIsoDate("2026-08-05"),
		...overrides,
	};
}

function extraction(overrides: Partial<Extraction> = {}): Extraction {
	return {
		kind: "invoice",
		side: "expense",
		party: "Acme",
		issuedAt: parseIsoDate("2026-08-04"),
		total: money(1000, USD),
		tax: null,
		number: null,
		category: null,
		confidence: 0.9,
		by: "claude",
		...overrides,
	};
}

describe("sideOf", () => {
	test("maps out to expense and in to revenue", () => {
		expect(sideOf("out")).toBe("expense");
		expect(sideOf("in")).toBe("revenue");
	});
});

describe("upsertTransactions", () => {
	test("adds new transactions without mutating the source ledger", () => {
		const ledger = emptyLedger(MONTH);
		const next = upsertTransactions(ledger, [transaction()]);
		expect(ledger.transactions).toEqual({});
		expect(Object.keys(next.transactions)).toEqual(["wise:1"]);
	});

	test("upserts by id instead of duplicating", () => {
		const ledger = upsertTransactions(emptyLedger(MONTH), [transaction()]);
		const updated = upsertTransactions(ledger, [transaction({ reference: "changed" })]);
		expect(Object.keys(updated.transactions)).toEqual(["wise:1"]);
		expect(updated.transactions["wise:1" as TransactionId]?.reference).toBe("changed");
	});
});

describe("addDocument", () => {
	test("adds a document without an extraction", () => {
		const ledger = addDocument(emptyLedger(MONTH), document());
		expect(Object.keys(ledger.documents)).toHaveLength(1);
		expect(ledger.extractions).toEqual({});
	});

	test("keeps a source-provided extraction", () => {
		const doc = document();
		const ledger = addDocument(emptyLedger(MONTH), doc, extraction());
		expect(ledger.extractions[doc.id]).toEqual(extraction());
	});
});

describe("setExtraction", () => {
	test("records the extraction for that document only", () => {
		const doc = document();
		const other = document({ id: "bb".repeat(32) as DocumentId });
		let ledger = addDocument(emptyLedger(MONTH), doc);
		ledger = addDocument(ledger, other);
		ledger = setExtraction(ledger, doc.id, extraction());
		expect(ledger.extractions[doc.id]).toEqual(extraction());
		expect(ledger.extractions[other.id]).toBeUndefined();
	});
});

describe("setDecision", () => {
	test("records a decision keyed by the given id", () => {
		const tx = transaction();
		const ledger = setDecision(emptyLedger(MONTH), tx.id, { kind: "personal" });
		expect(ledger.decisions[tx.id]).toEqual({ kind: "personal" });
	});
});

describe("addManualMatch", () => {
	test("replaces an automatic match touching either endpoint", () => {
		const txA = transaction({ id: "wise:a" as TransactionId });
		const txB = transaction({ id: "wise:b" as TransactionId });
		const docA = document({ id: "aa".repeat(32) as DocumentId });
		const docB = document({ id: "bb".repeat(32) as DocumentId });

		const automatic: Match = {
			transactionId: txA.id,
			documentId: docA.id,
			rule: "amount-date",
			score: 0.7,
		};
		let ledger = emptyLedger(MONTH);
		ledger = { ...ledger, matches: [automatic] };

		ledger = addManualMatch(ledger, txA.id, docB.id);

		expect(ledger.matches).toEqual([
			{ transactionId: txA.id, documentId: docB.id, rule: "manual", score: 1 },
		]);

		ledger = addManualMatch(ledger, txB.id, docB.id);
		expect(ledger.matches).toEqual([
			{ transactionId: txB.id, documentId: docB.id, rule: "manual", score: 1 },
		]);
	});
});
