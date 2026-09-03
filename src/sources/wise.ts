import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { monthBounds, toIsoDate } from "../core/dates.ts";
import { currency, money, moneyFromDecimal } from "../core/money.ts";
import type { DocumentSource, FetchedDocument, TransactionSource } from "../core/registry.ts";
import type { Direction, Month, Transaction, TransactionId } from "../core/types.ts";

const DEFAULT_API_URL = "https://api.transferwise.com";
const STATEMENT_TYPE = "COMPACT";

export interface WiseSourceOptions {
	readonly token: string;
	/** Defaults to https://api.transferwise.com. Sandbox: https://api.sandbox.transferwise.tech */
	readonly apiUrl?: string;
	/** Resolved from the token's business profile when omitted. */
	readonly profileId?: string;
	/** Balance currencies to pull. All balances when omitted. */
	readonly currencies?: readonly string[];
	readonly fetch?: typeof fetch;
	/** PEM private key path for the SCA one-time-token signature. Only needed if Wise challenges statement requests. */
	readonly privateKeyPath?: string;
}

type WiseFetch = typeof fetch;

const ProfileSchema = z.object({
	id: z.union([z.string(), z.number()]),
	type: z.string(),
});

const BalanceSchema = z.object({
	id: z.union([z.string(), z.number()]),
	currency: z.string(),
});

const StatementTransactionSchema = z.object({
	referenceNumber: z.string(),
	date: z.string(),
	amount: z.object({
		value: z.number(),
		currency: z.string().optional(),
	}),
	details: z
		.object({
			description: z.string().optional(),
			paymentReference: z.string().optional(),
			senderName: z.string().optional(),
			merchant: z.object({ name: z.string().optional() }).optional(),
		})
		.optional(),
	/** Present when the balance currency isn't what the counterparty billed, e.g. a card charge abroad. */
	exchangeDetails: z
		.object({
			forAmount: z.object({
				value: z.number(),
				currency: z.string(),
			}),
		})
		.optional(),
});

const StatementSchema = z.object({
	transactions: z.array(StatementTransactionSchema),
});

interface WiseBalance {
	readonly id: string;
	readonly currency: string;
}

export function createWiseSource(options: WiseSourceOptions): TransactionSource & DocumentSource {
	const apiUrl = options.apiUrl ?? DEFAULT_API_URL;
	const fetchImpl = options.fetch ?? fetch;
	const { token, privateKeyPath, profileId, currencies } = options;

	async function balancesForMonth(): Promise<{
		readonly profileId: string;
		readonly balances: readonly WiseBalance[];
	}> {
		const resolvedProfileId = await resolveProfileId(
			fetchImpl,
			apiUrl,
			token,
			privateKeyPath,
			profileId
		);
		const balances = await listBalances(
			fetchImpl,
			apiUrl,
			token,
			privateKeyPath,
			resolvedProfileId,
			currencies
		);
		return { profileId: resolvedProfileId, balances };
	}

	return {
		name: "wise",

		async fetchTransactions(month: Month): Promise<readonly Transaction[]> {
			const { profileId: resolvedProfileId, balances } = await balancesForMonth();
			const seen = new Set<string>();
			const transactions: Transaction[] = [];
			for (const balance of balances) {
				const url = statementUrl(
					apiUrl,
					resolvedProfileId,
					balance.id,
					balance.currency,
					month,
					"json"
				);
				const statement = await wiseRequestJson(
					StatementSchema,
					fetchImpl,
					url,
					token,
					privateKeyPath
				);
				for (const entry of statement.transactions) {
					const id = `wise:${entry.referenceNumber}` as TransactionId;
					if (seen.has(id)) continue;
					seen.add(id);
					transactions.push(mapTransaction(id, entry, balance.currency));
				}
			}
			return transactions;
		},

		async fetchDocuments(month: Month): Promise<readonly FetchedDocument[]> {
			const { profileId: resolvedProfileId, balances } = await balancesForMonth();
			const documents: FetchedDocument[] = [];
			for (const balance of balances) {
				const url = statementUrl(
					apiUrl,
					resolvedProfileId,
					balance.id,
					balance.currency,
					month,
					"pdf"
				);
				const bytes = await wiseRequestBytes(fetchImpl, url, token, privateKeyPath);
				documents.push(buildStatementDocument(month, balance.currency, bytes));
			}
			return documents;
		},
	};
}

async function resolveProfileId(
	fetchImpl: WiseFetch,
	apiUrl: string,
	token: string,
	privateKeyPath: string | undefined,
	profileId: string | undefined
): Promise<string> {
	if (profileId) return profileId;
	const profiles = await wiseRequestJson(
		z.array(ProfileSchema),
		fetchImpl,
		`${apiUrl}/v2/profiles`,
		token,
		privateKeyPath
	);
	const business = profiles.find((profile) => profile.type === "business");
	if (!business) {
		throw new Error(
			"no Wise business profile found for this token; set sources.wise.profileId explicitly"
		);
	}
	return String(business.id);
}

async function listBalances(
	fetchImpl: WiseFetch,
	apiUrl: string,
	token: string,
	privateKeyPath: string | undefined,
	profileId: string,
	currencies: readonly string[] | undefined
): Promise<readonly WiseBalance[]> {
	const balances = await wiseRequestJson(
		z.array(BalanceSchema),
		fetchImpl,
		`${apiUrl}/v4/profiles/${profileId}/balances?types=STANDARD`,
		token,
		privateKeyPath
	);
	const wanted = currencies?.map((code) => code.toUpperCase());
	return balances
		.filter((balance) => !wanted || wanted.includes(balance.currency.toUpperCase()))
		.map((balance) => ({ id: String(balance.id), currency: balance.currency.toUpperCase() }));
}

