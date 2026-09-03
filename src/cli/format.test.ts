import { describe, expect, it } from "bun:test";
import { parseMonth } from "../core/dates.ts";
import { currency, money } from "../core/money.ts";
import { summary } from "../core/reconcile.ts";
import type { PublishResult } from "../core/registry.ts";
import type { PublishSummary } from "../core/run.ts";
import { doc, extraction, ledgerFixture, txn } from "../sinks/test-fixtures.ts";
import {
	formatMissing,
	formatMissingJson,
	formatPublishJson,
	formatPublishTable,
	formatSummaryJson,
	formatSummaryTable,
} from "./format.ts";

const MONTH = parseMonth("2026-01");

describe("formatSummaryTable / formatSummaryJson", () => {
	it("renders every count from the summary", () => {
		const ledger = ledgerFixture({
			transactions: [txn({ id: "t1" })],
			documents: [doc({ id: "d1" })],
		});
		const value = summary(ledger);
		const table = formatSummaryTable(value);
		expect(table).toContain(`Month             ${MONTH}`);
		expect(table).toContain("Transactions      1");
		expect(table).toContain("Documents         1");
		expect(table).toContain("Unextracted docs  1");
	});

	it("round-trips through JSON", () => {
		const ledger = ledgerFixture({ transactions: [txn({ id: "t1" })] });
		const value = summary(ledger);
		expect(JSON.parse(formatSummaryJson(value))).toEqual(value);
	});
});

describe("formatPublishTable / formatPublishJson", () => {
	it("says nothing was published when there are no sink results", () => {
		const ledger = ledgerFixture({});
		const value: PublishSummary = { summary: summary(ledger), results: [] };
		expect(formatPublishTable(value)).toContain("No sinks configured");
	});

	it("lists each sink's created/unchanged counts", () => {
		const ledger = ledgerFixture({});
		const results: readonly PublishResult[] = [
			{ sink: "folder", created: 3, unchanged: 1 },
			{ sink: "drive", created: 0, unchanged: 4 },
		];
		const value: PublishSummary = { summary: summary(ledger), results };
		const table = formatPublishTable(value);
		expect(table).toContain("folder");
		expect(table).toContain("3");
		expect(table).toContain("drive");
		expect(JSON.parse(formatPublishJson(value))).toEqual(value);
	});
});

describe("formatMissing / formatMissingJson", () => {
	it("reports nothing missing when everything is settled", () => {
		const ledger = ledgerFixture({});
		expect(formatMissing(ledger)).toContain("Nothing missing");
	});

	it("lists unmatched transactions with enough detail to chase them", () => {
		const transaction = txn({
			id: "t1",
			counterparty: "Acme Supplies",
			amount: money(5_000, currency("USD")),
		});
		const ledger = ledgerFixture({ transactions: [transaction] });
		const text = formatMissing(ledger);
		expect(text).toContain("Unmatched transactions (1)");
		expect(text).toContain("Acme Supplies");
		expect(text).toContain("50.00 USD");
	});

	it("lists orphan documents with their extracted vendor and amount", () => {
		const document = doc({ id: "d1" });
		const ledger = ledgerFixture({
			documents: [document],
			extractions: { d1: extraction({ party: "Vendor Co" }) },
		});
		const text = formatMissing(ledger);
		expect(text).toContain("Orphan documents (1)");
		expect(text).toContain("Vendor Co");
	});

	it("round-trips through JSON with the same shape summary() would report", () => {
		const transaction = txn({ id: "t1" });
		const ledger = ledgerFixture({ transactions: [transaction] });
		const parsed = JSON.parse(formatMissingJson(ledger));
		expect(parsed.unmatchedTransactions).toEqual(summary(ledger).unmatchedTransactions);
	});
});
