import { describe, expect, it } from "bun:test";
import type { drive_v3 } from "googleapis";
import type { PublishInput } from "../core/registry.ts";
import type { Document } from "../core/types.ts";
import { createDriveSink } from "./drive.ts";
import { doc, extraction, ledgerFixture, match, txn } from "./test-fixtures.ts";

const FOLDER_MIME = "application/vnd.google-apps.folder";

interface FakeNode {
	readonly id: string;
	name: string;
	parentId: string;
	mimeType: string;
	content?: unknown;
}

function createFakeDrive() {
	const nodes: FakeNode[] = [];
	let nextId = 1;
	const calls = { list: 0, create: 0, update: 0 };

	const files = {
		async list({ q }: { q: string }) {
			calls.list += 1;
			const requiresFolder = q.includes(`mimeType = '${FOLDER_MIME}'`);
			const matches = nodes.filter(
				(node) =>
					q.includes(`name = '${node.name}'`) &&
					q.includes(`'${node.parentId}' in parents`) &&
					(requiresFolder ? node.mimeType === FOLDER_MIME : node.mimeType !== FOLDER_MIME)
			);
			return { data: { files: matches.map(({ id, name }) => ({ id, name })) } };
		},
		async create({
			requestBody,
			media,
		}: {
			requestBody: { name: string; mimeType?: string; parents: string[] };
			media?: { mimeType?: string; body?: unknown };
		}) {
			calls.create += 1;
			const id = `node-${nextId++}`;
			const parentId = requestBody.parents[0];
			if (!parentId) throw new Error("fake drive: create requires a parent");
			nodes.push({
				id,
				name: requestBody.name,
				parentId,
				mimeType: requestBody.mimeType ?? media?.mimeType ?? "application/octet-stream",
				content: media?.body,
			});
			return { data: { id } };
		},
		async update({ fileId, media }: { fileId: string; media?: { body?: unknown } }) {
			calls.update += 1;
			const node = nodes.find((candidate) => candidate.id === fileId);
			if (!node) throw new Error(`fake drive: no file "${fileId}"`);
			node.content = media?.body;
			return { data: { id: fileId } };
		},
	};

	return { drive: { files } as unknown as drive_v3.Drive, calls, nodes };
}

function buildInput(): PublishInput {
	const invoice = doc({ id: "d1", filename: "invoice.pdf" });
	const t = txn({ id: "wise:1" });
	const ledger = ledgerFixture({
		transactions: [t],
		documents: [invoice],
		extractions: { d1: extraction({ party: "Acme Supplies", category: "software" }) },
		matches: [match({ transactionId: "wise:1", documentId: "d1" })],
	});
	return {
		ledger,
		filenames: { d1: "invoice.pdf" },
		readDocument: async (_document: Document) => new TextEncoder().encode("invoice-bytes"),
	};
}

function buildInputWithOrphan(): PublishInput {
	const invoice = doc({ id: "d1", filename: "invoice.pdf" });
	const orphan = doc({ id: "d2", filename: "orphan.pdf" });
	const t = txn({ id: "wise:1" });
	const ledger = ledgerFixture({
		transactions: [t],
		documents: [invoice, orphan],
		extractions: {
			d1: extraction({ party: "Acme Supplies", category: "software" }),
			d2: extraction({ party: "Loose Vendor" }),
		},
		matches: [match({ transactionId: "wise:1", documentId: "d1" })],
	});
	return {
		ledger,
		filenames: { d1: "invoice.pdf", d2: "orphan.pdf" },
		readDocument: async (_document: Document) => new TextEncoder().encode("invoice-bytes"),
	};
}

describe("createDriveSink", () => {
	it("creates the year/month/category folder chain and uploads the document plus csv", async () => {
		const { drive, nodes } = createFakeDrive();
		const sink = createDriveSink({ drive, folderId: "root-folder" });
		const input = buildInput();

		const result = await sink.publish(input);

		expect(result).toEqual({ sink: "drive", created: 2, unchanged: 0 });
		const year = nodes.find((n) => n.name === "2026" && n.mimeType === FOLDER_MIME);
		expect(year?.parentId).toBe("root-folder");
		const monthNode = nodes.find((n) => n.name === "01" && n.mimeType === FOLDER_MIME);
		expect(monthNode?.parentId).toBe(year?.id);
		const category = nodes.find((n) => n.name === "expenses" && n.mimeType === FOLDER_MIME);
		expect(category?.parentId).toBe(monthNode?.id);
		const uploaded = nodes.find((n) => n.name === "invoice.pdf");
		expect(uploaded?.parentId).toBe(category?.id);
		const csv = nodes.find((n) => n.name === "reconciliation.csv");
		expect(csv?.parentId).toBe(monthNode?.id);
	});

	it("is idempotent: a second publish creates no duplicate folders or files", async () => {
		const { drive, nodes, calls } = createFakeDrive();
		const sink = createDriveSink({ drive, folderId: "root-folder" });
		const input = buildInput();

		await sink.publish(input);
		const createCallsAfterFirst = calls.create;
		const result = await sink.publish(input);

		expect(result).toEqual({ sink: "drive", created: 0, unchanged: 2 });
		expect(calls.create).toBe(createCallsAfterFirst); // no new folders or files
		expect(nodes.filter((n) => n.name === "invoice.pdf")).toHaveLength(1);
		expect(nodes.filter((n) => n.name === "2026" && n.mimeType === FOLDER_MIME)).toHaveLength(1);
	});

	it("updates the csv file in place instead of duplicating it", async () => {
		const { drive, calls } = createFakeDrive();
		const sink = createDriveSink({ drive, folderId: "root-folder" });

		await sink.publish(buildInput());
		await sink.publish(buildInput());

		expect(calls.update).toBe(1);
	});

	it("does not upload unmatched-documents.csv while there are no orphan documents", async () => {
		const { drive, nodes } = createFakeDrive();
		const sink = createDriveSink({ drive, folderId: "root-folder" });

		await sink.publish(buildInput());

		expect(nodes.find((n) => n.name === "unmatched-documents.csv")).toBeUndefined();
	});

	it("uploads unmatched-documents.csv once an orphan document exists, and updates it in place", async () => {
		const { drive, nodes, calls } = createFakeDrive();
		const sink = createDriveSink({ drive, folderId: "root-folder" });

		await sink.publish(buildInputWithOrphan());
		const unmatched = nodes.find((n) => n.name === "unmatched-documents.csv");
		expect(unmatched).toBeDefined();
		const createCallsAfterFirst = calls.create;

		await sink.publish(buildInputWithOrphan());

		expect(nodes.filter((n) => n.name === "unmatched-documents.csv")).toHaveLength(1);
		expect(calls.create).toBe(createCallsAfterFirst);
	});
});
