import type { sheets_v4 } from "googleapis";
import type { PublishInput, PublishResult, Sink } from "../core/registry.ts";
import { ledgerRows } from "./rows.ts";

export interface SheetsSinkOptions {
	readonly sheets: sheets_v4.Sheets;
	readonly spreadsheetId: string;
	readonly sheetName: string;
}

/**
 * Keeps one tab of `spreadsheetId` mirroring the ledger exactly: the tab is regenerated on every
 * publish, so hand edits made directly in the sheet do not survive. Computes the desired header
 * plus rows, reads the tab back, and — only when the two differ — clears `<sheetName>!A:Z` and
 * writes the header and every row in one `values.update`. `created` counts transaction ids that
 * were not present in the tab before this publish; `unchanged` counts rows whose full content was
 * already identical.
 */
export function createSheetsSink(options: SheetsSinkOptions): Sink {
	const { sheets, spreadsheetId, sheetName } = options;

	return {
		name: "sheets",
		async publish(input: PublishInput): Promise<PublishResult> {
			await ensureSheet(sheets, spreadsheetId, sheetName);

			const range = `${sheetName}!A:Z`;
			const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range });
			const existingRows = (existing.data.values ?? []).map(normalizeRow);

			const existingById = new Map<string, readonly string[]>();
			for (const row of existingRows.slice(1)) {
				const id = row[0] ?? "";
				if (id) existingById.set(id, row);
			}

			const desiredRows = ledgerRows(input.ledger, input.filenames);
			const desiredDataRows = desiredRows.slice(1);

			let created = 0;
			let unchanged = 0;
			for (const row of desiredDataRows) {
				const id = row[0] ?? "";
				const previous = existingById.get(id);
				if (!previous) {
					created += 1;
				} else if (rowsEqual(previous, row)) {
					unchanged += 1;
				}
			}

			if (!sheetsEqual(existingRows, desiredRows)) {
				await sheets.spreadsheets.values.clear({ spreadsheetId, range, requestBody: {} });
				await sheets.spreadsheets.values.update({
					spreadsheetId,
					range: `${sheetName}!A1`,
					valueInputOption: "RAW",
					requestBody: { values: desiredRows.map((row) => [...row]) },
				});
			}

			return { sink: "sheets", created, unchanged };
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

function normalizeRow(row: readonly unknown[]): readonly string[] {
	return row.map((cell) => (typeof cell === "string" ? cell : ""));
}

function rowsEqual(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sheetsEqual(
	existing: readonly (readonly string[])[],
	desired: readonly (readonly string[])[]
): boolean {
	if (existing.length !== desired.length) return false;
	return desired.every((row, index) => {
		const existingRow = existing[index];
		return existingRow !== undefined && rowsEqual(existingRow, row);
	});
}
