import { describe, expect, it } from "vitest";
import { RemoteMetaCache } from "../src/store/remote-meta-cache";

const sampleMeta = { etag: "e1", path: "note.md", contentHash: "h1", hashIsLegacy: false };

describe("RemoteMetaCache.fromJSON robustness against corrupted/unexpected persisted data", () => {
	it("falls back to an empty cache for non-object input", () => {
		expect(RemoteMetaCache.fromJSON(null).get("any-key")).toBeUndefined();
		expect(RemoteMetaCache.fromJSON(undefined).get("any-key")).toBeUndefined();
		expect(RemoteMetaCache.fromJSON("not an object").get("any-key")).toBeUndefined();
		expect(RemoteMetaCache.fromJSON(42).get("any-key")).toBeUndefined();
	});

	it("falls back to an empty cache for array input (wrong shape — this cache is object-keyed, not array-keyed)", () => {
		expect(RemoteMetaCache.fromJSON([sampleMeta]).get("any-key")).toBeUndefined();
	});

	it("round-trips a populated cache through toJSON/fromJSON", () => {
		const cache = new RemoteMetaCache();
		cache.set("obj-key-1", sampleMeta);

		const restored = RemoteMetaCache.fromJSON(cache.toJSON());
		expect(restored.get("obj-key-1")).toEqual(sampleMeta);
	});

	it("accepts a genuinely empty object", () => {
		expect(RemoteMetaCache.fromJSON({}).get("any-key")).toBeUndefined();
	});
});

describe("RemoteMetaCache basic behavior", () => {
	it("retainOnly() removes entries not in the given set", () => {
		const cache = new RemoteMetaCache();
		cache.set("k1", sampleMeta);
		cache.set("k2", sampleMeta);
		cache.set("k3", sampleMeta);

		cache.retainOnly(new Set(["k1", "k3"]));

		expect(cache.get("k1")).toBeDefined();
		expect(cache.get("k2")).toBeUndefined();
		expect(cache.get("k3")).toBeDefined();
	});

	it("retainOnly() with an empty set clears the whole cache", () => {
		const cache = new RemoteMetaCache();
		cache.set("k1", sampleMeta);
		cache.retainOnly(new Set());
		expect(cache.get("k1")).toBeUndefined();
	});

	it("set() overwrites an existing entry at the same key", () => {
		const cache = new RemoteMetaCache();
		cache.set("k1", sampleMeta);
		cache.set("k1", { ...sampleMeta, contentHash: "updated" });
		expect(cache.get("k1")?.contentHash).toBe("updated");
	});
});
