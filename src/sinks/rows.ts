import type { Ledger } from "../core/types.ts";
import { TRANSACTION_COLUMNS, transactionRecords } from "./layout.ts";

export const LEDGER_HEADER: readonly string[] = ["id", ...TRANSACTION_COLUMNS];

/** Header row followed by one row per transaction, in the order `LEDGER_HEADER` names. */
export function ledgerRows(
	ledger: Ledger,
	filenames: Readonly<Record<string, string>>
): readonly (readonly string[])[] {
	const rows = transactionRecords(ledger, filenames).map((record) => [
		record.id,
		record.date,
		record.bank,
		record.debit,
		record.credit,
		record.currency,
		record.original,
		record.originalCurrency,
		record.description,
		record.invoice,
		record.file,
		record.party,
		record.category,
	]);
	return [LEDGER_HEADER, ...rows];
}
