import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Auth, drive_v3, sheets_v4 } from "googleapis";
import { google } from "googleapis";
import Stripe from "stripe";
import { createClaudeExtractor } from "../extractors/claude.ts";
import { createDriveSink } from "../sinks/drive.ts";
import { createFolderSink } from "../sinks/folder.ts";
import { createSheetsSink } from "../sinks/sheets.ts";
import { createFolderSource } from "../sources/folder.ts";
import type { GmailClient } from "../sources/gmail.ts";
import { createGmailSource } from "../sources/gmail.ts";
import { createGoogleAuth, type GoogleAuth } from "../sources/google-auth.ts";
import { createStripeSource } from "../sources/stripe.ts";
import { createWiseSource } from "../sources/wise.ts";
import { createWiseCsvSource } from "../sources/wise-csv.ts";
import type { Config } from "./config.ts";
import type { Env } from "./env.ts";
import type { Document, DocumentOrigin, Extraction, Ledger, Month, Transaction } from "./types.ts";

/** A document as a source hands it over, before the store assigns its content id. */
export interface FetchedDocument {
	readonly origin: DocumentOrigin;
	readonly filename: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
	/** Sources that already know the totals (Stripe, statements) fill this in. */
	readonly extraction?: Extraction;
}

export interface TransactionSource {
	readonly name: string;
	fetchTransactions(month: Month): Promise<readonly Transaction[]>;
}

export interface DocumentSource {
	readonly name: string;
	fetchDocuments(month: Month): Promise<readonly FetchedDocument[]>;
}

export interface Extractor {
	readonly name: string;
	extract(document: Document, bytes: Uint8Array): Promise<Extraction>;
}

export interface PublishInput {
	readonly ledger: Ledger;
	/** final filename per document, from `documentFilename` in naming.ts */
	readonly filenames: Readonly<Record<string, string>>;
	readDocument(document: Document): Promise<Uint8Array>;
}

export interface PublishResult {
	readonly sink: string;
	readonly created: number;
	readonly unchanged: number;
}

export interface Sink {
	readonly name: string;
	publish(input: PublishInput): Promise<PublishResult>;
}

export interface Registry {
	readonly transactionSources: readonly TransactionSource[];
	readonly documentSources: readonly DocumentSource[];
	readonly extractor: Extractor | null;
	readonly sinks: readonly Sink[];
}

export const DEFAULT_STATE_DIR = ".opentaxes";
export const GOOGLE_TOKEN_FILENAME = "google-token.json";

interface TableEntry<T> {
	readonly when: boolean;
	readonly build: () => T;
}

