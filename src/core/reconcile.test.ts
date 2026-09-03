import { describe, expect, test } from "bun:test";
import type { Config } from "./config.ts";
import { parseIsoDate, parseMonth } from "./dates.ts";
import { emptyLedger, setDecision, upsertTransactions } from "./ledger.ts";
import { currency, money } from "./money.ts";
import { reconcile, summary } from "./reconcile.ts";
import type {
	Document,
	DocumentId,
	Extraction,
	Ledger,
	Match,
	Transaction,
	TransactionId,
} from "./types.ts";

const MONTH = parseMonth("2026-08");
const USD = currency("USD");
const EUR = currency("EUR");
const DEFAULT_MATCHING: Config["matching"] = { dateWindowDays: 5, threshold: 0.6 };

let txSeq = 0;
let docSeq = 0;

function transaction(overrides: Partial<Transaction> = {}): Transaction {
	txSeq += 1;
	return {
		id: `wise:${txSeq}` as TransactionId,
		source: "wise",
		bookedAt: parseIsoDate("2026-08-10"),
		direction: "out",
		amount: money(5000, USD),
		counterparty: "Widget Corp",
		reference: "",
		...overrides,
	};
}

function document(overrides: Partial<Document> = {}): Document {
	docSeq += 1;
	return {
		id: docSeq.toString().padStart(2, "0").repeat(32).slice(0, 64) as DocumentId,
		origin: { kind: "file", path: `/tmp/${docSeq}.pdf` },
		filename: `${docSeq}.pdf`,
		mime: "application/pdf",
		fetchedAt: parseIsoDate("2026-08-10"),
		...overrides,
	};
}

function extraction(overrides: Partial<Extraction> = {}): Extraction {
	return {
		kind: "invoice",
		side: "expense",
		party: "Widget Corp",
		issuedAt: parseIsoDate("2026-08-10"),
		total: money(5000, USD),
		tax: null,
		number: null,
		category: null,
		confidence: 0.9,
		by: "claude",
		...overrides,
	};
}

function ledgerWith(
	transactions: readonly Transaction[],
	documents: ReadonlyArray<readonly [Document, Extraction | undefined]>,
	matches: readonly Match[] = []
): Ledger {
	let ledger = upsertTransactions(emptyLedger(MONTH), transactions);
	for (const [document, ext] of documents) {
		ledger = {
			...ledger,
			documents: { ...ledger.documents, [document.id]: document },
			extractions: ext ? { ...ledger.extractions, [document.id]: ext } : ledger.extractions,
		};
	}
	return { ...ledger, matches };
}

