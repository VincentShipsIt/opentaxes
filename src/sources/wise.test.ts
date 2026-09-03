import { describe, expect, test } from "bun:test";
import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIsoDate, parseMonth } from "../core/dates.ts";
import { currency, money } from "../core/money.ts";
import type { TransactionId } from "../core/types.ts";
import { createWiseSource } from "./wise.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/wise/", import.meta.url));

function fixture(name: string): unknown {
	return JSON.parse(readFileSync(`${FIXTURES_DIR}${name}`, "utf8"));
}

const PROFILES = fixture("profiles.json");
const BALANCES = fixture("balances.json");
const STATEMENTS: Record<string, unknown> = {
	EUR: fixture("statement-eur.json"),
	USD: fixture("statement-usd.json"),
	JPY: fixture("statement-jpy.json"),
};

const MONTH = parseMonth("2026-08");

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
	const headers = init?.headers;
	if (!headers || Array.isArray(headers) || headers instanceof Headers) return undefined;
	const record = headers as Record<string, string>;
	return record[name];
}

/** Routes profile/balance/statement lookups against the synthetic fixtures, recording every URL requested. */
function makeFetch(requested: string[]): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = new URL(String(input));
		requested.push(url.toString());
		if (url.pathname === "/v2/profiles") return jsonResponse(PROFILES);
		if (url.pathname.endsWith("/balances")) return jsonResponse(BALANCES);
		if (url.pathname.endsWith("/statement.json")) {
			const currency = url.searchParams.get("currency") ?? "";
			return jsonResponse(STATEMENTS[currency] ?? { transactions: [] });
		}
		if (url.pathname.endsWith("/statement.pdf")) {
			return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), {
				status: 200,
				headers: { "content-type": "application/pdf" },
			});
		}
		throw new Error(`unexpected fetch in test: ${url.toString()}`);
	}) as typeof fetch;
}

