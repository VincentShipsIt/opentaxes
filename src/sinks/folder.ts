import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import type { PublishInput, PublishResult, Sink } from "../core/registry.ts";
import type { DocumentId } from "../core/types.ts";
import {
	documentFolder,
	monthPath,
	orphanDocumentRecords,
	reconciliationCsv,
	unmatchedDocumentsCsv,
} from "./layout.ts";

export interface FolderSinkOptions {
	readonly path: string;
}

const CSV_FILENAME = "reconciliation.csv";
const UNMATCHED_FILENAME = "unmatched-documents.csv";
const LEDGER_FILENAME = "ledger.json";

/**
 * Writes `<path>/<YYYY>/<MM>/<folder>/<filename>` for every document, plus a reconciliation
 * CSV, an unmatched-documents CSV (only written while at least one orphan exists), and a
 * ledger.json copy in the month folder. A document is unchanged when the sha256 of the file
 * already on disk matches its (content-addressed) document id; the CSVs/JSON are rewritten
 * only when their content actually differs.
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
				const existingHash = await fileHash(target);
				if (existingHash === document.id) {
					unchanged += 1;
					continue;
				}
				const bytes = await input.readDocument(document);
				await writeFile(target, bytes);
				created += 1;
			}

			await mkdir(monthDir, { recursive: true });
			const csv = reconciliationCsv(input.ledger, input.filenames);
			const csvChanged = await writeIfChanged(nodePath.join(monthDir, CSV_FILENAME), csv);

			const orphans = orphanDocumentRecords(input.ledger, input.filenames);
			const unmatchedChanged =
				orphans.length > 0
					? await writeIfChanged(
							nodePath.join(monthDir, UNMATCHED_FILENAME),
							unmatchedDocumentsCsv(input.ledger, input.filenames)
						)
					: null;

			const json = `${JSON.stringify(input.ledger, null, "\t")}\n`;
			const jsonChanged = await writeIfChanged(nodePath.join(monthDir, LEDGER_FILENAME), json);

			return {
				sink: "folder",
				created:
					created +
					(csvChanged ? 1 : 0) +
					(unmatchedChanged === true ? 1 : 0) +
					(jsonChanged ? 1 : 0),
				unchanged:
					unchanged +
					(csvChanged ? 0 : 1) +
					(unmatchedChanged === false ? 1 : 0) +
					(jsonChanged ? 0 : 1),
			};
		},
	};
}

async function fileHash(target: string): Promise<string | null> {
	try {
		const data = await readFile(target);
		return createHash("sha256").update(data).digest("hex");
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
