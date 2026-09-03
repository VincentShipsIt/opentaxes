export interface ExtractionPromptOptions {
	/** The ledger owner's own business name, so the model never mistakes it for the counterparty. */
	readonly selfName?: string;
}

/**
 * Prompt for the `record_extraction` tool call. Money comes back as a decimal string plus a
 * currency code because that is what a document actually prints — the extractor converts it
 * to minor units afterward, where a currency's decimal precision (e.g. JPY has none) is known.
 */
export function buildExtractionPrompt(options: ExtractionPromptOptions = {}): string {
	const { selfName } = options;
	const selfHint = selfName
		? `The ledger owner's own business is "${selfName}". Never report it as the party — it is never its own counterparty.`
		: "The ledger owner's own business name was not provided. Use context (letterhead position, " +
			'"bill to" vs "from") to tell the two businesses apart.';

	return [
		"You are extracting structured data from a single financial document (an invoice, receipt,",
		"credit note, or statement) so it can be reconciled against a bank transaction.",
		"",
		"Call the `record_extraction` tool exactly once with these fields:",
		"",
		"- kind: the document type — invoice, receipt, credit_note, statement, or other.",
		'- side: "expense" if the ledger owner is the buyer being billed, "revenue" if the ledger',
		`  owner is the seller issuing the bill. ${selfHint}`,
		"- party: the counterparty's name — the vendor for an expense, the customer for revenue.",
		"  Never the ledger owner's own business name.",
		"- issuedAt: the document's issue date (not a due date or payment date), as YYYY-MM-DD.",
		"- total: the grand total actually paid or owed, including any tax, as a decimal amount",
		'  string (e.g. "1234.56") plus its ISO 4217 currency code (e.g. "USD").',
		"- tax: the tax portion of the total, in the same decimal-amount-plus-currency-code form,",
		"  or null when the document shows no separate tax line.",
		"- number: the document's invoice or receipt number, or null when it has none.",
		'- category: a short spending category guess (e.g. "software", "travel"), or null when',
		"  unclear.",
		"- confidence: a number from 0 to 1 reflecting how legible and unambiguous the document is —",
		"  lower it for blurry scans, cut-off totals, or any field you had to guess.",
		"",
		"Read every field directly from the document. Do not invent values that are not present.",
	].join("\n");
}
