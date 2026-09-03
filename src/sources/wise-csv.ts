import { readdir as nodeReaddir, readFile as nodeReadFile } from "node:fs/promises";
import { join } from "node:path";
import { isInMonth, monthBounds, parseIsoDate } from "../core/dates.ts";
import { currency, moneyFromDecimal } from "../core/money.ts";
import type { TransactionSource } from "../core/registry.ts";
import type {
	Currency,
	Direction,
	IsoDate,
	Month,
	Transaction,
	TransactionId,
} from "../core/types.ts";
import { parseCsvRecords } from "./csv.ts";

const FILENAME_PATTERN =
	/^statement_([^_]+)_([A-Z]{3})_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv$/;
const WISE_CSV_DATE = /^(\d{2})-(\d{2})-(\d{4})$/;
const CARD_TRANSACTION_PREFIX = /^Card transaction of [\d.,]+ [A-Z]{3} issued by /;
const PAID_TO_PREFIX = /^Paid to /;

export interface WiseCsvFileInfo {
	readonly balanceId: string;
	readonly currency: Currency;
	readonly start: IsoDate;
	readonly end: IsoDate;
}

export interface WiseCsvSourceOptions {
	readonly dir: string;
	readonly readdir?: (dir: string) => Promise<readonly string[]>;
	readonly readFile?: (path: string, encoding: "utf8") => Promise<string>;
}

/** Parses a Wise balance-statement export filename, e.g. "statement_12345_USD_2026-01-01_2026-01-31.csv". */
export function parseStatementFilename(filename: string): WiseCsvFileInfo | null {
	const match = FILENAME_PATTERN.exec(filename);
	if (!match) return null;
	const [, balanceId, currencyCode, start, end] = match as [string, string, string, string, string];
	return {
		balanceId,
		currency: currency(currencyCode),
		start: parseIsoDate(start),
		end: parseIsoDate(end),
	};
}

/** Wise CSV exports dates as "DD-MM-YYYY"; `Date.parse` would misread that as month-first. */
export function parseWiseCsvDate(value: string): IsoDate {
	const match = WISE_CSV_DATE.exec(value.trim());
	if (!match) throw new Error(`invalid Wise CSV date "${value}", expected DD-MM-YYYY`);
	const [, day, month, year] = match as [string, string, string, string];
	return parseIsoDate(`${year}-${month}-${day}`);
}

/** Maps one Wise balance-statement CSV row (keyed by the header, verbatim) to a `Transaction`. */
export function mapWiseCsvRow(row: Readonly<Record<string, string>>): Transaction {
	const nativeId = row["TransferWise ID"]?.trim();
	if (!nativeId) throw new Error("row is missing a TransferWise ID");

	const rawAmount = row.Amount?.trim();
	const currencyCode = row.Currency?.trim();
	if (!rawAmount) throw new Error(`row ${nativeId} is missing Amount`);
	if (!currencyCode) throw new Error(`row ${nativeId} is missing Currency`);
	const balanceCurrency = currency(currencyCode);

	const rawDate = row.Date?.trim();
	if (!rawDate) throw new Error(`row ${nativeId} is missing Date`);

	const direction: Direction = rawAmount.startsWith("-") ? "out" : "in";
	const description = row.Description?.trim() ?? "";
	const detailsType = row["Transaction Details Type"]?.trim() ?? "";

	const isConversion = detailsType === "CONVERSION" || description.startsWith("Converted");
	const counterparty = isConversion ? "Wise" : counterpartyOf(row, description);
	const reference = row["Payment Reference"]?.trim() || description;

	const exchangeTo = row["Exchange To"]?.trim();
	const exchangeToAmount = row["Exchange To Amount"]?.trim();
	const exchangeToCurrency = exchangeTo ? currency(exchangeTo) : undefined;
	const original =
		exchangeToCurrency && exchangeToAmount && exchangeToCurrency !== balanceCurrency
			? moneyFromDecimal(exchangeToAmount, exchangeToCurrency)
			: undefined;

	return {
		id: `wise:${nativeId}` as TransactionId,
		source: "wise",
		bookedAt: parseWiseCsvDate(rawDate),
		direction,
		amount: moneyFromDecimal(rawAmount, balanceCurrency),
		...(original ? { original } : {}),
		counterparty,
		reference,
	};
}

function counterpartyOf(row: Readonly<Record<string, string>>, description: string): string {
	const merchant = row.Merchant?.trim();
	const payeeName = row["Payee Name"]?.trim();
	const payerName = row["Payer Name"]?.trim();
	const named = merchant || payeeName || payerName;
	if (named) return named;
	return description.replace(CARD_TRANSACTION_PREFIX, "").replace(PAID_TO_PREFIX, "");
}

export function createWiseCsvSource(options: WiseCsvSourceOptions): TransactionSource {
	const { dir } = options;
	const readdir: (dir: string) => Promise<readonly string[]> = options.readdir ?? nodeReaddir;
	const readFile: (path: string, encoding: "utf8") => Promise<string> =
		options.readFile ?? ((path, encoding) => nodeReadFile(path, encoding));

	return {
		name: "wise",

		async fetchTransactions(month: Month): Promise<readonly Transaction[]> {
			const { start: monthStart, end: monthEnd } = monthBounds(month);
			const entries = await readdir(dir);
			const files = entries
				.map((filename) => ({ filename, info: parseStatementFilename(filename) }))
				.filter(
					(entry): entry is { readonly filename: string; readonly info: WiseCsvFileInfo } =>
						entry.info !== null && entry.info.start <= monthEnd && entry.info.end >= monthStart
				);

			const seen = new Set<TransactionId>();
			const transactions: Transaction[] = [];
			for (const { filename } of files) {
				const path = join(dir, filename);
				let text: string;
				try {
					text = await readFile(path, "utf8");
				} catch (cause) {
					throw new Error(`could not read Wise CSV file "${filename}"`, { cause });
				}
				let records: readonly Readonly<Record<string, string>>[];
				try {
					records = parseCsvRecords(text);
				} catch (cause) {
					throw new Error(`malformed Wise CSV file "${filename}"`, { cause });
				}
				for (const record of records) {
					let transaction: Transaction;
					try {
						transaction = mapWiseCsvRow(record);
					} catch (cause) {
						throw new Error(`malformed Wise CSV file "${filename}"`, { cause });
					}
					if (!isInMonth(transaction.bookedAt, month)) continue;
					if (seen.has(transaction.id)) continue;
					seen.add(transaction.id);
					transactions.push(transaction);
				}
			}

			return transactions.sort(
				(a, b) => a.bookedAt.localeCompare(b.bookedAt) || a.id.localeCompare(b.id)
			);
		},
	};
}
