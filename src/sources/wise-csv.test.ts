import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseIsoDate, parseMonth } from "../core/dates.ts";
import { currency } from "../core/money.ts";
import type { TransactionId } from "../core/types.ts";
import {
	createWiseCsvSource,
	mapWiseCsvRow,
	parseStatementFilename,
	parseWiseCsvDate,
} from "./wise-csv.ts";

const FIXTURES = join(import.meta.dir, "../../fixtures/wise-csv");
const USD = currency("USD");
const EUR = currency("EUR");
const wiseId = (id: string) => `wise:${id}` as TransactionId;

describe("parseStatementFilename", () => {
	test("parses balance id, currency and the statement period", () => {
		expect(parseStatementFilename("statement_1001_USD_2026-01-01_2026-01-31.csv")).toEqual({
			balanceId: "1001",
			currency: USD,
			start: parseIsoDate("2026-01-01"),
			end: parseIsoDate("2026-01-31"),
		});
	});

	test("returns null for a filename that doesn't match", () => {
		expect(parseStatementFilename("statement_1001_USD_2026-01-01.csv")).toBeNull();
		expect(parseStatementFilename("readme.txt")).toBeNull();
		expect(parseStatementFilename("statement_1001_usd_2026-01-01_2026-01-31.csv")).toBeNull();
	});
});

describe("parseWiseCsvDate", () => {
	test("reads DD-MM-YYYY, not month-first", () => {
		expect(parseWiseCsvDate("05-01-2026")).toBe(parseIsoDate("2026-01-05"));
		expect(parseWiseCsvDate("31-12-2025")).toBe(parseIsoDate("2025-12-31"));
	});

	test("rejects a malformed date", () => {
		expect(() => parseWiseCsvDate("2026-01-05")).toThrow();
		expect(() => parseWiseCsvDate("05/01/2026")).toThrow();
	});
});

describe("mapWiseCsvRow", () => {
	function row(overrides: Readonly<Record<string, string>>): Record<string, string> {
		return {
			"TransferWise ID": "DIRECT_DEBIT-1",
			Date: "05-01-2026",
			"Date Time": "05-01-2026 10:00:00.000",
			Amount: "-10.00",
			Currency: "USD",
			Description: "",
			"Payment Reference": "",
			"Running Balance": "0.00",
			"Exchange From": "",
			"Exchange To": "",
			"Exchange Rate": "",
			"Payer Name": "",
			"Payee Name": "",
			"Payee Account Number": "",
			Merchant: "",
			"Card Last Four Digits": "",
			"Card Holder Full Name": "",
			Attachment: "",
			Note: "",
			"Total fees": "0.00",
			"Exchange To Amount": "",
			"Transaction Type": "DEBIT",
			"Transaction Details Type": "DIRECT_DEBIT",
			...overrides,
		};
	}

	test("builds the id from the TransferWise ID verbatim", () => {
		const transaction = mapWiseCsvRow(row({ "TransferWise ID": "CARD_TRANSACTION-42" }));
		expect(transaction.id).toBe(wiseId("CARD_TRANSACTION-42"));
		expect(transaction.source).toBe("wise");
	});

	test("reads direction from the sign and drops it from the amount", () => {
		const debit = mapWiseCsvRow(row({ Amount: "-45.00" }));
		expect(debit.direction).toBe("out");
		expect(debit.amount).toEqual({ minor: 4500, currency: USD });

		const credit = mapWiseCsvRow(row({ "TransferWise ID": "TRANSFER-1", Amount: "500.00" }));
		expect(credit.direction).toBe("in");
		expect(credit.amount).toEqual({ minor: 50000, currency: USD });
	});

	test("sets original from Exchange To / Exchange To Amount when it differs from the balance currency", () => {
		const transaction = mapWiseCsvRow(
			row({
				"TransferWise ID": "CARD_TRANSACTION-4821093756",
				Amount: "-97.50",
				Description: "Card transaction of 84.15 EUR issued by Acme Mail Co ACMEMAIL.IO",
				"Exchange From": "USD",
				"Exchange To": "EUR",
				"Exchange To Amount": "84.15",
				Merchant: "Acme Mail Co ACMEMAIL.IO",
			})
		);
		expect(transaction.original).toEqual({ minor: 8415, currency: EUR });
		expect(transaction.counterparty).toBe("Acme Mail Co ACMEMAIL.IO");
	});

	test("leaves original out when the exchange columns are empty", () => {
		const transaction = mapWiseCsvRow(row({}));
		expect(transaction.original).toBeUndefined();
	});

	test("leaves original out when Exchange To equals the balance currency", () => {
		const transaction = mapWiseCsvRow(
			row({
				"TransferWise ID": "CARD_TRANSACTION-1122334455",
				Amount: "-12.50",
				"Exchange From": "USD",
				"Exchange To": "USD",
				"Exchange To Amount": "12.50",
				Merchant: "Notion Labs Inc",
			})
		);
		expect(transaction.original).toBeUndefined();
		expect(transaction.counterparty).toBe("Notion Labs Inc");
	});

	test("counterparty prefers Merchant, then Payee Name, then Payer Name", () => {
		expect(
			mapWiseCsvRow(row({ Merchant: "M", "Payee Name": "P", "Payer Name": "R" })).counterparty
		).toBe("M");
		expect(mapWiseCsvRow(row({ "Payee Name": "P", "Payer Name": "R" })).counterparty).toBe("P");
		expect(mapWiseCsvRow(row({ "Payer Name": "R" })).counterparty).toBe("R");
	});

	test("falls back to the description with the 'Paid to' prefix removed", () => {
		const transaction = mapWiseCsvRow(row({ Description: "Paid to Acme Hosting Ltd" }));
		expect(transaction.counterparty).toBe("Acme Hosting Ltd");
	});

	test("falls back to the description with the card-issuer prefix removed", () => {
		const transaction = mapWiseCsvRow(
			row({ Description: "Card transaction of 12.50 USD issued by Notion Labs Inc" })
		);
		expect(transaction.counterparty).toBe("Notion Labs Inc");
	});

	test("reference is the payment reference, else the description", () => {
		expect(
			mapWiseCsvRow(row({ "Payment Reference": "INV-9", Description: "Paid to X" })).reference
		).toBe("INV-9");
		expect(mapWiseCsvRow(row({ Description: "Paid to X" })).reference).toBe("Paid to X");
	});

	test("a CONVERSION row is emitted with counterparty Wise", () => {
		const transaction = mapWiseCsvRow(
			row({
				"TransferWise ID": "CONVERSION-1",
				Description: "Converted 200.00 USD to 172.00 EUR",
				"Transaction Details Type": "CONVERSION",
				"Exchange From": "USD",
				"Exchange To": "EUR",
				"Exchange To Amount": "172.00",
			})
		);
		expect(transaction.counterparty).toBe("Wise");
	});

	test("a description starting with Converted is emitted with counterparty Wise even without CONVERSION type", () => {
		const transaction = mapWiseCsvRow(
			row({ "TransferWise ID": "CONVERSION-2", Description: "Converted balance move" })
		);
		expect(transaction.counterparty).toBe("Wise");
	});

	test("throws when TransferWise ID is missing", () => {
		expect(() => mapWiseCsvRow(row({ "TransferWise ID": "" }))).toThrow();
	});
});

