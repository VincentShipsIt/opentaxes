/**
 * Minimal RFC 4180 parser: quoted fields, doubled quotes inside a quoted field, and either
 * CRLF or LF line endings. No dependency, since this is the whole feature we need from a CSV
 * library.
 */
export function parseCsv(text: string): readonly (readonly string[])[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let sawAnyField = false;

	const endField = () => {
		row.push(field);
		field = "";
	};
	const endRow = () => {
		endField();
		rows.push(row);
		row = [];
		sawAnyField = false;
	};

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (inQuotes) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}
			continue;
		}

		if (char === '"' && field === "") {
			inQuotes = true;
			sawAnyField = true;
			continue;
		}
		if (char === ",") {
			endField();
			sawAnyField = true;
			continue;
		}
		if (char === "\r") {
			if (text[i + 1] === "\n") i++;
			endRow();
			continue;
		}
		if (char === "\n") {
			endRow();
			continue;
		}
		field += char;
		sawAnyField = true;
	}

	if (field !== "" || sawAnyField) endRow();

	return rows;
}

/** Parses a CSV with a header row into one record per data row, keyed by header. */
export function parseCsvRecords(text: string): readonly Readonly<Record<string, string>>[] {
	const rows = parseCsv(text);
	if (rows.length === 0) return [];
	const [header, ...dataRows] = rows as [readonly string[], ...(readonly string[])[]];
	return dataRows
		.filter((row) => row.length > 1 || row[0] !== "")
		.map((row) => {
			const record: Record<string, string> = {};
			header.forEach((key, index) => {
				record[key] = row[index] ?? "";
			});
			return record;
		});
}
