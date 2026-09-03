import { formatMoney } from "../core/money.ts";
import { summary } from "../core/reconcile.ts";
import type { PublishResult } from "../core/registry.ts";
import type { PublishSummary } from "../core/run.ts";
import type { Ledger, Summary } from "../core/types.ts";

export function formatSummaryTable(value: Summary): string {
	const lines = [
		`Month             ${value.month}`,
		`Transactions      ${value.transactions}`,
		`Documents         ${value.documents}`,
		`Matched           ${value.matched}`,
		`Unmatched txns    ${value.unmatchedTransactions.length}`,
		`Orphan docs       ${value.orphanDocuments.length}`,
		`Unextracted docs  ${value.unextractedDocuments.length}`,
	];
	return `${lines.join("\n")}\n`;
}

export function formatSummaryJson(value: Summary): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function formatPublishResults(results: readonly PublishResult[]): string[] {
	if (results.length === 0) return ["No sinks configured — nothing published."];
	const lines = ["Sink        Created   Unchanged"];
	for (const result of results) {
		lines.push(`${result.sink.padEnd(11)} ${String(result.created).padEnd(9)} ${result.unchanged}`);
	}
	return lines;
}

export function formatPublishTable(value: PublishSummary): string {
	const lines = [
		formatSummaryTable(value.summary).trimEnd(),
		"",
		...formatPublishResults(value.results),
	];
	return `${lines.join("\n")}\n`;
}

export function formatPublishJson(value: PublishSummary): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

/** Human-readable list of what still needs a receipt or a decision, with enough to chase it. */
export function formatMissing(ledger: Ledger): string {
	const { unmatchedTransactions, orphanDocuments } = summary(ledger);
	if (unmatchedTransactions.length === 0 && orphanDocuments.length === 0) {
		return "Nothing missing: every transaction is matched or decided, every extracted document is matched.\n";
	}

	const lines: string[] = [];
	if (unmatchedTransactions.length > 0) {
		lines.push(
			`Unmatched transactions (${unmatchedTransactions.length}) — chase a receipt or record a decision:`
		);
		for (const transaction of unmatchedTransactions) {
			const vendor = transaction.counterparty || transaction.reference || "(unknown)";
			lines.push(`  ${transaction.bookedAt}  ${formatMoney(transaction.amount)}  ${vendor}`);
		}
	}
	if (orphanDocuments.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(
			`Orphan documents (${orphanDocuments.length}) — extracted but no matching transaction:`
		);
		for (const document of orphanDocuments) {
			const extraction = ledger.extractions[document.id];
			const vendor = extraction?.party ?? "(unknown)";
			const amount = extraction ? formatMoney(extraction.total) : "";
			const date = extraction?.issuedAt ?? "";
			lines.push(`  ${date}  ${amount}  ${vendor}  (${document.filename})`);
		}
	}
	return `${lines.join("\n")}\n`;
}

export function formatMissingJson(ledger: Ledger): string {
	const { unmatchedTransactions, orphanDocuments } = summary(ledger);
	const documents = orphanDocuments.map((document) => ({
		id: document.id,
		filename: document.filename,
		extraction: ledger.extractions[document.id] ?? null,
	}));
	return `${JSON.stringify({ unmatchedTransactions, orphanDocuments: documents }, null, 2)}\n`;
}
