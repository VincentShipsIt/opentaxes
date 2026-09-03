import { toIsoDate } from "../core/dates.ts";
import type { DocumentSource, FetchedDocument } from "../core/registry.ts";
import type { Month } from "../core/types.ts";

const MIN_ATTACHMENT_BYTES = 1024;

const DEFAULT_DOCUMENT_TERMS =
	'has:attachment filename:pdf (invoice OR receipt OR facture OR reçu OR "payment confirmation" OR "order confirmation")';

/** The subset of the Gmail v1 client (`google.gmail({ version: "v1", auth })`) this source calls. */
export interface GmailClient {
	readonly users: {
		readonly messages: {
			list(params: GmailListParams): Promise<{ readonly data: GmailListResponse }>;
			get(params: GmailGetParams): Promise<{ readonly data: GmailMessage }>;
			readonly attachments: {
				get(params: GmailAttachmentParams): Promise<{ readonly data: GmailAttachmentData }>;
			};
		};
	};
}

export interface GmailListParams {
	readonly userId: string;
	readonly q: string;
	readonly pageToken?: string;
}

export interface GmailListResponse {
	readonly messages?: readonly { readonly id?: string | null }[] | null;
	readonly nextPageToken?: string | null;
}

export interface GmailGetParams {
	readonly userId: string;
	readonly id: string;
	readonly format: string;
}

export interface GmailMessagePartHeader {
	readonly name?: string | null;
	readonly value?: string | null;
}

export interface GmailMessagePartBody {
	readonly attachmentId?: string | null;
	readonly data?: string | null;
	readonly size?: number | null;
}

export interface GmailMessagePart {
	readonly mimeType?: string | null;
	readonly filename?: string | null;
	readonly body?: GmailMessagePartBody;
	readonly headers?: readonly GmailMessagePartHeader[];
	readonly parts?: readonly GmailMessagePart[];
}

export interface GmailMessage {
	readonly id?: string | null;
	readonly internalDate?: string | null;
	readonly payload?: GmailMessagePart;
}

export interface GmailAttachmentParams {
	readonly userId: string;
	readonly messageId: string;
	readonly id: string;
}

export interface GmailAttachmentData {
	readonly data?: string | null;
	readonly size?: number | null;
}

export interface GmailSourceOptions {
	readonly gmail: GmailClient;
	/** Sender addresses or domains known to send invoices, OR'd into the query. */
	readonly senders?: readonly string[];
	/** Extra Gmail search terms appended verbatim to the default receipt query. */
	readonly query?: string;
	readonly log?: (message: string) => void;
}

export interface GmailQueryOptions {
	readonly month: Month;
	readonly senders?: readonly string[];
	readonly query?: string;
}

/** Pure query builder, scoped to the month and, optionally, known invoice senders. */
export function buildGmailQuery(options: GmailQueryOptions): string {
	const parts = [
		DEFAULT_DOCUMENT_TERMS,
		`after:${toGmailDate(firstDayOf(options.month))}`,
		`before:${toGmailDate(firstDayOfNextMonth(options.month))}`,
	];
	if (options.senders !== undefined && options.senders.length > 0) {
		parts.push(`from:(${options.senders.join(" OR ")})`);
	}
	if (options.query !== undefined && options.query.length > 0) {
		parts.push(options.query);
	}
	return parts.join(" ");
}

export function decodeBase64Url(data: string): Uint8Array {
	return Buffer.from(data, "base64url");
}

export function createGmailSource(options: GmailSourceOptions): DocumentSource {
	const log = options.log ?? (() => {});

	return {
		name: "gmail",
		async fetchDocuments(month: Month): Promise<readonly FetchedDocument[]> {
			const q = buildGmailQuery({
				month,
				...(options.senders !== undefined ? { senders: options.senders } : {}),
				...(options.query !== undefined ? { query: options.query } : {}),
			});
			const ids = await listAllMessageIds(options.gmail, q);
			const documents: FetchedDocument[] = [];

			for (const id of ids) {
				try {
					const { data: message } = await options.gmail.users.messages.get({
						userId: "me",
						id,
						format: "full",
					});
					for (const part of walkParts(message.payload)) {
						if (!isPdfPart(part)) continue;
						const document = await toFetchedDocument(options.gmail, message, part);
						if (document !== null) documents.push(document);
					}
				} catch (error) {
					log(`gmail: skipping message ${id}: ${errorMessage(error)}`);
				}
			}

			return documents;
		},
	};
}

async function listAllMessageIds(gmail: GmailClient, q: string): Promise<readonly string[]> {
	const ids: string[] = [];
	let pageToken: string | undefined;

	do {
		const { data } = await (pageToken === undefined
			? gmail.users.messages.list({ userId: "me", q })
			: gmail.users.messages.list({ userId: "me", q, pageToken }));
		for (const message of data.messages ?? []) {
			if (message.id !== null && message.id !== undefined) ids.push(message.id);
		}
		pageToken = data.nextPageToken ?? undefined;
	} while (pageToken !== undefined);

	return ids;
}

function* walkParts(part: GmailMessagePart | undefined): Generator<GmailMessagePart> {
	if (part === undefined) return;
	yield part;
	for (const child of part.parts ?? []) {
		yield* walkParts(child);
	}
}

function isPdfPart(part: GmailMessagePart): boolean {
	if (part.mimeType?.toLowerCase() === "application/pdf") return true;
	return part.filename?.toLowerCase().endsWith(".pdf") ?? false;
}

async function toFetchedDocument(
	gmail: GmailClient,
	message: GmailMessage,
	part: GmailMessagePart
): Promise<FetchedDocument | null> {
	const knownSize = part.body?.size;
	if (typeof knownSize === "number" && knownSize < MIN_ATTACHMENT_BYTES) return null;

	const attachmentId = part.body?.attachmentId;
	if (attachmentId === null || attachmentId === undefined) return null;

	const messageId = message.id;
	if (messageId === null || messageId === undefined) return null;

	const attachment = await gmail.users.messages.attachments.get({
		userId: "me",
		messageId,
		id: attachmentId,
	});
	if (attachment.data.data === null || attachment.data.data === undefined) return null;

	const bytes = decodeBase64Url(attachment.data.data);
	if (bytes.length < MIN_ATTACHMENT_BYTES) return null;

	const headers = message.payload?.headers;
	const filename =
		part.filename !== null && part.filename !== undefined && part.filename.length > 0
			? part.filename
			: "attachment.pdf";

	return {
		origin: {
			kind: "gmail",
			messageId,
			attachmentId,
			from: headerValue(headers, "From"),
			subject: headerValue(headers, "Subject"),
			receivedAt: toIsoDate(new Date(Number(message.internalDate ?? 0))),
		},
		filename,
		mime: "application/pdf",
		bytes,
	};
}

function headerValue(headers: readonly GmailMessagePartHeader[] | undefined, name: string): string {
	const header = headers?.find((candidate) => candidate.name?.toLowerCase() === name.toLowerCase());
	return header?.value ?? "";
}

function firstDayOf(month: Month): Date {
	const [year, monthNumber] = month.split("-").map(Number) as [number, number];
	return new Date(Date.UTC(year, monthNumber - 1, 1));
}

function firstDayOfNextMonth(month: Month): Date {
	const [year, monthNumber] = month.split("-").map(Number) as [number, number];
	return new Date(Date.UTC(year, monthNumber, 1));
}

function toGmailDate(date: Date): string {
	return toIsoDate(date).replaceAll("-", "/");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
