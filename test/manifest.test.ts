import { describe, expect, it } from "vitest";
import { SyncManifest } from "../src/sync/manifest";
import { ManifestEntry } from "../src/sync/types";

// Constructed via explicit code points rather than typed literals — see
// test/crypto.test.ts for why. Must stay genuinely distinct byte sequences.
const nfd = "Café.md"; // "e" + combining acute accent (U+0301)
const nfc = "Café.md"; // precomposed "é" (U+00E9)

function makeEntry(path: string): ManifestEntry {
	return { path, contentHash: "h", mtime: 1, size: 1, remoteEtag: "e", lastSyncedHash: "h" };
}

describe("SyncManifest Unicode path normalization (BACKLOG.md #3)", () => {
	it("sanity: nfd/nfc test fixtures are genuinely distinct byte sequences", () => {
		expect(nfd).not.toBe(nfc);
		expect(nfd.normalize("NFC")).toBe(nfc);
	});

	it("normalizes entry paths loaded via fromJSON", () => {
		const manifest = SyncManifest.fromJSON([makeEntry(nfd)]);

		expect(manifest.get(nfc)).toBeDefined();
		expect(manifest.get(nfc)?.path).toBe(nfc);
		expect(manifest.allPaths()).toEqual([nfc]);
	});

	it("get()/has()/delete() accept either normalization form for the same manifest entry", () => {
		const manifest = new SyncManifest();
		manifest.set(makeEntry(nfc));

		expect(manifest.has(nfd)).toBe(true);
		expect(manifest.get(nfd)?.path).toBe(nfc);

		manifest.delete(nfd);
		expect(manifest.has(nfc)).toBe(false);
	});

	it("set() normalizes the entry's own path field, not just the map key", () => {
		const manifest = new SyncManifest();
		manifest.set(makeEntry(nfd));

		const [entry] = manifest.toJSON();
		expect(entry.path).toBe(nfc);
	});
});

describe("SyncManifest.fromJSON robustness against corrupted/unexpected persisted data", () => {
	it("falls back to an empty manifest for non-array input (e.g. corrupted data.json)", () => {
		expect(SyncManifest.fromJSON(null).allPaths()).toEqual([]);
		expect(SyncManifest.fromJSON(undefined).allPaths()).toEqual([]);
		expect(SyncManifest.fromJSON("not an array").allPaths()).toEqual([]);
		expect(SyncManifest.fromJSON({ foo: "bar" }).allPaths()).toEqual([]);
		expect(SyncManifest.fromJSON(42).allPaths()).toEqual([]);
	});

	it("accepts a genuinely empty array", () => {
		expect(SyncManifest.fromJSON([]).allPaths()).toEqual([]);
	});
});

describe("SyncManifest basic CRUD", () => {
	it("entriesList() returns the same entries as toJSON()", () => {
		const manifest = new SyncManifest();
		manifest.set(makeEntry("a.md"));
		manifest.set(makeEntry("b.md"));
		expect(manifest.entriesList().map((e) => e.path).sort()).toEqual(["a.md", "b.md"]);
		expect(manifest.toJSON().map((e) => e.path).sort()).toEqual(["a.md", "b.md"]);
	});

	it("set() overwrites an existing entry at the same path rather than duplicating it", () => {
		const manifest = new SyncManifest();
		manifest.set(makeEntry("a.md"));
		manifest.set({ ...makeEntry("a.md"), contentHash: "updated-hash" });

		expect(manifest.allPaths()).toEqual(["a.md"]);
		expect(manifest.get("a.md")?.contentHash).toBe("updated-hash");
	});

	it("delete() on a path that was never set is a harmless no-op", () => {
		const manifest = new SyncManifest();
		expect(() => manifest.delete("never-existed.md")).not.toThrow();
		expect(manifest.has("never-existed.md")).toBe(false);
	});
});