function buildTable<T>(entries: readonly TableEntry<T>[]): T[] {
	return entries.filter((entry) => entry.when).map((entry) => entry.build());
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Wraps a document source so an auth/network failure logs and yields no documents instead of
 * aborting the whole fetch: `run.ts` iterates every document source in one loop with no
 * per-source try/catch, so one source's failure (e.g. a Gmail token that stopped refreshing)
 * would otherwise stop every source after it in the array.
 */
function tolerant(source: DocumentSource, log: (message: string) => void): DocumentSource {
	return {
		name: source.name,
		async fetchDocuments(month: Month): Promise<readonly FetchedDocument[]> {
			try {
				return await source.fetchDocuments(month);
			} catch (error) {
				log(`${source.name}: ${errorMessage(error)}`);
				return [];
			}
		},
	};
}

/**
 * Builds a structural client (`GmailClient`, `drive_v3.Drive`, `sheets_v4.Sheets`) that defers
 * `getReal()` — and therefore the async Google OAuth client load — until the first method is
 * actually called. `createRegistry` is synchronous, but every real client needs an awaited
 * `loadClient()` first; this proxy lets a sink or source hold what looks like a ready client
 * today and only pay for auth when it makes its first request.
 */
function lazyClient<T extends object>(getReal: () => Promise<T>): T {
	function makeProxy(path: readonly PropertyKey[]): unknown {
		return new Proxy(function lazyClientTarget() {}, {
			get(_target, prop) {
				return makeProxy([...path, prop]);
			},
			apply(_target, _thisArg, args) {
				return getReal().then((real) => {
					let receiver: unknown = real;
					for (const key of path.slice(0, -1)) {
						receiver = (receiver as Record<PropertyKey, unknown>)[key];
					}
					const method = path.at(-1);
					const fn =
						method === undefined ? undefined : (receiver as Record<PropertyKey, unknown>)[method];
					if (typeof fn !== "function") {
						throw new Error(`lazy client: "${path.map(String).join(".")}" is not a function`);
					}
					return (fn as (...callArgs: unknown[]) => unknown).apply(receiver, args);
				});
			},
		});
	}
	return makeProxy([]) as T;
}

function lazyDrive(auth: GoogleAuth): drive_v3.Drive {
	return lazyClient<drive_v3.Drive>(() =>
		auth
			.loadClient()
			.then((client: Auth.OAuth2Client) => google.drive({ version: "v3", auth: client }))
	);
}

function lazySheets(auth: GoogleAuth): sheets_v4.Sheets {
	return lazyClient<sheets_v4.Sheets>(() =>
		auth
			.loadClient()
			.then((client: Auth.OAuth2Client) => google.sheets({ version: "v4", auth: client }))
	);
}

function lazyGmail(auth: GoogleAuth): GmailClient {
	return lazyClient<GmailClient>(() =>
		auth
			.loadClient()
			.then((client: Auth.OAuth2Client) => google.gmail({ version: "v1", auth: client }))
	);
}

/** Each month gets its own tab unless the config pins one explicitly. */
export function resolveSheetName(configured: string | undefined, month: Month): string {
	return configured ?? month;
}

/**
 * Builds every adapter the config enables. This is the only place that knows adapter names; the
 * rest of the core iterates the registry.
 *
 * Extends the brief's two-argument shape with `month` (the Sheets sink needs it to default
 * `sheetName`) and an optional `log` (forwarded to every source/sink that accepts one — the CLI
 * passes its stderr writer, the MCP server passes a collector so it can return warnings).
 */
export function createRegistry(
	config: Config,
	env: Env,
	month: Month,
	log: (message: string) => void = () => {}
): Registry {
	const stateDir = env.OPENTAXES_STATE_DIR ?? DEFAULT_STATE_DIR;
	const googleAuth: GoogleAuth | null =
		env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
			? createGoogleAuth({
					clientId: env.GOOGLE_CLIENT_ID,
					clientSecret: env.GOOGLE_CLIENT_SECRET,
					tokenPath: join(stateDir, GOOGLE_TOKEN_FILENAME),
					log,
				})
			: null;
	const googleTokenPath = join(stateDir, GOOGLE_TOKEN_FILENAME);

	const wiseSource = env.WISE_API_TOKEN
		? createWiseSource({
				token: env.WISE_API_TOKEN,
				...(env.WISE_API_URL ? { apiUrl: env.WISE_API_URL } : {}),
				...(config.sources.wise?.profileId ? { profileId: config.sources.wise.profileId } : {}),
				...(config.sources.wise?.currencies ? { currencies: config.sources.wise.currencies } : {}),
				...(env.WISE_PRIVATE_KEY_PATH ? { privateKeyPath: env.WISE_PRIVATE_KEY_PATH } : {}),
			})
		: null;

	const transactionSources = buildTable<TransactionSource>([
		{ when: wiseSource !== null, build: () => wiseSource as TransactionSource },
		{
			when: config.sources.wiseCsv !== undefined,
			build: () => createWiseCsvSource({ dir: (config.sources.wiseCsv as { dir: string }).dir }),
		},
	]);

	const documentSources = buildTable<DocumentSource>([
		{ when: wiseSource !== null, build: () => wiseSource as DocumentSource },
		{
			when: googleAuth !== null && existsSync(googleTokenPath),
			build: () =>
				tolerant(createGmailSource({ gmail: lazyGmail(googleAuth as GoogleAuth), log }), log),
		},
		{
			when: env.STRIPE_SECRET_KEY !== undefined,
			build: () =>
				createStripeSource({
					stripe: new Stripe(env.STRIPE_SECRET_KEY as string),
					log,
				}),
		},
		{
			when: config.sources.folder !== undefined,
			build: () => createFolderSource({ dir: (config.sources.folder as { dir: string }).dir }),
		},
	]);

	const extractor: Extractor | null = env.ANTHROPIC_API_KEY
		? createClaudeExtractor({ apiKey: env.ANTHROPIC_API_KEY })
		: null;

	const sinks = buildTable<Sink>([
		{
			when: config.sinks.folder !== undefined,
			build: () => createFolderSink({ path: (config.sinks.folder as { path: string }).path }),
		},
		{
			when: config.sinks.drive !== undefined && googleAuth !== null,
			build: () =>
				createDriveSink({
					drive: lazyDrive(googleAuth as GoogleAuth),
					folderId: (config.sinks.drive as { folderId: string }).folderId,
				}),
		},
		{
			when: config.sinks.sheets !== undefined && googleAuth !== null,
			build: () => {
				const sheets = config.sinks.sheets as { spreadsheetId: string; sheetName?: string };
				return createSheetsSink({
					sheets: lazySheets(googleAuth as GoogleAuth),
					spreadsheetId: sheets.spreadsheetId,
					sheetName: resolveSheetName(sheets.sheetName, month),
				});
			},
		},
	]);

	return { transactionSources, documentSources, extractor, sinks };
}
