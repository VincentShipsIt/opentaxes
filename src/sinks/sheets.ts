import type { sheets_v4 } from "googleapis";
import type { PublishInput, PublishResult, Sink } from "../core/registry.ts";
import { LEDGER_HEADER, ledgerRows } from "./rows.ts";

export interface SheetsSinkOptions {
	readonly sheets: sheets_v4.Sheets;
	readonly spreadsheetId: string;
	readonly sheetName: string;
}

/**
 * Keeps one tab of `spreadsheetId` mirroring the ledger: creates the tab and header row if
 * missing, then appends only the rows whose transaction id (column A) isn't there yet.
 */
export function createSheetsSink(options: SheetsSinkOptions): Sink {
	const { sheets, spreadsheetId, sheetName } = options;

	return {
		name: "sheets",
		async publish(input: PublishInput): Promise<PublishResult> {
			await ensureSheet(sheets, spreadsheetId, sheetName);

			const range = `${sheetName}!A:Z`;
			const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range });
			const existingRows = existing.data.values ?? [];
			const currentHeader = existingRows[0] ?? [];

			if (!arraysEqual(currentHeader, LEDGER_HEADER)) {
				await sheets.spreadsheets.values.update({
					spreadsheetId,
					range: `${sheetName}!A1`,
					valueInputOption: "RAW",
					requestBody: { values: [[...LEDGER_HEADER]] },
				});
			}

			const existingIds = new Set(
				existingRows
					.slice(1)
					.map((row) => (typeof row[0] === "string" ? row[0] : ""))
					.filter(Boolean)
			);
			const rows = ledgerRows(input.ledger, input.filenames).slice(1);
			const toAppend = rows.filter((row) => !existingIds.has(row[0] ?? ""));

			if (toAppend.length > 0) {
				await sheets.spreadsheets.values.append({
					spreadsheetId,
					range: `${sheetName}!A1`,
					valueInputOption: "RAW",
					requestBody: { values: toAppend.map((row) => [...row]) },
				});
			}

			return { sink: "sheets", created: toAppend.length, unchanged: rows.length - toAppend.length };
		},
	};
}

async function ensureSheet(
	sheets: sheets_v4.Sheets,
	spreadsheetId: string,
	sheetName: string
): Promise<void> {
	const response = await sheets.spreadsheets.get({
		spreadsheetId,
		fields: "sheets.properties.title",
	});
	const titles = (response.data.sheets ?? []).map((sheet) => sheet.properties?.title);
	if (titles.includes(sheetName)) return;
	await sheets.spreadsheets.batchUpdate({
		spreadsheetId,
		requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
	});
}

function arraysEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}
