import { describe, expect, it } from "bun:test";
import { parseIsoDate, parseMonth } from "../core/dates.ts";
import { currency, money } from "../core/money.ts";
import type { DocumentId } from "../core/types.ts";
import { documentFolder, monthPath, reconciliationCsv, unmatchedDocumentsCsv } from "./layout.ts";
import { doc, extraction, ledgerFixture, match, txn } from "./test-fixtures.ts";

describe("documentFolder", () => {
	it("routes statement origin documents to bank regardless of extraction", () => {
		const statement = doc({
			id: "d1",
			origin: { kind: "statement", source: "wise", account: "multi" },
		});
		const ledger = ledgerFixture({
			documents: [statement],
			extractions: { d1: extraction({ kind: "statement", side: "expense" }) },
		});
		expect(documentFolder(ledger, "d1" as DocumentId)).toBe("bank");
	});

	it("routes an expense extraction to expenses", () => {
		const invoice = doc({ id: "d1" });
		const ledger = ledgerFixture({
			documents: [invoice],
			extractions: { d1: extraction({ side: "expense" }) },
		});
		expect(documentFolder(ledger, "d1" as DocumentId)).toBe("expenses");
	});

	it("routes a revenue extraction to revenue", () => {
		const receipt = doc({ id: "d1" });
		const ledger = ledgerFixture({
			documents: [receipt],
			extractions: { d1: extraction({ side: "revenue", kind: "invoice" }) },
		});
		expect(documentFolder(ledger, "d1" as DocumentId)).toBe("revenue");
	});

	it("routes a document with no extraction to unsorted", () => {
		const unread = doc({ id: "d1" });
		const ledger = ledgerFixture({ documents: [unread] });
		expect(documentFolder(ledger, "d1" as DocumentId)).toBe("unsorted");
	});

	it("throws for a document id absent from the ledger", () => {
		const ledger = ledgerFixture();
		expect(() => documentFolder(ledger, "missing" as DocumentId)).toThrow(/unknown document/);
	});
});

describe("monthPath", () => {
	it("splits a Month into [year, month]", () => {
		expect(monthPath(parseMonth("2026-03"))).toEqual(["2026", "03"]);
	});
});

describe("reconciliationCsv", () => {
	it("emits a matched row with the document's filename, party, and category", () => {
		const t = txn({ id: "wise:1", bookedAt: parseIsoDate("2026-01-05"), direction: "out" });
		const d = doc({ id: "d1" });
		const ledger = ledgerFixture({
			transactions: [t],
			documents: [d],
			extractions: { d1: extraction({ party: "Acme Supplies", category: "software" }) },
			matches: [match({ transactionId: "wise:1", documentId: "d1" })],
		});
		const csv = reconciliationCsv(ledger, { d1: "2026-01-05_acme_100.00-USD_INV-100.pdf" });
		const [header, row] = csv.split("\n");
		expect(header).toBe(
			"date,bank,debit,credit,currency,original,original_currency,description,invoice,file,party,category"
		);
		expect(row).toBe(
			"2026-01-05,WISE,100.00,,USD,,,Acme Supplies,UPLOADED,2026-01-05_acme_100.00-USD_INV-100.pdf,Acme Supplies,software"
		);
	});

	it("puts a credit-direction amount in the credit column, not debit", () => {
		const t = txn({ id: "wise:2", direction: "in", amount: money(5_000, currency("USD")) });
		const ledger = ledgerFixture({ transactions: [t] });
		const csv = reconciliationCsv(ledger, {});
		const row = csv.split("\n")[1];
		expect(row).toBe("2026-01-05,WISE,,50.00,USD,,,Acme Supplies,MISSING,,,");
	});

	it("carries the original currency amount when the bank converted it", () => {
		const t = txn({
			id: "wise:3",
			amount: money(10_324, currency("USD")),
			original: money(8_888, currency("EUR")),
		});
		const ledger = ledgerFixture({ transactions: [t] });
		const csv = reconciliationCsv(ledger, {});
		const row = csv.split("\n")[1];
		expect(row).toBe("2026-01-05,WISE,103.24,,USD,88.88,EUR,Acme Supplies,MISSING,,,");
	});

	it("falls back to the reference when there is no counterparty", () => {
		const t = txn({ id: "wise:4", counterparty: "", reference: "payout ref" });
		const ledger = ledgerFixture({ transactions: [t] });
		const csv = reconciliationCsv(ledger, {});
		const row = csv.split("\n")[1];
		expect(row?.split(",")[7]).toBe("payout ref");
	});

	it("maps every decision kind to its status word", () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			["no-document", "NOT AVAILABLE"],
			["personal", "PERSONAL"],
			["ignore", "IGNORED"],
			["duplicate", "DUPLICATE"],
		];
		for (const [kind, expected] of cases) {
			const t = txn({ id: `wise:${kind}` });
			const decision =
				kind === "no-document"
					? { kind: "no-document" as const, reason: "test" }
					: kind === "ignore"
						? { kind: "ignore" as const, reason: "test" }
						: kind === "duplicate"
							? { kind: "duplicate" as const, of: "d1" as DocumentId }
							: { kind: "personal" as const };
			const ledger = ledgerFixture({
				transactions: [t],
				decisions: { [`wise:${kind}`]: decision },
			});
			const csv = reconciliationCsv(ledger, {});
			const row = csv.split("\n")[1];
			expect(row?.split(",")[8]).toBe(expected);
		}
	});

	it("reports MISSING for an unmatched, undecided transaction", () => {
		const t = txn({ id: "wise:5" });
		const ledger = ledgerFixture({ transactions: [t] });
		const csv = reconciliationCsv(ledger, {});
		expect(csv.split("\n")[1]?.split(",")[8]).toBe("MISSING");
	});

	it("orders transactions by date then id", () => {
		const a = txn({ id: "wise:b", bookedAt: parseIsoDate("2026-01-10") });
		const b = txn({ id: "wise:a", bookedAt: parseIsoDate("2026-01-01") });
		const c = txn({ id: "wise:a2", bookedAt: parseIsoDate("2026-01-01") });
		const ledger = ledgerFixture({ transactions: [a, b, c] });
		const csv = reconciliationCsv(ledger, {});
		const dataLines = csv.split("\n").slice(1, 4);
		const ids = dataLines.map((line) => line.split(",")[7]); // description column doubles as identity here
		expect(ids).toEqual(["Acme Supplies", "Acme Supplies", "Acme Supplies"]);
		const dates = dataLines.map((line) => line.split(",")[0]);
		expect(dates).toEqual(["2026-01-01", "2026-01-01", "2026-01-10"]);
	});

	it("quotes fields containing commas", () => {
		const t = txn({ id: "wise:6", counterparty: "Acme, Inc." });
		const ledger = ledgerFixture({ transactions: [t] });
		const csv = reconciliationCsv(ledger, {});
		expect(csv.split("\n")[1]).toContain('"Acme, Inc."');
	});

	it("no longer carries an orphan-documents trailer", () => {
		const orphan = doc({ id: "orphan1", filename: "orphan1.pdf" });
		const ledger = ledgerFixture({ documents: [orphan] });
		const csv = reconciliationCsv(ledger, { orphan1: "orphan1.pdf" });
		expect(csv).not.toContain("orphan_documents");
		expect(csv).not.toContain("orphan1.pdf");
	});
});

