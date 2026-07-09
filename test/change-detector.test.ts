import { describe, expect, it } from "vitest";
import { buildSyncPlan } from "../src/sync/change-detector";
import { SyncManifest } from "../src/sync/manifest";
import { LocalFileState, RemoteFileState } from "../src/sync/types";

/**
 * Covers the keyed-content-hash migration (BACKLOG.md #2): a remote object
 * written before the migration stores a bare SHA-256 hash, which can never
 * equal a post-migration keyed HMAC of the same content. Without the
 * legacy-hash fallback in change-detector.ts, a device syncing that path for
 * the first time (no manifest baseline) would misclassify identical content
 * as a conflict.
 */
describe("legacy content-hash migration", () => {
	it("treats byte-identical content as noop when compared against a legacy-hashed remote object", () => {
		const manifest = new SyncManifest(); // no baseline for this path
		const local: LocalFileState[] = [
			{
				path: "note.md",
				contentHash: "new-keyed-hmac-hash-abc123",
				legacyContentHash: "legacy-sha256-hash-xyz789",
				mtime: 1,
				size: 10,
			},
		];
		const remote: RemoteFileState[] = [
			{
				path: "note.md",
				contentHash: "legacy-sha256-hash-xyz789", // same value as local's legacy hash
				etag: "etag-1",
				lastModified: new Date().toISOString(),
				hashIsLegacy: true,
			},
		];

		const plan = buildSyncPlan(manifest, local, remote);
		expect(plan).toHaveLength(1);
		expect(plan[0].action).toBe("noop");
	});

	it("still flags a genuine conflict when legacy hashes actually differ", () => {
		const manifest = new SyncManifest();
		const local: LocalFileState[] = [
			{
				path: "note.md",
				contentHash: "new-keyed-hmac-hash-abc123",
				legacyContentHash: "legacy-sha256-hash-AAA",
				mtime: 1,
				size: 10,
			},
		];
		const remote: RemoteFileState[] = [
			{
				path: "note.md",
				contentHash: "legacy-sha256-hash-BBB", // genuinely different content
				etag: "etag-1",
				lastModified: new Date().toISOString(),
				hashIsLegacy: true,
			},
		];

		const plan = buildSyncPlan(manifest, local, remote);
		expect(plan).toHaveLength(1);
		expect(plan[0].action).toBe("conflict");
	});

	it("compares directly (no legacy fallback) when the remote object is already migrated", () => {
		const manifest = new SyncManifest();
		const local: LocalFileState[] = [
			{
				path: "note.md",
				contentHash: "same-keyed-hash",
				legacyContentHash: "irrelevant-legacy-hash",
				mtime: 1,
				size: 10,
			},
		];
		const remote: RemoteFileState[] = [
			{
				path: "note.md",
				contentHash: "same-keyed-hash",
				etag: "etag-1",
				lastModified: new Date().toISOString(),
				hashIsLegacy: false,
			},
		];

		const plan = buildSyncPlan(manifest, local, remote);
		expect(plan[0].action).toBe("noop");
	});

	it("treats a missing local legacyContentHash as non-matching rather than throwing", () => {
		// Defensive: if legacyContentHash was never computed (shouldn't happen for
		// a no-manifestEntry path per sync-engine.ts, but classify() must not
		// crash or silently "match" on undefined === undefined).
		const manifest = new SyncManifest();
		const local: LocalFileState[] = [{ path: "note.md", contentHash: "keyed-hash", mtime: 1, size: 10 }];
		const remote: RemoteFileState[] = [
			{
				path: "note.md",
				contentHash: "legacy-hash",
				etag: "etag-1",
				lastModified: new Date().toISOString(),
				hashIsLegacy: true,
			},
		];

		const plan = buildSyncPlan(manifest, local, remote);
		expect(plan[0].action).toBe("conflict");
	});
});
