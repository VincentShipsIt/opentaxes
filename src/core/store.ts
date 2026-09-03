import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyLedger } from "./ledger.ts";
import { extensionOf } from "./naming.ts";
import { LedgerSchema } from "./schemas.ts";
import type { DocumentId, Ledger, Month } from "./types.ts";

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
		return LedgerSchema.parse(JSON.parse(raw)) as unknown as Ledger;
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