describe("createWiseSource", () => {
	test("resolves the business profile when profileId is omitted", async () => {
		const requested: string[] = [];
		const source = createWiseSource({ token: "test-token", fetch: makeFetch(requested) });
		await source.fetchTransactions(MONTH);
		const balancesCall = requested.find((url) => url.includes("/balances"));
		expect(balancesCall).toContain("/profiles/20020002/balances");
	});

	test("filters balances by the currencies option", async () => {
		const requested: string[] = [];
		const source = createWiseSource({
			token: "test-token",
			currencies: ["eur"],
			fetch: makeFetch(requested),
		});
		await source.fetchTransactions(MONTH);
		const statementCalls = requested.filter((url) => url.includes("/statement.json"));
		expect(statementCalls).toHaveLength(1);
		expect(statementCalls[0]).toContain("currency=EUR");
	});

	test("maps a debit to direction out and a credit to direction in", async () => {
		const requested: string[] = [];
		const source = createWiseSource({
			token: "test-token",
			currencies: ["EUR"],
			fetch: makeFetch(requested),
		});
		const transactions = await source.fetchTransactions(MONTH);
		expect(transactions).toHaveLength(2);

		const debit = transactions.find((t) => t.id === "wise:TRANSFER-EUR-0001");
		expect(debit).toBeDefined();
		expect(debit?.direction).toBe("out");
		expect(debit?.amount).toEqual(money(12850, currency("EUR")));
		expect(debit?.counterparty).toBe("Acme Supplies Ltd");
		expect(debit?.reference).toBe("To Acme Supplies Ltd");
		expect(debit?.bookedAt).toBe(parseIsoDate("2026-08-04"));
		expect(debit?.original).toBeUndefined();

		const credit = transactions.find((t) => t.id === "wise:TRANSFER-EUR-0002");
		expect(credit).toBeDefined();
		expect(credit?.direction).toBe("in");
		expect(credit?.amount).toEqual(money(64000, currency("EUR")));
		expect(credit?.counterparty).toBe("Nova Client GmbH");
		expect(credit?.reference).toBe("Invoice payment");
	});

	test("maps a zero-decimal currency without scaling the amount", async () => {
		const requested: string[] = [];
		const source = createWiseSource({
			token: "test-token",
			currencies: ["JPY"],
			fetch: makeFetch(requested),
		});
		const transactions = await source.fetchTransactions(MONTH);
		expect(transactions).toHaveLength(1);
		expect(transactions[0]?.amount).toEqual(money(5000, currency("JPY")));
		expect(transactions[0]?.direction).toBe("out");
	});

	test("carries the original counterparty-currency amount for a converted card charge", async () => {
		const requested: string[] = [];
		const source = createWiseSource({
			token: "test-token",
			currencies: ["USD"],
			fetch: makeFetch(requested),
		});
		const transactions = await source.fetchTransactions(MONTH);
		const charge = transactions.find((t) => t.id === "wise:CARD_TRANSACTION-77001");
		expect(charge).toBeDefined();
		expect(charge?.amount).toEqual(money(10324, currency("USD")));
		expect(charge?.original).toEqual(money(8888, currency("EUR")));
	});

	test("ids are stable across runs", async () => {
		const first = await createWiseSource({
			token: "test-token",
			currencies: ["EUR"],
			fetch: makeFetch([]),
		}).fetchTransactions(MONTH);
		const second = await createWiseSource({
			token: "test-token",
			currencies: ["EUR"],
			fetch: makeFetch([]),
		}).fetchTransactions(MONTH);
		expect(first.map((t) => t.id).sort()).toEqual(second.map((t) => t.id).sort());
	});

	test("dedupes by id across balances", async () => {
		const source = createWiseSource({ token: "test-token", fetch: makeFetch([]) });
		const transactions = await source.fetchTransactions(MONTH);
		const ids = transactions.map((t) => t.id);
		expect(ids).toHaveLength(new Set(ids).size);
		expect(ids).toEqual(
			[
				"wise:TRANSFER-EUR-0001",
				"wise:TRANSFER-EUR-0002",
				"wise:CARD_TRANSACTION-77001",
				"wise:DIRECT_DEBIT-38301689",
			].map((id) => id as TransactionId)
		);
	});

	test("sends the calendar month bounds as the statement interval", async () => {
		const requested: string[] = [];
		const source = createWiseSource({
			token: "test-token",
			currencies: ["EUR"],
			fetch: makeFetch(requested),
		});
		await source.fetchTransactions(MONTH);
		const call = new URL(requested.find((url) => url.includes("/statement.json")) ?? "");
		expect(call.searchParams.get("intervalStart")).toBe("2026-08-01T00:00:00.000Z");
		expect(call.searchParams.get("intervalEnd")).toBe("2026-08-31T23:59:59.999Z");
		expect(call.searchParams.get("type")).toBe("COMPACT");
	});

	test("emits one PDF statement document per balance", async () => {
		const source = createWiseSource({
			token: "test-token",
			currencies: ["EUR"],
			fetch: makeFetch([]),
		});
		const documents = await source.fetchDocuments(MONTH);
		expect(documents).toHaveLength(1);
		const [doc] = documents;
		expect(doc?.filename).toBe("wise-statement-2026-08-EUR.pdf");
		expect(doc?.mime).toBe("application/pdf");
		expect(doc?.origin).toEqual({ kind: "statement", source: "wise", account: "EUR" });
		expect(doc?.bytes.length).toBeGreaterThan(0);
		expect(doc?.extraction).toEqual({
			kind: "statement",
			side: "expense",
			party: "Wise",
			issuedAt: parseIsoDate("2026-08-31"),
			total: money(0, currency("EUR")),
			tax: null,
			number: null,
			category: null,
			confidence: 1,
			by: "source",
		});
	});

	test("throws with the status and Wise error message, never the token", async () => {
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ errors: [{ message: "token is invalid or disabled" }] }), {
				status: 401,
			})) as unknown as typeof fetch;
		const source = createWiseSource({ token: "super-secret-token", fetch: fetchImpl });
		await expect(source.fetchTransactions(MONTH)).rejects.toThrow(
			"Wise API error 401: token is invalid or disabled"
		);
		try {
			await source.fetchTransactions(MONTH);
			throw new Error("expected fetchTransactions to throw");
		} catch (error) {
			expect(String(error)).not.toContain("super-secret-token");
		}
	});

	test("retries a statement request with a signed one-time-token after a 403 SCA challenge", async () => {
		const { publicKey, privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			publicKeyEncoding: { type: "spki", format: "pem" },
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
		});
		const keyDir = mkdtempSync(join(tmpdir(), "opentaxes-wise-sca-"));
		const keyPath = join(keyDir, "wise-sca.pem");
		writeFileSync(keyPath, privateKey);

		const oneTimeToken = "ott-1234567890";
		let attempts = 0;
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (!url.pathname.endsWith("/statement.json")) {
				if (url.pathname === "/v2/profiles") return jsonResponse(PROFILES);
				return jsonResponse(BALANCES);
			}
			attempts += 1;
			const approval = headerValue(init, "x-2fa-approval");
			const signature = headerValue(init, "X-Signature");
			if (!approval || !signature) {
				return new Response(null, {
					status: 403,
					headers: { "x-2fa-approval": oneTimeToken },
				});
			}
			const verifier = createSign("RSA-SHA256");
			verifier.update(approval);
			verifier.end();
			const expected = verifier.sign(privateKey).toString("base64");
			if (approval !== oneTimeToken || signature !== expected) {
				return new Response(null, { status: 403 });
			}
			const check = createVerify("RSA-SHA256");
			check.update(approval);
			check.end();
			expect(check.verify(publicKey, signature, "base64")).toBe(true);
			return jsonResponse(STATEMENTS.EUR);
		}) as typeof fetch;

		const source = createWiseSource({
			token: "test-token",
			currencies: ["EUR"],
			privateKeyPath: keyPath,
			fetch: fetchImpl,
		});
		const transactions = await source.fetchTransactions(MONTH);
		expect(attempts).toBe(2);
		expect(transactions).toHaveLength(2);
	});

	test("explains what to upload to Wise when no private key is configured for an SCA challenge", async () => {
		const fetchImpl = (async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.pathname === "/v2/profiles") return jsonResponse(PROFILES);
			if (url.pathname.endsWith("/balances")) return jsonResponse(BALANCES);
			return new Response(null, { status: 403, headers: { "x-2fa-approval": "ott-abc" } });
		}) as typeof fetch;
		const source = createWiseSource({ token: "test-token", currencies: ["EUR"], fetch: fetchImpl });
		await expect(source.fetchTransactions(MONTH)).rejects.toThrow(/WISE_PRIVATE_KEY_PATH/);
	});
});
