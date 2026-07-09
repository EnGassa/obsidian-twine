import { describe, expect, it } from "vitest";
import { SyncManifest } from "../src/sync/manifest";
import { runSyncPass, SyncEngineContext } from "../src/sync/sync-engine";
import { sha256Hex } from "../src/util/hash";
import { RemoteAdapter } from "../src/sync/adapters";
import { InMemoryRemote, InMemoryVault } from "./mock-adapters";

function makeCtx(
	vault: InMemoryVault,
	remote: RemoteAdapter,
	manifest: SyncManifest,
	deviceName: string
): SyncEngineContext {
	return {
		vault,
		remote,
		manifest,
		deviceName,
		hashFn: sha256Hex,
		persistManifest: async () => {},
	};
}

describe("offline divergence on both sides", () => {
	it("preserves both versions as canonical + conflict-copy, no data loss", async () => {
		const remote = new InMemoryRemote();

		// Device A and B both start from the same synced baseline.
		const vaultA = new InMemoryVault();
		const manifestA = new SyncManifest();
		vaultA.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));

		const vaultB = new InMemoryVault();
		const manifestB = new SyncManifest();
		vaultB.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vaultB, remote, manifestB, "device-b"));

		// Now both devices go offline and edit the same file independently.
		vaultA.seed("note.md", "edited by A", 10);
		vaultB.seed("note.md", "edited by B", 20);

		// A comes back online first, syncs cleanly (no conflict yet — remote unchanged from A's perspective).
		await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));
		expect(remote.readText("note.md")).toBe("edited by A");

		// B comes back online: remote changed (A's edit) AND B has a local edit -> conflict.
		const result = await runSyncPass(makeCtx(vaultB, remote, manifestB, "device-b"));
		expect(result.errors).toHaveLength(0);

		// Both edits must survive somewhere in B's vault; nothing is silently discarded.
		const bContents = vaultB.allPaths().map((p) => vaultB.readText(p));
		expect(bContents).toContain("edited by A");
		expect(bContents).toContain("edited by B");

		// Exactly one conflict-copy file was created (the loser), alongside the canonical note.md.
		const conflictCopies = vaultB.allPaths().filter((p) => p.includes("conflicted copy"));
		expect(conflictCopies).toHaveLength(1);
	});
});

describe("rename-vs-edit", () => {
	it("keeps the remote edit instead of silently deleting it when a local rename races it", async () => {
		const remote = new InMemoryRemote();

		const vaultA = new InMemoryVault();
		const manifestA = new SyncManifest();
		vaultA.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));

		const vaultB = new InMemoryVault();
		const manifestB = new SyncManifest();
		vaultB.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vaultB, remote, manifestB, "device-b"));

		// Device B edits note.md remotely and syncs.
		vaultB.seed("note.md", "edited by B", 10);
		await runSyncPass(makeCtx(vaultB, remote, manifestB, "device-b"));

		// Meanwhile, offline, device A "renames" note.md -> note-renamed.md
		// (modeled as our vault/change-detector sees it: a delete + a new file).
		await vaultA.deleteFile("note.md");
		vaultA.seed("note-renamed.md", "original", 20);

		const result = await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));
		expect(result.errors).toHaveLength(0);

		// B's edit is NOT silently destroyed by A's rename-as-delete: it's restored locally.
		expect(vaultA.has("note.md")).toBe(true);
		expect(vaultA.readText("note.md")).toBe("edited by B");
		// The renamed file still uploads as a new, independent file.
		expect(vaultA.has("note-renamed.md")).toBe(true);
		expect(remote.has("note-renamed.md")).toBe(true);

		// Known limitation (documented in the plan): this does not achieve true
		// rename semantics — it produces two files instead of one renamed file.
		// That's an accepted trade-off; the safety property that matters is that
		// B's edit survives instead of vanishing.
	});
});

describe("delete-vs-edit", () => {
	it("restores a file locally when the remote edited it after local deletion", async () => {
		const remote = new InMemoryRemote();

		const vaultA = new InMemoryVault();
		const manifestA = new SyncManifest();
		vaultA.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));

		const vaultB = new InMemoryVault();
		const manifestB = new SyncManifest();
		vaultB.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vaultB, remote, manifestB, "device-b"));

		// A deletes locally (offline).
		await vaultA.deleteFile("note.md");

		// B edits and syncs first.
		vaultB.seed("note.md", "edited by B", 10);
		await runSyncPass(makeCtx(vaultB, remote, manifestB, "device-b"));

		// A comes back online and syncs: the edit wins over the deletion.
		const result = await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));
		expect(result.errors).toHaveLength(0);
		expect(vaultA.has("note.md")).toBe(true);
		expect(vaultA.readText("note.md")).toBe("edited by B");
	});
});

