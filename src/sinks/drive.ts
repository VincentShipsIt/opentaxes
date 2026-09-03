import type { drive_v3 } from "googleapis";
import type { PublishInput, PublishResult, Sink } from "../core/registry.ts";
import type { DocumentId } from "../core/types.ts";
import {
	documentFolder,
	monthPath,
	orphanDocumentRecords,
	reconciliationCsv,
	unmatchedDocumentsCsv,
} from "./layout.ts";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const CSV_FILENAME = "reconciliation.csv";
const UNMATCHED_FILENAME = "unmatched-documents.csv";

export interface DriveSinkOptions {
	readonly drive: drive_v3.Drive;
	readonly folderId: string;
}

/**
 * Mirrors the folder sink's layout inside a Drive folder: <folderId>/<YYYY>/<MM>/<folder>/<file>,
 * with `reconciliation.csv` (and, while at least one orphan document exists, `unmatched-documents.csv`)
 * kept in the month folder. Idempotent by name: every folder and file is looked up before it is
 * created, and each CSV is updated in place rather than duplicated.
 */
export function createDriveSink(options: DriveSinkOptions): Sink {
	const { drive, folderId } = options;

	return {
		name: "drive",
		async publish(input: PublishInput): Promise<PublishResult> {
			let created = 0;
			let unchanged = 0;

			const [year, month] = monthPath(input.ledger.month);
			const yearFolderId = await findOrCreateFolder(drive, year, folderId);
			const monthFolderId = await findOrCreateFolder(drive, month, yearFolderId);
			const categoryFolders = new Map<string, string>();

			for (const [id, filename] of Object.entries(input.filenames)) {
				const documentId = id as DocumentId;
				const document = input.ledger.documents[documentId];
				if (!document) throw new Error(`no document for id "${id}" in filenames`);
				const folder = documentFolder(input.ledger, documentId);

				let categoryFolderId = categoryFolders.get(folder);
				if (!categoryFolderId) {
					categoryFolderId = await findOrCreateFolder(drive, folder, monthFolderId);
					categoryFolders.set(folder, categoryFolderId);
				}

				const existingFileId = await findFileByName(drive, filename, categoryFolderId);
				if (existingFileId) {
					unchanged += 1;
					continue;
				}
				const bytes = await input.readDocument(document);
				await drive.files.create({
					requestBody: { name: filename, parents: [categoryFolderId] },
					media: { mimeType: document.mime, body: Buffer.from(bytes) },
					fields: "id",
				});
				created += 1;
			}

			const csv = reconciliationCsv(input.ledger, input.filenames);
			const existingCsvId = await findFileByName(drive, CSV_FILENAME, monthFolderId);
			if (existingCsvId) {
				await drive.files.update({
					fileId: existingCsvId,
					media: { mimeType: "text/csv", body: csv },
				});
				unchanged += 1;
			} else {
				await drive.files.create({
					requestBody: { name: CSV_FILENAME, parents: [monthFolderId] },
					media: { mimeType: "text/csv", body: csv },
					fields: "id",
				});
				created += 1;
			}

			const orphans = orphanDocumentRecords(input.ledger, input.filenames);
			if (orphans.length > 0) {
				const unmatched = unmatchedDocumentsCsv(input.ledger, input.filenames);
				const existingUnmatchedId = await findFileByName(drive, UNMATCHED_FILENAME, monthFolderId);
				if (existingUnmatchedId) {
					await drive.files.update({
						fileId: existingUnmatchedId,
						media: { mimeType: "text/csv", body: unmatched },
					});
					unchanged += 1;
				} else {
					await drive.files.create({
						requestBody: { name: UNMATCHED_FILENAME, parents: [monthFolderId] },
						media: { mimeType: "text/csv", body: unmatched },
						fields: "id",
					});
					created += 1;
				}
			}

			return { sink: "drive", created, unchanged };
		},
	};
}

async function findOrCreateFolder(
	drive: drive_v3.Drive,
	name: string,
	parentId: string
): Promise<string> {
	const existing = await findFileByName(drive, name, parentId, FOLDER_MIME);
	if (existing) return existing;
	const response = await drive.files.create({
		requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
		fields: "id",
	});
	const id = response.data.id;
	if (!id) throw new Error(`drive did not return an id for folder "${name}"`);
	return id;
}

async function findFileByName(
	drive: drive_v3.Drive,
	name: string,
	parentId: string,
	mimeType?: string
): Promise<string | null> {
	const clauses = [
		`name = '${escapeDriveQuery(name)}'`,
		`'${escapeDriveQuery(parentId)}' in parents`,
		"trashed = false",
	];
	if (mimeType) clauses.push(`mimeType = '${escapeDriveQuery(mimeType)}'`);
	const response = await drive.files.list({
		q: clauses.join(" and "),
		fields: "files(id, name)",
		spaces: "drive",
	});
	return response.data.files?.[0]?.id ?? null;
}

function escapeDriveQuery(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
