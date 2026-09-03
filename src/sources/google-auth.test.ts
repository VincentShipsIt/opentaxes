import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoogleAuth } from "./google-auth.ts";

let dir: string;
let tokenPath: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "opentaxes-google-auth-"));
	tokenPath = join(dir, "tokens.json");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("waitFor: condition never became true");
}

describe("createGoogleAuth().loadClient", () => {
	test("throws an error naming the auth command when no tokens have been stored", async () => {
		const auth = createGoogleAuth({
			clientId: "fake-client-id",
			clientSecret: "fake-secret",
			tokenPath,
		});
		await expect(auth.loadClient()).rejects.toThrow(/opentaxes auth google/);
	});

	test("sets credentials from previously stored tokens", async () => {
		await writeFile(
			tokenPath,
			JSON.stringify({ access_token: "stored-access-token", refresh_token: "stored-refresh-token" })
		);
		const auth = createGoogleAuth({
			clientId: "fake-client-id",
			clientSecret: "fake-secret",
			tokenPath,
		});

		const client = await auth.loadClient();

		expect(client.credentials.access_token).toBe("stored-access-token");
		expect(client.credentials.refresh_token).toBe("stored-refresh-token");
	});

	test("persists refreshed tokens back to tokenPath, merged with what was stored, mode 0600", async () => {
		await writeFile(
			tokenPath,
			JSON.stringify({ access_token: "stored-access-token", refresh_token: "stored-refresh-token" })
		);
		const auth = createGoogleAuth({
			clientId: "fake-client-id",
			clientSecret: "fake-secret",
			tokenPath,
			log: () => {},
		});
		const client = await auth.loadClient();

		client.emit("tokens", {
			access_token: "refreshed-access-token",
			expiry_date: 1_700_000_000_000,
		});

		await waitFor(async () => {
			const raw = await readFile(tokenPath, "utf8");
			return raw.includes("refreshed-access-token");
		});

		const persisted = JSON.parse(await readFile(tokenPath, "utf8")) as Record<string, unknown>;
		expect(persisted.access_token).toBe("refreshed-access-token");
		expect(persisted.refresh_token).toBe("stored-refresh-token");
		expect(persisted.expiry_date).toBe(1_700_000_000_000);

		const stats = await stat(tokenPath);
		expect(stats.mode & 0o777).toBe(0o600);
	});
});
