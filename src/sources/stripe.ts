import { isInMonth, monthBounds, toIsoDate } from "../core/dates.ts";
import { currency, decimalsOf, money } from "../core/money.ts";
import type { DocumentSource, FetchedDocument } from "../core/registry.ts";
import type { Currency, Extraction, Month } from "../core/types.ts";

const PAGE_SIZE = 100;
const CSV_HEADER = "payout id,arrival date,currency,gross,fees,net,transaction count";

export interface ListPage<T> {
	readonly data: readonly T[];
	readonly has_more: boolean;
}

export interface StripeInvoiceLike {
	readonly id: string;
	readonly number: string | null;
	readonly status: string | null;
	readonly status_transitions: { readonly paid_at: number | null };
	readonly currency: string;
	readonly total: number;
	readonly total_excluding_tax: number | null;
	readonly customer: string | { readonly id: string } | null;
	readonly customer_name: string | null;
	readonly customer_email: string | null;
	// Optional to match the real `stripe` package's `Invoice.invoice_pdf`, so a live Stripe
	// client satisfies this interface structurally with no cast at the registry call site.
	readonly invoice_pdf?: string | null;
}

export interface StripePayoutLike {
	readonly id: string;
	readonly currency: string;
	readonly arrival_date: number;
}

export interface StripeBalanceTransactionLike {
	readonly id: string;
	readonly amount: number;
	readonly fee: number;
	readonly net: number;
}

/**
 * The subset of the `stripe` package's client surface this source needs, declared locally so
 * a real `Stripe` instance satisfies it structurally and tests can pass lightweight fakes.
 */
export interface StripeClient {
	readonly invoices: {
		list(params: {
			readonly status?: "paid";
			readonly created?: { readonly gte?: number; readonly lte?: number };
			readonly limit?: number;
			readonly starting_after?: string;
		}): Promise<ListPage<StripeInvoiceLike>>;
	};
	readonly payouts: {
		list(params: {
			readonly arrival_date?: { readonly gte?: number; readonly lte?: number };
			readonly limit?: number;
			readonly starting_after?: string;
		}): Promise<ListPage<StripePayoutLike>>;
	};
	readonly balanceTransactions: {
		list(params: {
			readonly payout: string;
			readonly limit?: number;
			readonly starting_after?: string;
		}): Promise<ListPage<StripeBalanceTransactionLike>>;
	};
}

export interface StripeSourceOptions {
	readonly stripe: StripeClient;
	readonly fetch?: typeof fetch;
	readonly log?: (message: string) => void;
}

export function createStripeSource(options: StripeSourceOptions): DocumentSource {
	const { stripe } = options;
	const fetchImpl = options.fetch ?? fetch;
	const log = options.log ?? (() => {});

	return {
		name: "stripe",
		async fetchDocuments(month: Month): Promise<readonly FetchedDocument[]> {
			const invoiceDocs = await fetchPaidInvoiceDocuments(stripe, fetchImpl, log, month);
			const payoutDocs = await fetchPayoutStatementDocuments(stripe, month);
			return [...invoiceDocs, ...payoutDocs];
		},
	};
}

async function paginate<T extends { readonly id: string }>(
	fetchPage: (params: {
		readonly limit: number;
		readonly starting_after?: string;
	}) => Promise<ListPage<T>>
): Promise<T[]> {
	const items: T[] = [];
	let startingAfter: string | undefined;
	for (;;) {
		const page = await fetchPage(
			startingAfter === undefined
				? { limit: PAGE_SIZE }
				: { limit: PAGE_SIZE, starting_after: startingAfter }
		);
		items.push(...page.data);
		const last = page.data.at(-1);
		if (!page.has_more || !last) return items;
		startingAfter = last.id;
	}
}

function dedupeById<T extends { readonly id: string }>(items: readonly T[]): T[] {
	const byId = new Map<string, T>();
	for (const item of items) byId.set(item.id, item);
	return [...byId.values()];
}

function startOfDayUnix(date: string): number {
	return Math.floor(Date.parse(`${date}T00:00:00.000Z`) / 1000);
}

function endOfDayUnix(date: string): number {
	return Math.floor(Date.parse(`${date}T23:59:59.000Z`) / 1000);
}

function oneYearBeforeUnix(date: string): number {
	const start = new Date(`${date}T00:00:00.000Z`);
	return Math.floor(
		Date.UTC(start.getUTCFullYear() - 1, start.getUTCMonth(), start.getUTCDate()) / 1000
	);
}

function isUnixInMonth(unixSeconds: number, month: Month): boolean {
	return isInMonth(toIsoDate(new Date(unixSeconds * 1000)), month);
}

function customerIdOf(customer: StripeInvoiceLike["customer"]): string | null {
	if (customer === null) return null;
	return typeof customer === "string" ? customer : customer.id;
}

/**
 * The current Invoice object has no top-level `tax` field (verified against
 * docs.stripe.com/api/invoices/object); tax is the gap between `total` and `total_excluding_tax`.
 */
function taxOf(invoice: StripeInvoiceLike, cur: Currency): Extraction["tax"] {
	if (invoice.total_excluding_tax === null) return null;
	return money(invoice.total - invoice.total_excluding_tax, cur);
}

