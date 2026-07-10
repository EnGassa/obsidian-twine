import { describe, expect, it } from "vitest";
import { BaseContentCache } from "../src/sync/base-cache";

async function key(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]) as Promise<CryptoKey>;
}

describe("BaseContentCache", () => {
	it("round-trips eligible text and persists encrypted records", async () => {
		const cache = new BaseContentCache(await key());
		const bytes = new TextEncoder().encode("hello");
		await cache.set("Notes/Test.md", bytes);
		expect(await cache.get("Notes/Test.md")).toEqual(bytes);
		expect(JSON.stringify(cache.toJSON())).not.toContain("hello");
	});

	it("rejects unsupported and oversized entries", async () => {
		const cache = new BaseContentCache(await key());
		await cache.set("image.png", new Uint8Array([1]));
		await cache.set("huge.md", new Uint8Array(128 * 1024 + 1));
		expect(await cache.get("image.png")).toBeUndefined();
		expect(await cache.get("huge.md")).toBeUndefined();
	});

	it("evicts least recently used records over the aggregate budget", async () => {
		const cache = new BaseContentCache(await key());
		const bytes = new Uint8Array(128 * 1024);
		await cache.set("a.md", bytes);
		await cache.set("b.md", bytes);
		await cache.set("c.md", bytes);
		await cache.set("d.md", bytes);
		await cache.set("e.md", bytes);
		expect(await cache.get("a.md")).toBeUndefined();
		expect(await cache.get("e.md")).toEqual(bytes);
	});

	it("deletes by path and ignores malformed records", async () => {
		const cache = new BaseContentCache(await key(), { entries: { "bad.md": { ciphertext: "%%%", access: 1 } } });
		expect(await cache.get("bad.md")).toBeUndefined();
		cache.delete("missing.md");
	});

	it("clears only an entry that fails authentication", async () => {
		const contentKey = await key();
		const cache = new BaseContentCache(contentKey);
		await cache.set("good.md", new TextEncoder().encode("good"));
		await cache.set("bad.md", new TextEncoder().encode("bad"));
		const serialized = cache.toJSON();
		(serialized.entries["bad.md"] as { ciphertext: string }).ciphertext =
			(serialized.entries["bad.md"] as { ciphertext: string }).ciphertext.slice(0, -2) + "xx";
		const reloaded = new BaseContentCache(contentKey, serialized);
		expect(await reloaded.get("bad.md")).toBeUndefined();
		expect(await reloaded.get("good.md")).toEqual(new TextEncoder().encode("good"));
	});
});
