import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMonth } from "../core/dates.ts";
import type { FetchedDocument } from "../core/registry.ts";
import {
	createStripeSource,
	type ListPage,
	type StripeBalanceTransactionLike,
	type StripeClient,
	type StripeInvoiceLike,
	type StripePayoutLike,
	type StripeSourceLog,
} from "./stripe.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/stripe/", import.meta.url));

function fixture<T>(name: string): T {
	return JSON.parse(readFileSync(`${FIXTURES_DIR}${name}`, "utf8")) as T;
}

const INVOICES = fixture<readonly StripeInvoiceLike[]>("invoices.json");
const PAYOUTS = fixture<readonly StripePayoutLike[]>("payouts.json");
const BALANCE_TRANSACTIONS = fixture<Record<string, readonly StripeBalanceTransactionLike[]>>(
	"balance-transactions.json"
);

const MONTH = parseMonth("2026-08");
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 synthetic");

function page<T>(data: readonly T[]): ListPage<T> {
	return { data, has_more: false };
}

function makeStripeClient(): {
	readonly client: StripeClient;
	readonly balanceTransactionCalls: string[];
} {
	const balanceTransactionCalls: string[] = [];
	const client: StripeClient = {
		invoices: { list: async () => page(INVOICES) },
		payouts: { list: async () => page(PAYOUTS) },
		balanceTransactions: {
			list: async (params) => {
				balanceTransactionCalls.push(params.payout);
				return page(BALANCE_TRANSACTIONS[params.payout] ?? []);
			},
		},
	};
	return { client, balanceTransactionCalls };
}

function makeFetch(failingUrls: ReadonlySet<string> = new Set()): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (failingUrls.has(url)) throw new Error("network down");
		return new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf" } });
	}) as typeof fetch;
}

function makeLog(): { readonly log: StripeSourceLog; readonly warnings: string[] } {
	const warnings: string[] = [];
	return { log: { warn: (message) => warnings.push(message) }, warnings };
}

function invoiceIdOf(doc: FetchedDocument): string {
	if (doc.origin.kind !== "stripe") throw new Error("expected a stripe invoice document");
	return doc.origin.invoiceId;
}

function invoiceDocs(docs: readonly FetchedDocument[]): FetchedDocument[] {
	return docs.filter((doc) => doc.origin.kind === "stripe");
}

function payoutStatementDocs(docs: readonly FetchedDocument[]): FetchedDocument[] {
	return docs.filter((doc) => doc.origin.kind === "statement" && doc.origin.account === "payouts");
}