function statementUrl(
	apiUrl: string,
	profileId: string,
	balanceId: string,
	currencyCode: string,
	month: Month,
	format: "json" | "pdf"
): string {
	const { start, end } = monthBounds(month);
	const params = new URLSearchParams({
		currency: currencyCode,
		intervalStart: `${start}T00:00:00.000Z`,
		intervalEnd: `${end}T23:59:59.999Z`,
		type: STATEMENT_TYPE,
	});
	return `${apiUrl}/v1/profiles/${profileId}/balance-statements/${balanceId}/statement.${format}?${params.toString()}`;
}

function mapTransaction(
	id: TransactionId,
	entry: z.infer<typeof StatementTransactionSchema>,
	balanceCurrency: string
): Transaction {
	const code = currency(entry.amount.currency ?? balanceCurrency);
	const direction: Direction = entry.amount.value < 0 ? "out" : "in";
	const counterparty = entry.details?.merchant?.name ?? entry.details?.senderName ?? "";
	const reference = entry.details?.description ?? "";
	const forAmount = entry.exchangeDetails?.forAmount;
	const original = forAmount
		? moneyFromDecimal(forAmount.value, currency(forAmount.currency))
		: undefined;
	return {
		id,
		source: "wise",
		bookedAt: toIsoDate(entry.date),
		direction,
		amount: moneyFromDecimal(entry.amount.value, code),
		...(original ? { original } : {}),
		counterparty,
		reference,
	};
}

function buildStatementDocument(
	month: Month,
	currencyCode: string,
	bytes: Uint8Array
): FetchedDocument {
	const { end } = monthBounds(month);
	return {
		origin: { kind: "statement", source: "wise", account: currencyCode },
		filename: `wise-statement-${month}-${currencyCode}.pdf`,
		mime: "application/pdf",
		bytes,
		extraction: {
			kind: "statement",
			side: "expense",
			party: "Wise",
			issuedAt: end,
			total: money(0, currency(currencyCode)),
			tax: null,
			number: null,
			category: null,
			confidence: 1,
			by: "source",
		},
	};
}

async function wiseRequestJson<T>(
	schema: z.ZodType<T>,
	fetchImpl: WiseFetch,
	url: string,
	token: string,
	privateKeyPath: string | undefined
): Promise<T> {
	const response = await wiseFetch(fetchImpl, url, token, privateKeyPath);
	if (!response.ok)
		throw new Error(`Wise API error ${response.status}: ${await readErrorMessage(response)}`);
	return schema.parse(await response.json());
}

async function wiseRequestBytes(
	fetchImpl: WiseFetch,
	url: string,
	token: string,
	privateKeyPath: string | undefined
): Promise<Uint8Array> {
	const response = await wiseFetch(fetchImpl, url, token, privateKeyPath);
	if (!response.ok)
		throw new Error(`Wise API error ${response.status}: ${await readErrorMessage(response)}`);
	return new Uint8Array(await response.arrayBuffer());
}

/**
 * Wise challenges some statement requests with Strong Customer Authentication: a 403 carries
 * the one-time-token in `x-2fa-approval`; the retry signs it with the account's registered
 * private key and resends the same header plus `X-Signature`.
 */
async function wiseFetch(
	fetchImpl: WiseFetch,
	url: string,
	token: string,
	privateKeyPath: string | undefined
): Promise<Response> {
	const first = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
	if (first.status !== 403) return first;

	const approval = first.headers.get("x-2fa-approval");
	if (!approval) return first;

	if (!privateKeyPath) {
		throw new Error(
			"Wise requires Strong Customer Authentication for this request. Set WISE_PRIVATE_KEY_PATH to a PEM private key and upload its matching public key under Wise Settings > API tokens > add SCA public key."
		);
	}

	const privateKey = await loadPrivateKey(privateKeyPath);
	const signature = signOneTimeToken(approval, privateKey);
	return fetchImpl(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			"x-2fa-approval": approval,
			"X-Signature": signature,
		},
	});
}

async function loadPrivateKey(privateKeyPath: string): Promise<string> {
	try {
		return await readFile(privateKeyPath, "utf8");
	} catch (cause) {
		throw new Error(
			`could not read Wise SCA private key at "${privateKeyPath}": upload its matching public key under Wise Settings > API tokens > add SCA public key`,
			{ cause }
		);
	}
}

function signOneTimeToken(oneTimeToken: string, privateKeyPem: string): string {
	const signer = createSign("RSA-SHA256");
	signer.update(oneTimeToken);
	signer.end();
	return signer.sign(privateKeyPem).toString("base64");
}

async function readErrorMessage(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	if (!text) return response.statusText || `HTTP ${response.status}`;
	try {
		return extractErrorMessage(JSON.parse(text)) ?? text;
	} catch {
		return text;
	}
}

function extractErrorMessage(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const record = body as Record<string, unknown>;
	if (Array.isArray(record.errors)) {
		const first = record.errors[0];
		if (first && typeof first === "object" && "message" in first) {
			const message = (first as Record<string, unknown>).message;
			if (typeof message === "string") return message;
		}
	}
	if (typeof record.error_description === "string") return record.error_description;
	if (typeof record.message === "string") return record.message;
	return null;
}