describe("createWiseCsvSource", () => {
	test("parses the basic fixture: card conversion, direct debit, credit, same-currency card, conversion move", async () => {
		const source = createWiseCsvSource({ dir: join(FIXTURES, "basic") });
		const transactions = await source.fetchTransactions(parseMonth("2026-01"));

		expect(transactions.map((t) => t.id)).toEqual([
			wiseId("CARD_TRANSACTION-4821093756"),
			wiseId("DIRECT_DEBIT-70045213"),
			wiseId("TRANSFER-987654"),
			wiseId("CARD_TRANSACTION-1122334455"),
			wiseId("CONVERSION-556677"),
		]);

		const cardCharge = transactions.find((t) => t.id === wiseId("CARD_TRANSACTION-4821093756"));
		expect(cardCharge?.original).toEqual({ minor: 8415, currency: EUR });

		const directDebit = transactions.find((t) => t.id === wiseId("DIRECT_DEBIT-70045213"));
		expect(directDebit?.counterparty).toBe("Acme Hosting Ltd");
		expect(directDebit?.reference).toBe("INV-2026-004");

		const credit = transactions.find((t) => t.id === wiseId("TRANSFER-987654"));
		expect(credit?.direction).toBe("in");
		expect(credit?.counterparty).toBe("Jane Client");

		const sameCurrencyCard = transactions.find(
			(t) => t.id === wiseId("CARD_TRANSACTION-1122334455")
		);
		expect(sameCurrencyCard?.original).toBeUndefined();

		const conversion = transactions.find((t) => t.id === wiseId("CONVERSION-556677"));
		expect(conversion?.counterparty).toBe("Wise");
	});

	test("an EUR header-only file contributes no transactions", async () => {
		const source = createWiseCsvSource({ dir: join(FIXTURES, "basic") });
		const transactions = await source.fetchTransactions(parseMonth("2026-01"));
		expect(transactions.every((t) => t.amount.currency !== "EUR")).toBe(true);
	});

	test("a file whose statement period doesn't intersect the month is skipped", async () => {
		const source = createWiseCsvSource({ dir: join(FIXTURES, "out-of-range") });
		const transactions = await source.fetchTransactions(parseMonth("2026-01"));
		expect(transactions).toEqual([]);
	});

	test("a row dated in the next month is dropped even when its file spans the boundary", async () => {
		const source = createWiseCsvSource({ dir: join(FIXTURES, "spans-month") });

		const january = await source.fetchTransactions(parseMonth("2026-01"));
		expect(january.map((t) => t.id)).toEqual([wiseId("CARD_TRANSACTION-2233445566")]);

		const february = await source.fetchTransactions(parseMonth("2026-02"));
		expect(february.map((t) => t.id)).toEqual([wiseId("CARD_TRANSACTION-3344556677")]);
	});

	test("duplicate ids across two files collapse to one transaction", async () => {
		const source = createWiseCsvSource({ dir: join(FIXTURES, "duplicates") });
		const transactions = await source.fetchTransactions(parseMonth("2026-01"));
		expect(transactions).toHaveLength(1);
		expect(transactions[0]?.id).toBe(wiseId("DIRECT_DEBIT-99999999"));
	});

	test("throws with the filename when a file can't be read", async () => {
		const source = createWiseCsvSource({
			dir: "/nonexistent",
			readdir: async () => ["statement_1001_USD_2026-01-01_2026-01-31.csv"],
			readFile: async () => {
				throw new Error("boom");
			},
		});
		await expect(source.fetchTransactions(parseMonth("2026-01"))).rejects.toThrow(
			/statement_1001_USD_2026-01-01_2026-01-31\.csv/
		);
	});

	test("throws with the filename when a row is malformed", async () => {
		const source = createWiseCsvSource({
			dir: "/nonexistent",
			readdir: async () => ["statement_1001_USD_2026-01-01_2026-01-31.csv"],
			readFile: async () => "TransferWise ID,Date,Amount,Currency\n,05-01-2026,-1.00,USD\n",
		});
		await expect(source.fetchTransactions(parseMonth("2026-01"))).rejects.toThrow(
			/statement_1001_USD_2026-01-01_2026-01-31\.csv/
		);
	});
});