describe("unmatchedDocumentsCsv", () => {
	it("lists unmatched documents with their filename, party, and issued date", () => {
		const orphan = doc({ id: "orphan1", filename: "orphan1.pdf" });
		const ledger = ledgerFixture({
			documents: [orphan],
			extractions: { orphan1: extraction({ party: "Loose Vendor" }) },
		});
		const csv = unmatchedDocumentsCsv(ledger, {
			orphan1: "2026-01-01_loose-vendor_0.00-USD.pdf",
		});
		const [header, row] = csv.split("\n");
		expect(header).toBe("filename,party,issued_at");
		expect(row).toBe("2026-01-01_loose-vendor_0.00-USD.pdf,Loose Vendor,2026-01-03");
	});

	it("excludes matched documents", () => {
		const t = txn({ id: "wise:7" });
		const d = doc({ id: "d7" });
		const ledger = ledgerFixture({
			transactions: [t],
			documents: [d],
			extractions: { d7: extraction() },
			matches: [match({ transactionId: "wise:7", documentId: "d7" })],
		});
		const csv = unmatchedDocumentsCsv(ledger, { d7: "d7.pdf" });
		expect(csv).toBe("filename,party,issued_at\n");
	});

	it("excludes bank statements even when unmatched", () => {
		const statement = doc({
			id: "stmt1",
			origin: { kind: "statement", source: "wise", account: "multi" },
		});
		const ledger = ledgerFixture({
			documents: [statement],
			extractions: { stmt1: extraction({ kind: "statement", side: "expense" }) },
		});
		const csv = unmatchedDocumentsCsv(ledger, { stmt1: "stmt1.pdf" });
		expect(csv).toBe("filename,party,issued_at\n");
	});

	it("excludes documents that already carry a decision", () => {
		const orphan = doc({ id: "orphan1", filename: "orphan1.pdf" });
		const ledger = ledgerFixture({
			documents: [orphan],
			extractions: { orphan1: extraction({ party: "Loose Vendor" }) },
			decisions: { orphan1: { kind: "personal" } },
		});
		const csv = unmatchedDocumentsCsv(ledger, { orphan1: "orphan1.pdf" });
		expect(csv).toBe("filename,party,issued_at\n");
	});
});
