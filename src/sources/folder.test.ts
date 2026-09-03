import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseMonth } from "../core/dates.ts";
import { createFolderSource } from "./folder.ts";

function fakeFs(tree: Readonly<Record<string, readonly string[]>>) {
	const readdir = async (dir: string): Promise<readonly string[]> => {
		const entries = tree[dir];
		if (entries === undefined) {
			const error = new Error(`ENOENT: no such directory "${dir}"`) as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		}
		return entries;
	};
	const readFile = async (path: string): Promise<Uint8Array> =>
		new TextEncoder().encode(`bytes:${path}`);
	return { readdir, readFile };
}

describe("createFolderSource", () => {
	test("reads only the requested month's directory, non-recursive", async () => {
		const { readdir, readFile } = fakeFs({
			"/docs/2026-01": ["receipt.pdf"],
			"/docs/2026-02": ["other.pdf"],
		});
		const source = createFolderSource({ dir: "/docs", readdir, readFile });

		const documents = await source.fetchDocuments(parseMonth("2026-01"));

		expect(documents.map((d) => d.filename)).toEqual(["receipt.pdf"]);
	});

	test("accepts pdf, png, jpg, jpeg case-insensitively and skips everything else and dotfiles", async () => {
		const { readdir, readFile } = fakeFs({
			"/docs/2026-01": [
				"a.pdf",
				"b.PNG",
				"c.Jpg",
				"d.JPEG",
				"notes.txt",
				"README.md",
				".DS_Store",
				".hidden.pdf",
			],
		});
		const source = createFolderSource({ dir: "/docs", readdir, readFile });

		const documents = await source.fetchDocuments(parseMonth("2026-01"));

		expect(documents.map((d) => d.filename)).toEqual(["a.pdf", "b.PNG", "c.Jpg", "d.JPEG"]);
	});

	test("sorts by filename", async () => {
		const { readdir, readFile } = fakeFs({
			"/docs/2026-01": ["c.pdf", "a.png", "b.jpg"],
		});
		const source = createFolderSource({ dir: "/docs", readdir, readFile });

		const documents = await source.fetchDocuments(parseMonth("2026-01"));

		expect(documents.map((d) => d.filename)).toEqual(["a.png", "b.jpg", "c.pdf"]);
	});

	test("an absent month directory yields an empty list, not an error", async () => {
		const { readdir, readFile } = fakeFs({});
		const source = createFolderSource({ dir: "/docs", readdir, readFile });

		const documents = await source.fetchDocuments(parseMonth("2026-01"));

		expect(documents).toEqual([]);
	});

	test("maps mime from the extension and sets a file origin with the absolute path", async () => {
		const { readdir, readFile } = fakeFs({
			"/docs/2026-01": ["invoice.pdf", "photo.jpeg"],
		});
		const source = createFolderSource({ dir: "/docs", readdir, readFile });

		const documents = await source.fetchDocuments(parseMonth("2026-01"));

		const pdf = documents.find((d) => d.filename === "invoice.pdf");
		expect(pdf?.mime).toBe("application/pdf");
		expect(pdf?.origin).toEqual({ kind: "file", path: join("/docs/2026-01", "invoice.pdf") });

		const jpeg = documents.find((d) => d.filename === "photo.jpeg");
		expect(jpeg?.mime).toBe("image/jpeg");
	});

	test("has no extraction: the extractor fills it in later", async () => {
		const { readdir, readFile } = fakeFs({
			"/docs/2026-01": ["receipt.pdf"],
		});
		const source = createFolderSource({ dir: "/docs", readdir, readFile });

		const [document] = await source.fetchDocuments(parseMonth("2026-01"));

		expect(document?.extraction).toBeUndefined();
	});

	test("reads file bytes and is named folder", async () => {
		const { readdir, readFile } = fakeFs({
			"/docs/2026-01": ["receipt.pdf"],
		});
		const source = createFolderSource({ dir: "/docs", readdir, readFile });
		expect(source.name).toBe("folder");

		const [document] = await source.fetchDocuments(parseMonth("2026-01"));

		expect(new TextDecoder().decode(document?.bytes)).toBe(
			`bytes:${join("/docs/2026-01", "receipt.pdf")}`
		);
	});
});