async function fetchPaidInvoiceDocuments(
	stripe: StripeClient,
	fetchImpl: typeof fetch,
	log: (message: string) => void,
	month: Month
): Promise<readonly FetchedDocument[]> {
	const bounds = monthBounds(month);

	// paid_at is always >= created, so filtering on created gives a safe upper bound: it can
	// never exclude an invoice that was genuinely paid inside the target month.
	const createdBefore = endOfDayUnix(bounds.end);
	// An invoice paid more than a year after it was created is not something this tool
	// reconciles, so bound the listing to the last year instead of the whole account history.
	const createdAfter = oneYearBeforeUnix(bounds.start);
	const all = await paginate<StripeInvoiceLike>((params) =>
		stripe.invoices.list({
			...params,
			status: "paid",
			created: { gte: createdAfter, lte: createdBefore },
		})
	);

	const paidInMonth = dedupeById(all).filter((invoice) => {
		const paidAt = invoice.status_transitions.paid_at;
		return invoice.status === "paid" && paidAt !== null && isUnixInMonth(paidAt, month);
	});

	const documents: FetchedDocument[] = [];
	for (const invoice of paidInMonth) {
		const paidAt = invoice.status_transitions.paid_at;
		if (paidAt === null) continue;
		if (!invoice.invoice_pdf) {
			log(`stripe invoice ${invoice.id} has no invoice_pdf, skipping`);
			continue;
		}

		let bytes: Uint8Array;
		try {
			const response = await fetchImpl(invoice.invoice_pdf);
			if (!response.ok) throw new Error(`status ${response.status}`);
			bytes = new Uint8Array(await response.arrayBuffer());
		} catch (error) {
			log(`stripe invoice ${invoice.id} PDF download failed: ${String(error)}`);
			continue;
		}

		const cur = currency(invoice.currency);
		const party =
			invoice.customer_name ??
			invoice.customer_email ??
			customerIdOf(invoice.customer) ??
			"unknown";
		const extraction: Extraction = {
			kind: "invoice",
			side: "revenue",
			party,
			issuedAt: toIsoDate(new Date(paidAt * 1000)),
			total: money(invoice.total, cur),
			tax: taxOf(invoice, cur),
			number: invoice.number,
			category: null,
			confidence: 1,
			by: "source",
		};

		documents.push({
			origin: { kind: "stripe", invoiceId: invoice.id },
			filename: `${invoice.number ?? invoice.id}.pdf`,
			mime: "application/pdf",
			bytes,
			extraction,
		});
	}
	return documents;
}

interface PayoutRow {
	readonly payoutId: string;
	readonly arrivalDate: string;
	readonly currency: Currency;
	readonly gross: number;
	readonly fees: number;
	readonly net: number;
	readonly transactionCount: number;
}

async function fetchPayoutStatementDocuments(
	stripe: StripeClient,
	month: Month
): Promise<readonly FetchedDocument[]> {
	const bounds = monthBounds(month);
	const gte = startOfDayUnix(bounds.start);
	const lte = endOfDayUnix(bounds.end);

	const allPayouts = await paginate<StripePayoutLike>((params) =>
		stripe.payouts.list({ ...params, arrival_date: { gte, lte } })
	);
	const payoutsInMonth = dedupeById(allPayouts).filter((payout) =>
		isUnixInMonth(payout.arrival_date, month)
	);

	const rows: PayoutRow[] = [];
	for (const payout of payoutsInMonth) {
		const transactions = dedupeById(
			await paginate<StripeBalanceTransactionLike>((params) =>
				stripe.balanceTransactions.list({ ...params, payout: payout.id })
			)
		);
		rows.push({
			payoutId: payout.id,
			arrivalDate: toIsoDate(new Date(payout.arrival_date * 1000)),
			currency: currency(payout.currency),
			gross: sumBy(transactions, (t) => t.amount),
			fees: sumBy(transactions, (t) => t.fee),
			net: sumBy(transactions, (t) => t.net),
			transactionCount: transactions.length,
		});
	}
	if (rows.length === 0) return [];

	const rowsByCurrency = new Map<Currency, PayoutRow[]>();
	for (const row of rows) {
		const bucket = rowsByCurrency.get(row.currency);
		if (bucket) bucket.push(row);
		else rowsByCurrency.set(row.currency, [row]);
	}

	// Sorted deterministically so re-running a month produces byte-identical CSVs.
	const documents: FetchedDocument[] = [];
	for (const cur of [...rowsByCurrency.keys()].sort()) {
		const group = rowsByCurrency.get(cur);
		if (!group) continue;
		const sorted = [...group].sort((a, b) =>
			a.payoutId < b.payoutId ? -1 : a.payoutId > b.payoutId ? 1 : 0
		);
		const extraction: Extraction = {
			kind: "statement",
			side: "revenue",
			party: "Stripe",
			issuedAt: bounds.end,
			total: money(
				sumBy(sorted, (row) => row.net),
				cur
			),
			tax: null,
			number: null,
			category: null,
			confidence: 1,
			by: "source",
		};
		documents.push({
			origin: { kind: "statement", source: "stripe", account: "payouts" },
			filename: `stripe-payouts-${month}.csv`,
			mime: "text/csv",
			bytes: new TextEncoder().encode(buildPayoutsCsv(sorted, cur)),
			extraction,
		});
	}
	return documents;
}

function sumBy<T>(items: readonly T[], select: (item: T) => number): number {
	return items.reduce((sum, item) => sum + select(item), 0);
}

function buildPayoutsCsv(rows: readonly PayoutRow[], cur: Currency): string {
	const lines = [CSV_HEADER];
	for (const row of rows) {
		lines.push(
			[
				csvField(row.payoutId),
				csvField(row.arrivalDate),
				csvField(row.currency),
				formatMinor(row.gross, cur),
				formatMinor(row.fees, cur),
				formatMinor(row.net, cur),
				String(row.transactionCount),
			].join(",")
		);
	}
	return `${lines.join("\n")}\n`;
}

function formatMinor(minor: number, cur: Currency): string {
	const decimals = decimalsOf(cur);
	return (minor / 10 ** decimals).toFixed(decimals);
}

function csvField(value: string): string {
	if (/["\n,]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
	return value;
}