describe("createStripeSource", () => {
	test("keeps only invoices paid inside the month, across the boundary", async () => {
		const { client } = makeStripeClient();
		const source = createStripeSource({ stripe: client, fetch: makeFetch() });
		const docs = await source.fetchDocuments(MONTH);
		const ids = invoiceDocs(docs).map(invoiceIdOf).sort();
		expect(ids).toEqual(["in_1001", "in_1002", "in_1003", "in_1006", "in_1007"]);
	});

	test("same invoice appearing twice in the API response yields one document", async () => {
		const { client } = makeStripeClient();
		const source = createStripeSource({ stripe: client, fetch: makeFetch() });
		const docs = await source.fetchDocuments(MONTH);
		const matches = invoiceDocs(docs).filter((doc) => invoiceIdOf(doc) === "in_1001");
		expect(matches).toHaveLength(1);
	});

	test("maps invoice fields into a source extraction, including a zero-decimal currency", async () => {
		const { client } = makeStripeClient();
		const source = createStripeSource({ stripe: client, fetch: makeFetch() });
		const docs = await source.fetchDocuments(MONTH);
		const byId = new Map(invoiceDocs(docs).map((doc) => [invoiceIdOf(doc), doc]));

		const acme = byId.get("in_1001");
		expect(acme?.filename).toBe("INV-1001.pdf");
		expect(acme?.mime).toBe("application/pdf");
		expect(acme?.extraction).toEqual({
			kind: "invoice",
			side: "revenue",
			party: "Acme Corp",
			issuedAt: "2026-08-15",
			total: { minor: 5000, currency: "USD" },
			tax: { minor: 500, currency: "USD" },
			number: "INV-1001",
			category: null,
			confidence: 1,
			by: "source",
		});

		const boundaryNoTax = byId.get("in_1002");
		expect(boundaryNoTax?.extraction?.tax).toBeNull();

		const zeroDecimal = byId.get("in_1006");
		expect(zeroDecimal?.filename).toBe("in_1006.pdf");
		expect(zeroDecimal?.extraction?.party).toBe("jpy@example.test");
		expect(zeroDecimal?.extraction?.number).toBeNull();
		expect(zeroDecimal?.extraction?.total).toEqual({ minor: 5000, currency: "JPY" });
		expect(zeroDecimal?.extraction?.tax).toEqual({ minor: 500, currency: "JPY" });

		const fallbackToId = byId.get("in_1007");
		expect(fallbackToId?.extraction?.party).toBe("cus_fallback1");
		expect(fallbackToId?.extraction?.tax).toEqual({ minor: 0, currency: "USD" });
	});

	test("isolates a single invoice PDF download failure without failing the whole fetch", async () => {
		const { client } = makeStripeClient();
		const { log, warnings } = makeLog();
		const failing = new Set(["https://files.stripe.example/invoices/in_1002.pdf"]);
		const source = createStripeSource({ stripe: client, fetch: makeFetch(failing), log });

		const docs = await source.fetchDocuments(MONTH);
		const ids = invoiceDocs(docs).map(invoiceIdOf).sort();

		expect(ids).toEqual(["in_1001", "in_1003", "in_1006", "in_1007"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("in_1002");
	});

	test("builds a payout CSV with the expected rows and totals", async () => {
		const { client } = makeStripeClient();
		const source = createStripeSource({ stripe: client, fetch: makeFetch() });
		const docs = await source.fetchDocuments(MONTH);

		const usdStatement = payoutStatementDocs(docs).find(
			(doc) => doc.extraction?.total.currency === "USD"
		);
		expect(usdStatement).toBeDefined();
		expect(usdStatement?.filename).toBe(`stripe-payouts-${MONTH}.csv`);
		expect(usdStatement?.mime).toBe("text/csv");
		expect(usdStatement?.extraction).toEqual({
			kind: "statement",
			side: "revenue",
			party: "Stripe",
			issuedAt: "2026-08-31",
			total: { minor: 16490, currency: "USD" },
			tax: null,
			number: null,
			category: null,
			confidence: 1,
			by: "source",
		});

		const csv = new TextDecoder().decode(usdStatement?.bytes);
		const lines = csv.trim().split("\n");
		expect(lines[0]).toBe("payout id,arrival date,currency,gross,fees,net,transaction count");
		expect(lines[1]).toBe("po_usd_1,2026-08-15,USD,150.00,4.50,145.50,2");
		expect(lines[2]).toBe("po_usd_2,2026-08-01,USD,20.00,0.60,19.40,1");
	});

	test("splits multi-currency payouts into one statement document per currency", async () => {
		const { client, balanceTransactionCalls } = makeStripeClient();
		const source = createStripeSource({ stripe: client, fetch: makeFetch() });
		const docs = await source.fetchDocuments(MONTH);

		const statements = payoutStatementDocs(docs);
		expect(statements).toHaveLength(2);
		const currencies = statements.map((doc) => doc.extraction?.total.currency).sort();
		expect(currencies).toEqual(["EUR", "USD"]);

		const eurStatement = statements.find((doc) => doc.extraction?.total.currency === "EUR");
		expect(eurStatement?.extraction?.total).toEqual({ minor: 7800, currency: "EUR" });

		// the payout arriving outside the month must never have its transactions queried
		expect(balanceTransactionCalls).not.toContain("po_out_of_month");
	});
});
