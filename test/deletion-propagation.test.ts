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
	return { vault, remote, manifest, deviceName, hashFn: sha256Hex, persistManifest: async () => {} };
}

/**
 * applyDeleteLocal/applyDeleteRemote (sync-engine.ts) had zero direct test
 * coverage before this file — the change-detector's "unchanged since sync,
 * other side deleted it" branches (classify() lines ~69 and ~77) are the
 * ONLY paths that ever propagate a deletion rather than resurrecting content,
 * so they deserve explicit coverage given the codebase's own stated safety
 * property ("content is never silently destroyed" — the flip side is that a
 * genuine, unmodified deletion SHOULD actually delete, not get stuck).
 */
describe("deletion propagates when the other side is genuinely unchanged", () => {
	it("deleteLocal: remote deletion propagates to a local file that was never edited since last sync", async () => {
		const remote = new InMemoryRemote();
		const vault = new InMemoryVault();
		const manifest = new SyncManifest();

		vault.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));
		expect(vault.has("note.md")).toBe(true);
		expect(remote.has("note.md")).toBe(true);

		// Remote deletes the object directly (simulating another device's
		// deleteRemote already having run), local file untouched.
		await remote.delete("note.md");

		const result = await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));
		expect(result.errors).toHaveLength(0);
		expect(vault.has("note.md")).toBe(false);
		expect(manifest.has("note.md")).toBe(false);
	});

	it("deleteRemote: local deletion propagates to remote when local was never edited since last sync", async () => {
		const remote = new InMemoryRemote();
		const vault = new InMemoryVault();
		const manifest = new SyncManifest();

		vault.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));
		expect(remote.has("note.md")).toBe(true);

		await vault.deleteFile("note.md");

		const result = await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));
		expect(result.errors).toHaveLength(0);
		expect(remote.has("note.md")).toBe(false);
		expect(manifest.has("note.md")).toBe(false);
	});

	it("a deletion that has already propagated on a prior pass is a stable no-op (doesn't error on re-delete)", async () => {
		const remote = new InMemoryRemote();
		const vault = new InMemoryVault();
		const manifest = new SyncManifest();

		vault.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));
		await vault.deleteFile("note.md");
		await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));
		expect(remote.has("note.md")).toBe(false);

		// A second pass with nothing left on either side must stay clean.
		const result = await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));
		expect(result.errors).toHaveLength(0);
		expect(remote.has("note.md")).toBe(false);
		expect(vault.has("note.md")).toBe(false);
		expect(manifest.has("note.md")).toBe(false);
	});

	it("a two-device delete/delete (both sides independently delete the same file) converges cleanly", async () => {
		const remote = new InMemoryRemote();

		const vaultA = new InMemoryVault();
		const manifestA = new SyncManifest();
		vaultA.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));

		const vaultB = new InMemoryVault();
		const manifestB = new SyncManifest();
		vaultB.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vaultB, remote, manifestB, "device-b"));

		// Both devices delete their local copy offline, then sync in either order.
		await vaultA.deleteFile("note.md");
		await vaultB.deleteFile("note.md");

		const resultA = await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));
		expect(resultA.errors).toHaveLength(0);
		expect(remote.has("note.md")).toBe(false);

		// B's delete races an already-deleted remote object — deleteObject()
		// treats 404 as success (see s3-client.ts), so this must not error.
		const resultB = await runSyncPass(makeCtx(vaultB, remote, manifestB, "device-b"));
		expect(resultB.errors).toHaveLength(0);
		expect(manifestB.has("note.md")).toBe(false);
	});
});
