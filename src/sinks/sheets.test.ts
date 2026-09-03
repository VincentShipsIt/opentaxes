import { describe, expect, it } from "bun:test";
import type { sheets_v4 } from "googleapis";
import type { PublishInput } from "../core/registry.ts";
import { LEDGER_HEADER, ledgerRows } from "./rows.ts";
import { createSheetsSink } from "./sheets.ts";
import { doc, extraction, ledgerFixture, match, txn } from "./test-fixtures.ts";

const INVOICE_COLUMN = LEDGER_HEADER.indexOf("invoice");

function createFakeSheets(
	initialTabs: Readonly<Record<string, readonly (readonly unknown[])[]>> = {}
) {
	const tabs = new Map<string, unknown[][]>(
		Object.entries(initialTabs).map(([title, rows]) => [title, rows.map((row) => [...row])])
	);
	const calls = { get: 0, batchUpdate: 0, valuesGet: 0, valuesClear: 0, valuesUpdate: 0 };

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
			async clear({ range }: { range: string }) {
				calls.valuesClear += 1;
				tabs.set(tabTitle(range), []);
				return { data: {} };
			},
			async update({
				range,
				requestBody,
			}: {
				range: string;
				requestBody: { values: unknown[][] };
			}) {
				calls.valuesUpdate += 1;
				tabs.set(
					tabTitle(range),
					requestBody.values.map((row) => [...row])
				);
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
	it("creates the sheet tab and writes the header plus rows when the spreadsheet has neither", async () => {
		const { sheets, tabs, calls } = createFakeSheets();
		const sink = createSheetsSink({ sheets, spreadsheetId: "sheet-1", sheetName: "Ledger" });

		const result = await sink.publish(buildInput());

		expect(result).toEqual({ sink: "sheets", created: 1, unchanged: 0 });
		expect(calls.batchUpdate).toBe(1);
		expect(calls.valuesClear).toBe(1);
		expect(calls.valuesUpdate).toBe(1);
		const rows = tabs.get("Ledger") ?? [];
		expect(rows[0]?.[0]).toBe("id");
		expect(rows).toHaveLength(2);
		expect(rows[1]?.[0]).toBe("wise:1");
	});

	it("leaves a tab alone when it already matches the ledger exactly", async () => {
		const input = buildInput();
		const rows = ledgerRows(input.ledger, input.filenames);
		const { sheets, calls } = createFakeSheets({ Ledger: rows });
		const sink = createSheetsSink({ sheets, spreadsheetId: "sheet-1", sheetName: "Ledger" });

		const result = await sink.publish(input);

		expect(result).toEqual({ sink: "sheets", created: 0, unchanged: 1 });
		expect(calls.batchUpdate).toBe(0);
		expect(calls.valuesClear).toBe(0);
		expect(calls.valuesUpdate).toBe(0);
	});

	it("is idempotent: a second identical publish leaves the tab untouched", async () => {
		const { sheets, calls, tabs } = createFakeSheets();
		const sink = createSheetsSink({ sheets, spreadsheetId: "sheet-1", sheetName: "Ledger" });
		const input = buildInput();

		await sink.publish(input);
		const clearCallsAfterFirst = calls.valuesClear;
		const updateCallsAfterFirst = calls.valuesUpdate;
		const result = await sink.publish(input);

		expect(result).toEqual({ sink: "sheets", created: 0, unchanged: 1 });
		expect(calls.valuesClear).toBe(clearCallsAfterFirst);
		expect(calls.valuesUpdate).toBe(updateCallsAfterFirst);
		expect(tabs.get("Ledger")).toHaveLength(2); // header + one data row, no duplicate
	});

	it("regenerates the tab when an existing transaction's decision changes, without duplicating the row", async () => {
		const { sheets, tabs } = createFakeSheets();
		const sink = createSheetsSink({ sheets, spreadsheetId: "sheet-1", sheetName: "Ledger" });
		const t = txn({ id: "wise:1" });

		const firstLedger = ledgerFixture({ transactions: [t] });
		const firstResult = await sink.publish({
			ledger: firstLedger,
			filenames: {},
			readDocument: async () => new TextEncoder().encode(""),
		});
		expect(firstResult).toEqual({ sink: "sheets", created: 1, unchanged: 0 });
		const firstRows = tabs.get("Ledger") ?? [];
		expect(firstRows[1]?.[INVOICE_COLUMN]).toBe("MISSING");

		const secondLedger = ledgerFixture({
			transactions: [t],
			decisions: { "wise:1": { kind: "ignore", reason: "not a business expense" } },
		});
		const secondResult = await sink.publish({
			ledger: secondLedger,
			filenames: {},
			readDocument: async () => new TextEncoder().encode(""),
		});

		// wise:1 already existed, so it is neither newly "created" nor byte-for-byte "unchanged"
		expect(secondResult).toEqual({ sink: "sheets", created: 0, unchanged: 0 });
		const rows = tabs.get("Ledger") ?? [];
		expect(rows).toHaveLength(2); // still header + one data row, no duplicate
		expect(rows[1]?.[0]).toBe("wise:1");
		expect(rows[1]?.[INVOICE_COLUMN]).toBe("IGNORED");
	});
});
