import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseIsoDate, parseMonth } from "./dates.ts";
import { emptyLedger } from "./ledger.ts";
import { currency, money } from "./money.ts";
import { extensionOf } from "./naming.ts";
import type { DocumentId, Ledger, Month } from "./types.ts";

function transformOrIssue<In, Out>(parse: (value: In) => Out) {
	return (value: In, ctx: z.RefinementCtx<In>): Out => {
		try {
			return parse(value);
		} catch (error) {
			ctx.addIssue({
				code: "custom",
				message: error instanceof Error ? error.message : String(error),
			});
			return z.NEVER;
		}
	};
}

const monthSchema = z.string().transform(transformOrIssue(parseMonth));
const isoDateSchema = z.string().transform(transformOrIssue(parseIsoDate));

const moneySchema = z
	.object({ minor: z.number(), currency: z.string() })
	.transform(
		transformOrIssue((value: { minor: number; currency: string }) =>
			money(value.minor, currency(value.currency))
		)
	);

const documentOriginSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("gmail"),
		messageId: z.string(),
		attachmentId: z.string(),
		from: z.string(),
		subject: z.string(),
		receivedAt: isoDateSchema,
	}),
	z.object({ kind: z.literal("stripe"), invoiceId: z.string() }),
	z.object({ kind: z.literal("statement"), source: z.string(), account: z.string() }),
	z.object({ kind: z.literal("file"), path: z.string() }),
]);

const transactionSchema = z.object({
	id: z.string(),
	source: z.string(),
	bookedAt: isoDateSchema,
	direction: z.enum(["in", "out"]),
	amount: moneySchema,
	counterparty: z.string(),
	reference: z.string(),
});

const documentSchema = z.object({
	id: z.string(),
	origin: documentOriginSchema,
	filename: z.string(),
	mime: z.string(),
	fetchedAt: isoDateSchema,
});

const extractionSchema = z.object({
	kind: z.enum(["invoice", "receipt", "credit_note", "statement", "other"]),
	side: z.enum(["expense", "revenue"]),
	party: z.string(),
	issuedAt: isoDateSchema,
	total: moneySchema,
	tax: moneySchema.nullable(),
	number: z.string().nullable(),
	category: z.string().nullable(),
	confidence: z.number().min(0).max(1),
	by: z.enum(["source", "claude", "agent"]),
});

const matchSchema = z.object({
	transactionId: z.string(),
	documentId: z.string(),
	rule: z.enum(["manual", "amount-date", "amount-date-party"]),
	score: z.number().min(0).max(1),
});

const decisionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("personal") }),
	z.object({ kind: z.literal("no-document"), reason: z.string() }),
	z.object({ kind: z.literal("duplicate"), of: z.string() }),
	z.object({ kind: z.literal("ignore"), reason: z.string() }),
]);

/**
 * Structural validation only: ids are opaque strings here, not re-derived,
 * since a saved ledger's ids were already validated when they were created.
 */
const ledgerSchema = z.object({
	month: monthSchema,
	transactions: z.record(z.string(), transactionSchema),
	documents: z.record(z.string(), documentSchema),
	extractions: z.record(z.string(), extractionSchema),
	matches: z.array(matchSchema),
	decisions: z.record(z.string(), decisionSchema),
});

const LEDGER_FILENAME = "ledger.json";
const DOCUMENTS_DIRNAME = "documents";

export class LedgerStore {
	constructor(private readonly stateDir: string) {}

	private monthDir(month: Month): string {
		return join(this.stateDir, month);
	}

	private documentsDir(month: Month): string {
		return join(this.monthDir(month), DOCUMENTS_DIRNAME);
	}

	private ledgerPath(month: Month): string {
		return join(this.monthDir(month), LEDGER_FILENAME);
	}

	async load(month: Month): Promise<Ledger> {
		let raw: string;
		try {
			raw = await readFile(this.ledgerPath(month), "utf8");
		} catch (error) {
			if (isNotFound(error)) return emptyLedger(month);
			throw error;
		}
		return ledgerSchema.parse(JSON.parse(raw)) as unknown as Ledger;
	}

	async save(ledger: Ledger): Promise<void> {
		const dir = this.monthDir(ledger.month);
		await mkdir(dir, { recursive: true });
		const finalPath = this.ledgerPath(ledger.month);
		const tempPath = join(dir, `.${LEDGER_FILENAME}.${randomUUID()}.tmp`);
		await writeFile(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
		await rename(tempPath, finalPath);
	}

	async putDocument(
		month: Month,
		bytes: Uint8Array,
		filename: string,
		mime: string
	): Promise<{ readonly id: DocumentId; readonly path: string }> {
		const id = createHash("sha256").update(bytes).digest("hex") as DocumentId;
		const ext = extensionOf(mime, filename);
		const dir = this.documentsDir(month);
		const path = join(dir, `${id}.${ext}`);
		if (!(await pathExists(path))) {
			await mkdir(dir, { recursive: true });
			const tempPath = join(dir, `.${id}.${randomUUID()}.tmp`);
			await writeFile(tempPath, bytes);
			await rename(tempPath, path);
		}
		return { id, path };
	}

	async documentPath(month: Month, id: DocumentId): Promise<string> {
		const dir = this.documentsDir(month);
		let entries: readonly string[];
		try {
			entries = await readdir(dir);
		} catch (error) {
			if (isNotFound(error)) entries = [];
			else throw error;
		}
		const match = entries.find((entry) => entry.startsWith(`${id}.`));
		if (!match) throw new Error(`document ${id} not found in ${month}`);
		return join(dir, match);
	}

	async readDocument(month: Month, id: DocumentId): Promise<Uint8Array> {
		const path = await this.documentPath(month, id);
		return readFile(path);
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (isNotFound(error)) return false;
		throw error;
	}
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