describe("mid-sync partial failure", () => {
	it("keeps progress already made on other files when one file's transfer fails", async () => {
		const remote = new InMemoryRemote();
		const vault = new InMemoryVault();
		const manifest = new SyncManifest();

		vault.seed("good.md", "fine", 1);
		vault.seed("bad.md", "will fail", 2);

		// Wrap the remote so puts to "bad.md" fail with a generic (non-412) error,
		// simulating e.g. a dropped connection mid-pass.
		const flakyRemote: RemoteAdapter = {
			list: () => remote.list(),
			get: (path) => remote.get(path),
			delete: (path, ifMatch) => remote.delete(path, ifMatch),
			put: (path, plaintext, options) => {
				if (path === "bad.md") throw new Error("simulated network failure");
				return remote.put(path, plaintext, options);
			},
		};

		const result = await runSyncPass(makeCtx(vault, flakyRemote, manifest, "device-a"));

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toBe("bad.md");

		// good.md's progress must survive even though bad.md failed in the same pass.
		expect(remote.has("good.md")).toBe(true);
		expect(manifest.get("good.md")).toBeDefined();
		expect(manifest.get("bad.md")).toBeUndefined();

		// A later pass (after the transient failure clears) picks bad.md back up.
		const secondResult = await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));
		expect(secondResult.errors).toHaveLength(0);
		expect(remote.has("bad.md")).toBe(true);
	});
});

describe("case-insensitive filesystem collisions (known limitation)", () => {
	it("documents that differently-cased paths are NOT unified across devices", async () => {
		// This test intentionally documents a known gap rather than asserting
		// correct behavior — see plan "Known Risks". Our path handling treats
		// "Note.md" and "note.md" as distinct paths (exact string match), but a
		// real case-insensitive filesystem (default on macOS/Windows) would
		// collapse them into one physical file. If device A creates "Note.md"
		// and device B independently creates "note.md" before ever syncing,
		// both currently sync as two separate remote objects — on a
		// case-insensitive local filesystem, downloading the second one would
		// silently overwrite the first with no conflict ever detected, because
		// our change-detector never sees them as the same path.
		const remote = new InMemoryRemote();

		const vaultA = new InMemoryVault();
		const manifestA = new SyncManifest();
		vaultA.seed("Note.md", "from A", 1);
		await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));

		const vaultB = new InMemoryVault();
		const manifestB = new SyncManifest();
		vaultB.seed("note.md", "from B", 1);
		await runSyncPass(makeCtx(vaultB, remote, manifestB, "device-b"));

		// Both objects exist independently in the remote — no conflict was ever
		// detected, because the engine has no case-folding awareness.
		expect(remote.has("Note.md")).toBe(true);
		expect(remote.has("note.md")).toBe(true);

		// This is the gap: a real case-insensitive OS would have collapsed these
		// into one file long before sync ever ran, and whichever download landed
		// last would silently clobber the other with zero conflict signal.
	});
});

describe("stale or corrupted cached remoteEtag self-heals", () => {
	it("uploads successfully by conditioning on the freshly-observed remote etag, not a stale manifest one", async () => {
		// Regression test for a live bug found 2026-07-09: applyUploadLocal used
		// to condition its If-Match on manifestEntry.remoteEtag (the LAST
		// successfully-synced value) instead of entry.remote.etag (what
		// classify() just observed THIS pass). When the cached value went bad
		// for any reason — here simulated directly, but it happened for real via
		// an ETag-header encoding bug — every retry kept failing against the
		// same wrong condition forever, with no way to self-heal.
		const remote = new InMemoryRemote();
		const vault = new InMemoryVault();
		const manifest = new SyncManifest();

		vault.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));

		const goodEntry = manifest.get("note.md")!;
		manifest.set({ ...goodEntry, remoteEtag: "totally-corrupted-etag-value" });

		vault.seed("note.md", "edited after corruption", 10);
		const result = await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));

		expect(result.errors).toHaveLength(0);
		expect(remote.readText("note.md")).toBe("edited after corruption");
		expect(manifest.get("note.md")?.remoteEtag).not.toBe("totally-corrupted-etag-value");
	});
});
