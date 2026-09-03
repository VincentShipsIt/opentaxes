import { describe, expect, it } from "bun:test";
import type { sheets_v4 } from "googleapis";
import type { PublishInput } from "../core/registry.ts";
import { createSheetsSink } from "./sheets.ts";
import { doc, extraction, ledgerFixture, match, txn } from "./test-fixtures.ts";

function createFakeSheets(
	initialTabs: Readonly<Record<string, readonly (readonly unknown[])[]>> = {}
) {
	const tabs = new Map<string, unknown[][]>(
		Object.entries(initialTabs).map(([title, rows]) => [title, rows.map((row) => [...row])])
	);
	const calls = { get: 0, batchUpdate: 0, valuesGet: 0, valuesUpdate: 0, valuesAppend: 0 };

	const tabTitle = (range: string) => range.split("!")[0] ?? range;

	const spreadsheets = {
		async get() {
			calls.get += 1;
			return { data: { sheets: [...tabs.keys()].map((title) => ({ properties: { title } })) } };
		},
		async batchUpdate({
			requestBody,
		}: {
			requestBody: { requests: readonly { addSheet?: { properties: { title: string } } }[] };
		}) {
			calls.batchUpdate += 1;
			for (const request of requestBody.requests) {
				if (request.addSheet) tabs.set(request.addSheet.properties.title, []);
			}
			return { data: {} };
		},
		values: {
			async get({ range }: { range: string }) {
				calls.valuesGet += 1;
				const rows = tabs.get(tabTitle(range)) ?? [];
				return { data: { values: rows.length > 0 ? rows.map((row) => [...row]) : undefined } };
			},
			async update({
				range,
				requestBody,
			}: {
				range: string;
				requestBody: { values: unknown[][] };
			}) {
				calls.valuesUpdate += 1;
				const title = tabTitle(range);
				const rows = tabs.get(title) ?? [];
				const header = requestBody.values[0];
				if (header) rows[0] = [...header];
				tabs.set(title, rows);
				return { data: {} };
			},
			async append({
				range,
				requestBody,
			}: {
				range: string;
				requestBody: { values: unknown[][] };
			}) {
				calls.valuesAppend += 1;
				const title = tabTitle(range);
				const rows = tabs.get(title) ?? [];
				for (const row of requestBody.values) rows.push([...row]);
				tabs.set(title, rows);
				return { data: {} };
			},
		},
	};

	return { sheets: { spreadsheets } as unknown as sheets_v4.Sheets, calls, tabs };
}

function buildInput(): PublishInput {
	const invoice = doc({ id: "d1", filename: "invoice.pdf" });
	const t = txn({ id: "wise:1" });
	const ledger = ledgerFixture({
		transactions: [t],
		documents: [invoice],
		extractions: { d1: extraction({ party: "Acme Supplies", category: "software" }) },
		matches: [match({ transactionId: "wise:1", documentId: "d1" })],
	});
	return {
		ledger,
		filenames: { d1: "invoice.pdf" },
		readDocument: async () => new TextEncoder().encode("invoice-bytes"),
	};
}

describe("createSheetsSink", () => {
	it("creates the sheet tab and header row when the spreadsheet has neither", async () => {
		const { sheets, tabs, calls } = createFakeSheets();
		const sink = createSheetsSink({ sheets, spreadsheetId: "sheet-1", sheetName: "Ledger" });

		const result = await sink.publish(buildInput());

		expect(result).toEqual({ sink: "sheets", created: 1, unchanged: 0 });
		expect(calls.batchUpdate).toBe(1);
		const rows = tabs.get("Ledger") ?? [];
		expect(rows[0]?.[0]).toBe("id");
		expect(rows).toHaveLength(2);
		expect(rows[1]?.[0]).toBe("wise:1");
	});

	it("leaves an existing correct header alone", async () => {
		const { sheets, calls } = createFakeSheets({
			Ledger: [
				[
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
				],
			],
		});
		const sink = createSheetsSink({ sheets, spreadsheetId: "sheet-1", sheetName: "Ledger" });

		await sink.publish(buildInput());

		expect(calls.valuesUpdate).toBe(0);
		expect(calls.batchUpdate).toBe(0);
	});

	it("is idempotent: a second publish appends nothing new", async () => {
		const { sheets, calls, tabs } = createFakeSheets();
		const sink = createSheetsSink({ sheets, spreadsheetId: "sheet-1", sheetName: "Ledger" });
		const input = buildInput();

		await sink.publish(input);
		const appendCallsAfterFirst = calls.valuesAppend;
		const result = await sink.publish(input);

		expect(result).toEqual({ sink: "sheets", created: 0, unchanged: 1 });
		expect(calls.valuesAppend).toBe(appendCallsAfterFirst); // no second append call
		expect(tabs.get("Ledger")).toHaveLength(2); // header + one data row, no duplicate
	});

	it("appends only rows whose id is not already present", async () => {
		const { sheets, tabs } = createFakeSheets();
		const sink = createSheetsSink({ sheets, spreadsheetId: "sheet-1", sheetName: "Ledger" });
		await sink.publish(buildInput());

		const secondInvoice = doc({ id: "d2", filename: "invoice2.pdf" });
		const secondTxn = txn({ id: "wise:2" });
		const secondLedger = ledgerFixture({
			transactions: [secondTxn],
			documents: [secondInvoice],
			extractions: { d2: extraction({ party: "Other Vendor" }) },
			matches: [match({ transactionId: "wise:2", documentId: "d2" })],
		});
		const result = await sink.publish({
			ledger: secondLedger,
			filenames: { d2: "invoice2.pdf" },
			readDocument: async () => new TextEncoder().encode("bytes"),
		});

		expect(result).toEqual({ sink: "sheets", created: 1, unchanged: 0 });
		expect(tabs.get("Ledger")).toHaveLength(2); // header + wise:2 row (wise:1 came from a different ledger)
	});
});
