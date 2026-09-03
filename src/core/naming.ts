import { formatDecimal } from "./money.ts";
import type { Document, Extraction } from "./types.ts";

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

export function documentFilename(document: Document, extraction: Extraction | undefined): string {
	const ext = extensionOf(document.mime, document.filename);
	if (!extraction) {
		const shortSha = document.id.slice(0, 8);
		return `unread_${shortSha}_${slug(document.filename)}.${ext}`;
	}
	const parts = [
		extraction.issuedAt,
		slug(extraction.party),
		`${formatDecimal(extraction.total)}-${extraction.total.currency}`,
	];
	if (extraction.number) parts.push(slug(extraction.number));
	return `${parts.join("_")}.${ext}`;
}