describe("reconcile", () => {
	test("exact match on amount, currency and date", () => {
		const tx = transaction({ counterparty: "Unrelated Payee" });
		const doc = document();
		const ext = extraction({ party: "Some Other Name" });
		const ledger = ledgerWith([tx], [[doc, ext]]);

		const result = reconcile(ledger, DEFAULT_MATCHING);

		expect(result.matches).toEqual([
			{ transactionId: tx.id, documentId: doc.id, rule: "amount-date", score: 0.7 },
		]);
	});

	test("matches when the document total agrees only with the original billed amount", () => {
		const tx = transaction({
			counterparty: "Unrelated Payee",
			amount: money(10324, USD),
			original: money(8888, EUR),
		});
		const doc = document();
		const ext = extraction({ party: "Some Other Name", total: money(8888, EUR) });
		const ledger = ledgerWith([tx], [[doc, ext]]);

		const result = reconcile(ledger, DEFAULT_MATCHING);

		expect(result.matches).toEqual([
			{ transactionId: tx.id, documentId: doc.id, rule: "amount-date", score: 0.7 },
		]);
	});

	test("does not match outside the date window", () => {
		const tx = transaction({ bookedAt: parseIsoDate("2026-08-01"), counterparty: "Unrelated" });
		const doc = document();
		const ext = extraction({ issuedAt: parseIsoDate("2026-08-10"), party: "Some Other Name" });
		const ledger = ledgerWith([tx], [[doc, ext]]);

		const result = reconcile(ledger, DEFAULT_MATCHING);

		expect(result.matches).toEqual([]);
	});

	test("party token overlap wins a tie between two equally-priced documents", () => {
		const tx = transaction({ counterparty: "Widget Corp LLC" });
		const matchingDoc = document();
		const matchingExt = extraction({ party: "Widget Corp" });
		const otherDoc = document();
		const otherExt = extraction({ party: "Totally Different Vendor" });
		const ledger = ledgerWith(
			[tx],
			[
				[otherDoc, otherExt],
				[matchingDoc, matchingExt],
			]
		);

		const result = reconcile(ledger, DEFAULT_MATCHING);

		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({
			transactionId: tx.id,
			documentId: matchingDoc.id,
			rule: "amount-date-party",
		});
		expect(result.matches[0]?.score).toBeGreaterThan(0.7);
	});

	test("threshold cuts off a candidate that scores below it", () => {
		const tx = transaction({ counterparty: "Unrelated" });
		const doc = document();
		const ext = extraction({ party: "Some Other Name" });
		const ledger = ledgerWith([tx], [[doc, ext]]);

		const result = reconcile(ledger, { ...DEFAULT_MATCHING, threshold: 0.75 });

		expect(result.matches).toEqual([]);
	});

	test("a manual match beats a better-scoring automatic candidate", () => {
		const tx = transaction({ counterparty: "Widget Corp" });
		const manualDoc = document();
		const betterDoc = document();
		const betterExt = extraction({ party: "Widget Corp" });
		const manual: Match = {
			transactionId: tx.id,
			documentId: manualDoc.id,
			rule: "manual",
			score: 1,
		};
		const ledger = ledgerWith(
			[tx],
			[
				[manualDoc, undefined],
				[betterDoc, betterExt],
			],
			[manual]
		);

		const result = reconcile(ledger, DEFAULT_MATCHING);

		expect(result.matches).toEqual([manual]);
	});

	test("side mismatch never matches even with identical amount and date", () => {
		const tx = transaction({ direction: "out", counterparty: "Unrelated" });
		const doc = document();
		const ext = extraction({ side: "revenue", party: "Some Other Name" });
		const ledger = ledgerWith([tx], [[doc, ext]]);

		const result = reconcile(ledger, DEFAULT_MATCHING);

		expect(result.matches).toEqual([]);
	});

	test("a decided transaction cannot steal the document a real transaction needed", () => {
		const personalTx = transaction({ counterparty: "Unrelated" });
		const realTx = transaction({ counterparty: "Unrelated" });
		const doc = document();
		const ext = extraction({ party: "Some Other Name" });
		let ledger = ledgerWith([personalTx, realTx], [[doc, ext]]);
		ledger = setDecision(ledger, personalTx.id, { kind: "personal" });

		const result = reconcile(ledger, DEFAULT_MATCHING);

		expect(result.matches).toEqual([
			{ transactionId: realTx.id, documentId: doc.id, rule: "amount-date", score: 0.7 },
		]);
	});
});

describe("summary", () => {
	test("decisions hide leftovers from unmatched and orphan lists", () => {
		const decidedTx = transaction({ counterparty: "No document expected" });
		const decidedDoc = document();
		const decidedExt = extraction({ party: "Unrelated", total: money(9999, USD) });
		let ledger = ledgerWith([decidedTx], [[decidedDoc, decidedExt]]);
		ledger = setDecision(ledger, decidedTx.id, { kind: "personal" });
		ledger = setDecision(ledger, decidedDoc.id, { kind: "ignore", reason: "not ours" });

		const result = summary(reconcile(ledger, DEFAULT_MATCHING));

		expect(result.unmatchedTransactions).toEqual([]);
		expect(result.orphanDocuments).toEqual([]);
	});

	test("bank statements never count as orphan documents", () => {
		const statement = document({
			origin: { kind: "statement", source: "wise", account: "multi" },
		});
		const statementExt = extraction({ kind: "statement", party: "Some Bank" });
		const ledger = ledgerWith([], [[statement, statementExt]]);

		const result = summary(reconcile(ledger, DEFAULT_MATCHING));

		expect(result.orphanDocuments).toEqual([]);
		expect(result.unextractedDocuments).toEqual([]);
		expect(result.documents).toBe(1);
	});

	test("lists unextracted documents regardless of decisions", () => {
		const doc = document();
		const ledger = ledgerWith([], [[doc, undefined]]);

		const result = summary(ledger);

		expect(result.unextractedDocuments).toEqual([doc]);
	});
});
