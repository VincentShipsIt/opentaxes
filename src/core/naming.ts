import { formatDecimal } from "./money.ts";
import type { Document, DocumentId, Extraction } from "./types.ts";

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
	"application/pdf": "pdf",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/heic": "heic",
	"image/webp": "webp",
	"image/tiff": "tiff",
	"text/csv": "csv",
	"text/plain": "txt",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.ms-excel": "xls",
	"application/zip": "zip",
};

const DEFAULT_EXTENSION = "bin";

/** Lowercase ascii, hyphen-separated, collapsed, capped at 40 chars. */
export function slug(text: string): string {
	const normalized = text
		.normalize("NFKD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized.slice(0, 40).replace(/-+$/g, "");
}

/** Extension from the mime type first, falling back to the original filename, default "bin". */
export function extensionOf(mime: string, filename: string): string {
	const fromMime = MIME_EXTENSIONS[mime.toLowerCase()];
	if (fromMime) return fromMime;
	const match = /\.([a-zA-Z0-9]+)$/.exec(filename);
	if (match?.[1]) return match[1].toLowerCase();
	return DEFAULT_EXTENSION;
}

/** Drops the last dot-extension, if any, so it doesn't leak into a slug. */
function stripExtension(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot > 0 ? filename.slice(0, dot) : filename;
}

export function documentFilename(document: Document, extraction: Extraction | undefined): string {
	const ext = extensionOf(document.mime, document.filename);
	if (!extraction) {
		const shortSha = document.id.slice(0, 8);
		return `unread_${shortSha}_${slug(stripExtension(document.filename))}.${ext}`;
	}
	const parts = [
		extraction.issuedAt,
		slug(extraction.party),
		`${formatDecimal(extraction.total)}-${extraction.total.currency}`,
	];
	if (extraction.number) parts.push(slug(extraction.number));
	return `${parts.join("_")}.${ext}`;
}

/** Inserts `suffix` right before the last dot-extension, or appends it when there is none. */
function insertBeforeExtension(filename: string, suffix: string): string {
	const dot = filename.lastIndexOf(".");
	if (dot <= 0) return `${filename}${suffix}`;
	return `${filename.slice(0, dot)}${suffix}${filename.slice(dot)}`;
}

/**
 * Maps every document to a filename from documentFilename, disambiguating collisions —
 * same vendor, day and total with no invoice number, say — by appending the first 8
 * characters of the colliding document's id before the extension. The first document to
 * claim a name keeps it; later ones get the suffix, so a name never lands on two documents.
 */
export function uniqueFilenames(
	documents: readonly Document[],
	extractions: Readonly<Record<DocumentId, Extraction>>
): Record<DocumentId, string> {
	const used = new Set<string>();
	const filenames: Record<DocumentId, string> = {};
	for (const document of documents) {
		const base = documentFilename(document, extractions[document.id]);
		const name = used.has(base) ? insertBeforeExtension(base, `_${document.id.slice(0, 8)}`) : base;
		used.add(name);
		filenames[document.id] = name;
	}
	return filenames;
}
