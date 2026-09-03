import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import type { PublishInput, PublishResult, Sink } from "../core/registry.ts";
import type { DocumentId } from "../core/types.ts";
import { documentFolder, monthPath, reconciliationCsv } from "./layout.ts";

export interface FolderSinkOptions {
	readonly path: string;
}

const CSV_FILENAME = "reconciliation.csv";
const LEDGER_FILENAME = "ledger.json";

/**
 * Writes `<path>/<YYYY>/<MM>/<folder>/<filename>` for every document, plus a reconciliation
 * CSV and a ledger.json copy in the month folder. Idempotent: unchanged documents are skipped
 * by byte length, and the CSV/JSON are only rewritten when their content actually differs.
 */
export function createFolderSink(options: FolderSinkOptions): Sink {
	return {
		name: "folder",
		async publish(input: PublishInput): Promise<PublishResult> {
			let created = 0;
			let unchanged = 0;

			const [year, month] = monthPath(input.ledger.month);
			const monthDir = nodePath.join(options.path, year, month);

			for (const [id, filename] of Object.entries(input.filenames)) {
				const documentId = id as DocumentId;
				const document = input.ledger.documents[documentId];
				if (!document) throw new Error(`no document for id "${id}" in filenames`);
				const folder = documentFolder(input.ledger, documentId);
				const dir = nodePath.join(monthDir, folder);
				await mkdir(dir, { recursive: true });
				const target = nodePath.join(dir, filename);
				const bytes = await input.readDocument(document);
				const existingSize = await fileSize(target);
				if (existingSize === bytes.length) {
					unchanged += 1;
					continue;
				}
				await writeFile(target, bytes);
				created += 1;
			}

			await mkdir(monthDir, { recursive: true });
			const csv = reconciliationCsv(input.ledger, input.filenames);
			const csvChanged = await writeIfChanged(nodePath.join(monthDir, CSV_FILENAME), csv);
			const json = `${JSON.stringify(input.ledger, null, "\t")}\n`;
			const jsonChanged = await writeIfChanged(nodePath.join(monthDir, LEDGER_FILENAME), json);

			return {
				sink: "folder",
				created: created + (csvChanged ? 1 : 0) + (jsonChanged ? 1 : 0),
				unchanged: unchanged + (csvChanged ? 0 : 1) + (jsonChanged ? 0 : 1),
			};
		},
	};
}

async function fileSize(target: string): Promise<number | null> {
	try {
		const info = await stat(target);
		return info.size;
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
}

async function writeIfChanged(target: string, content: string): Promise<boolean> {
	const existing = await readIfExists(target);
	if (existing === content) return false;
	await writeFile(target, content, "utf8");
	return true;
}

async function readIfExists(target: string): Promise<string | null> {
	try {
		return await readFile(target, "utf8");
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
	);
}
