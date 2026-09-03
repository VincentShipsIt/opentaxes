import { describe, expect, it } from "bun:test";
import { parseIsoDate } from "../core/dates.ts";
import { LEDGER_HEADER, ledgerRows } from "./rows.ts";
import { doc, extraction, ledgerFixture, match, txn } from "./test-fixtures.ts";

describe("ledgerRows", () => {
	it("prepends the transaction id to the shared column set", () => {
		expect(LEDGER_HEADER).toEqual([
			"id",
			"date",
			"bank",
			"debit",
			"credit",
			"currency",
			"original",
			"original_currency",
			"description",
			"invoice",
			"file",
			"party",
			"category",
		]);
	});

	it("returns the header row followed by one row per transaction, id first", () => {
		const t = txn({ id: "wise:1" });
		const d = doc({ id: "d1" });
		const ledger = ledgerFixture({
			transactions: [t],
			documents: [d],
			extractions: { d1: extraction() },
			matches: [match({ transactionId: "wise:1", documentId: "d1" })],
		});
		const rows = ledgerRows(ledger, { d1: "invoice.pdf" });
		expect(rows[0]).toEqual(LEDGER_HEADER);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toEqual([
			"wise:1",
			"2026-01-05",
			"WISE",
			"100.00",
			"",
			"USD",
			"",
			"",
			"Acme Supplies",
			"UPLOADED",
			"invoice.pdf",
			"Acme Supplies",
			"software",
		]);
	});

	it("orders data rows by date then id, independent of ledger insertion order", () => {
		const later = txn({ id: "wise:z", bookedAt: parseIsoDate("2026-01-20") });
		const earlier = txn({ id: "wise:a", bookedAt: parseIsoDate("2026-01-01") });
		const ledger = ledgerFixture({ transactions: [later, earlier] });
		const rows = ledgerRows(ledger, {});
		expect(rows.slice(1).map((row) => row[0])).toEqual(["wise:a", "wise:z"]);
	});

	it("returns just the header for an empty ledger", () => {
		const rows = ledgerRows(ledgerFixture(), {});
		expect(rows).toEqual([LEDGER_HEADER]);
	});
});
