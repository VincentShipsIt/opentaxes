import { readdir as nodeReaddir, readFile as nodeReadFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DocumentSource, FetchedDocument } from "../core/registry.ts";
import type { Month } from "../core/types.ts";

const EXTENSION_MIME: Readonly<Record<string, string>> = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
};

export interface FolderSourceOptions {
	readonly dir: string;
	readonly readdir?: (dir: string) => Promise<readonly string[]>;
	readonly readFile?: (path: string) => Promise<Uint8Array>;
}

/** Extension, lower case, including the leading dot; "" when the filename has none. */
function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

/**
 * Reads receipts and invoices a user dropped into `<dir>/<YYYY-MM>/`, non-recursive. A month
 * with no directory yet is not an error: it simply has nothing to contribute.
 */
export function createFolderSource(options: FolderSourceOptions): DocumentSource {
	const { dir } = options;
	const readdir: (dir: string) => Promise<readonly string[]> = options.readdir ?? nodeReaddir;
	const readFile: (path: string) => Promise<Uint8Array> =
		options.readFile ?? ((path) => nodeReadFile(path));

	return {
		name: "folder",

		async fetchDocuments(month: Month): Promise<readonly FetchedDocument[]> {
			const monthDir = join(dir, month);

			let entries: readonly string[];
			try {
				entries = await readdir(monthDir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}

			const filenames = entries
				.filter((filename) => !filename.startsWith("."))
				.filter((filename) => extensionOf(filename) in EXTENSION_MIME)
				.sort();

			const documents: FetchedDocument[] = [];
			for (const filename of filenames) {
				const path = join(monthDir, filename);
				const bytes = await readFile(path);
				documents.push({
					origin: { kind: "file", path: resolve(path) },
					filename,
					mime: EXTENSION_MIME[extensionOf(filename)] as string,
					bytes,
				});
			}

			return documents;
		},
	};
}
