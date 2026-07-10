import { describe, expect, it, vi } from "vitest";
import { SyncManifest } from "../src/sync/manifest";
import { runSyncPass, SyncEngineContext } from "../src/sync/sync-engine";
import { sha256Hex } from "../src/util/hash";
import { RemoteAdapter } from "../src/sync/adapters";
import { InMemoryRemote, InMemoryVault } from "./mock-adapters";
import { BaseContentCache } from "../src/sync/base-cache";
import { PreconditionFailedError } from "../src/store/s3-client";

function makeCtx(
	vault: InMemoryVault,
	remote: RemoteAdapter,
	manifest: SyncManifest,
	deviceName: string,
	baseCache?: BaseContentCache
): SyncEngineContext {
	return {
		vault,
		remote,
		manifest,
		deviceName,
		hashFn: sha256Hex,
		persistManifest: async () => {},
		baseCache,
	};
}

async function makeCache(): Promise<BaseContentCache> {
	const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
	return new BaseContentCache(key as CryptoKey);
}

describe("conservative text merge integration", () => {
	it("merges non-overlapping edits without a conflict copy", async () => {
		const remote = new InMemoryRemote(); const vault = new InMemoryVault(); const manifest = new SyncManifest(); const cache = await makeCache();
		vault.seed("note.md", "a\nb\nc\nd\n", 1); await runSyncPass(makeCtx(vault, remote, manifest, "a", cache));
		expect(new TextDecoder().decode((await cache.get("note.md"))!)).toBe("a\nb\nc\nd\n");
		await remote.seed("note.md", "a\nb\nC\nd\n", new Date(2_000_000).toISOString()); vault.seed("note.md", "A\nb\nc\nd\n", 3);
		await runSyncPass(makeCtx(vault, remote, manifest, "a", cache));
		expect(vault.readText("note.md")).toBe("A\nb\nC\nd\n"); expect(vault.allPaths()).toEqual(["note.md"]); expect(remote.readText("note.md")).toBe("A\nb\nC\nd\n");
		expect(new TextDecoder().decode((await cache.get("note.md"))!)).toBe("A\nb\nC\nd\n");
	});

	it("preserves overlapping edits and missing/binary bases", async () => {
		for (const [base, local, remoteText] of [["a\n", "L\n", "R\n"], ["base", "local", "remote"]]) {
			const remote = new InMemoryRemote(); const vault = new InMemoryVault(); const manifest = new SyncManifest(); const cache = await makeCache();
			vault.seed("note.md", base, 1); await runSyncPass(makeCtx(vault, remote, manifest, "a", cache)); vault.seed("note.md", local, 2); await remote.seed("note.md", remoteText, new Date(2_000_000).toISOString());
			await runSyncPass(makeCtx(vault, remote, manifest, "a", cache)); expect(vault.allPaths().some((p) => p.includes("conflicted copy"))).toBe(true);
		}
		const remote = new InMemoryRemote(); const vault = new InMemoryVault(); const manifest = new SyncManifest(); const cache = await makeCache();
		vault.seed("bin.md", "base", 1); await runSyncPass(makeCtx(vault, remote, manifest, "a", cache)); vault.seed("bin.md", "local", 2); await remote.seed("bin.md", "remote", new Date(2_000_000).toISOString()); await cache.set("bin.md", new Uint8Array([255, 0]));
		await runSyncPass(makeCtx(vault, remote, manifest, "a", cache)); expect(vault.allPaths().some((p) => p.includes("conflicted copy"))).toBe(true);
	});

	it("falls back when the base is missing or current text is oversized", async () => {
		const remote = new InMemoryRemote(); const vault = new InMemoryVault(); const manifest = new SyncManifest(); const cache = await makeCache();
		vault.seed("note.md", "base", 1); await runSyncPass(makeCtx(vault, remote, manifest, "a")); vault.seed("note.md", "local", 2); await remote.seed("note.md", "remote", new Date(2_000_000).toISOString());
		await runSyncPass(makeCtx(vault, remote, manifest, "a", cache)); expect(vault.allPaths().some((p) => p.includes("conflicted copy"))).toBe(true);
		const big = Array.from({ length: 40000 }, (_, i) => `line-${i}`).join("\n") + "\n"; const remote2 = new InMemoryRemote(); const vault2 = new InMemoryVault(); const manifest2 = new SyncManifest(); const cache2 = await makeCache();
		vault2.seed("big.md", big, 1); await runSyncPass(makeCtx(vault2, remote2, manifest2, "a", cache2)); vault2.seed("big.md", big + "l", 2); await remote2.seed("big.md", big + "r", new Date(2_000_000).toISOString());
		await runSyncPass(makeCtx(vault2, remote2, manifest2, "a", cache2)); expect(vault2.allPaths().some((p) => p.includes("conflicted copy"))).toBe(true);
	});

	it("refreshes and removes cache entries across download and deletion", async () => {
		const remote = new InMemoryRemote(); const vault = new InMemoryVault(); const manifest = new SyncManifest(); const cache = await makeCache();
		await remote.seed("note.md", "remote", new Date().toISOString()); await runSyncPass(makeCtx(vault, remote, manifest, "a", cache));
		expect(new TextDecoder().decode((await cache.get("note.md"))!)).toBe("remote");
		await vault.deleteFile("note.md"); await runSyncPass(makeCtx(vault, remote, manifest, "a", cache));
		expect(await cache.get("note.md")).toBeUndefined();
	});
	it("falls back for malformed current-side UTF-8", async () => {
		const remote = new InMemoryRemote(); const vault = new InMemoryVault(); const manifest = new SyncManifest(); const cache = await makeCache();
		vault.seed("bad.md", "base", 1); await runSyncPass(makeCtx(vault, remote, manifest, "a", cache));
		await vault.writeFile("bad.md", new Uint8Array([0xff, 0x00]), 2); await remote.seed("bad.md", "remote edit", new Date(2_000_000).toISOString());
		await runSyncPass(makeCtx(vault, remote, manifest, "a", cache)); expect(vault.allPaths().some((p) => p.includes("conflicted copy"))).toBe(true);
	});

	it("preserves both edits when merged conditional write races", async () => {
		const remote = new InMemoryRemote(); const vault = new InMemoryVault(); const manifest = new SyncManifest(); const cache = await makeCache();
		vault.seed("note.md", "a\nb\n", 1); await runSyncPass(makeCtx(vault, remote, manifest, "a", cache)); vault.seed("note.md", "A\nb\n", 2);
		await remote.seed("note.md", "a\nB\n", new Date(2_000_000).toISOString()); vault.seed("note.md", "A\nb\n", 3);
		const racing: RemoteAdapter = { list: () => remote.list(), get: (p) => remote.get(p), delete: (p, e) => remote.delete(p, e), put: async () => { throw new PreconditionFailedError(); } };
		await runSyncPass(makeCtx(vault, racing, manifest, "a", cache)); expect(vault.allPaths().some((p) => p.includes("conflicted copy"))).toBe(true);
	});
});

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

	it("preserves repeated conflicts without overwriting or duplicating copies", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-10T12:34:56.789Z"));

		try {
			const remote = new InMemoryRemote();
			const vault = new InMemoryVault();
			const manifest = new SyncManifest();

			vault.seed("note.md", "base", 1);
			await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));

			const localOneHash = await sha256Hex(new TextEncoder().encode("local-one"));
			const occupiedCandidate =
				`note (conflicted copy device-a 2026-07-10 123456.789 ${localOneHash.slice(0, 8)}).md`;
			vault.seed(occupiedCandidate, "unrelated existing content", 2);

			await remote.seed("note.md", "remote-one", new Date(2_000_000).toISOString());
			vault.seed("note.md", "local-one", 3_000_000);
			await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));

			const firstCopies = vault.allPaths().filter((path) => path.includes("conflicted copy"));
			expect(firstCopies).toHaveLength(2);
			expect(vault.readText(occupiedCandidate)).toBe("unrelated existing content");
			expect(firstCopies.map((path) => vault.readText(path))).toEqual(
				expect.arrayContaining(["unrelated existing content", "local-one"])
			);

			// Repeating the same losing content must reuse the first copy.
			await remote.seed("note.md", "remote-two", new Date(4_000_000).toISOString());
			vault.seed("note.md", "local-one", 5_000_000);
			await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));

			const duplicateCopies = vault.allPaths().filter((path) => path.includes("conflicted copy"));
			expect(duplicateCopies).toHaveLength(2);
			expect(duplicateCopies.map((path) => vault.readText(path))).toEqual(
				expect.arrayContaining(["unrelated existing content", "local-one"])
			);

			// A distinct losing edit at the same timestamp needs its own path.
			await remote.seed("note.md", "remote-three", new Date(6_000_000).toISOString());
			vault.seed("note.md", "local-two", 7_000_000);
			await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));

			const allCopies = vault.allPaths().filter((path) => path.includes("conflicted copy"));
			expect(allCopies).toHaveLength(3);
			expect(allCopies.map((path) => vault.readText(path))).toEqual(
				expect.arrayContaining(["unrelated existing content", "local-one", "local-two"])
			);
		} finally {
			vi.useRealTimers();
		}
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

describe("mtime bookkeeping after a download (BACKLOG.md #8)", () => {
	it("does not re-read a downloaded file on the very next pass if nothing changed", async () => {
		const remote = new InMemoryRemote();
		await remote.seed("note.md", "content from remote", new Date().toISOString());

		const vault = new InMemoryVault();
		const manifest = new SyncManifest();

		// First pass: file exists only on remote -> downloadRemote.
		const firstResult = await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));
		expect(firstResult.errors).toHaveLength(0);
		expect(vault.readText("note.md")).toBe("content from remote");

		// If applyDownloadRemote recorded a wrong mtime (e.g. Date.now() instead
		// of what the vault actually assigned), this next pass's cheap
		// mtime/size check would miss, forcing computeLocalStates() to call
		// readFile() again even though nothing changed.
		const readsBefore = vault.readCounts.get("note.md") ?? 0;
		const secondResult = await runSyncPass(makeCtx(vault, remote, manifest, "device-a"));
		expect(secondResult.errors).toHaveLength(0);
		expect(vault.readCounts.get("note.md") ?? 0).toBe(readsBefore);
	});

	it("does not re-read the canonical file after a conflict resolves in favor of remote", async () => {
		const remote = new InMemoryRemote();
		const vaultA = new InMemoryVault();
		const manifestA = new SyncManifest();
		vaultA.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));

		const vaultB = new InMemoryVault();
		const manifestB = new SyncManifest();
		vaultB.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vaultB, remote, manifestB, "device-b"));

		// B edits and syncs, becoming the new remote canonical content.
		vaultB.seed("note.md", "edited by B", 10);
		await runSyncPass(makeCtx(vaultB, remote, manifestB, "device-b"));

		// A also edits offline, then syncs -> conflict. resolveConflict() picks
		// the winner by comparing local mtime to remote's server-side
		// LastModified (see conflict.ts); InMemoryRemote's clock is seeded far
		// above InMemoryVault's, so remote deterministically wins here — this
		// test needs a "remote wins" case, not a specific device-name tie-break.
		vaultA.seed("note.md", "edited by A", 20);
		const result = await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));
		expect(result.errors).toHaveLength(0);
		// Sanity: remote content actually won at the canonical path.
		expect(vaultA.readText("note.md")).toBe("edited by B");

		const readsBefore = vaultA.readCounts.get("note.md") ?? 0;
		const nextResult = await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));
		expect(nextResult.errors).toHaveLength(0);
		expect(vaultA.readCounts.get("note.md") ?? 0).toBe(readsBefore);
	});
});

describe("conflict keeps the remote version canonical", () => {
	it("preserves local content as a conflict-copy without changing the remote object", async () => {
		const remote = new InMemoryRemote();

		const vaultA = new InMemoryVault();
		const manifestA = new SyncManifest();
		vaultA.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));

		const vaultB = new InMemoryVault();
		const manifestB = new SyncManifest();
		vaultB.seed("note.md", "original", 1);
		await runSyncPass(makeCtx(vaultB, remote, manifestB, "device-b"));

		// B edits and syncs -> becomes the new remote content (with a normal,
		// small InMemoryRemote clock-derived LastModified).
		vaultB.seed("note.md", "edited by B", 10);
		await runSyncPass(makeCtx(vaultB, remote, manifestB, "device-b"));

		// A edits offline with a local mtime deliberately far in the future of
		// anything InMemoryRemote's clock will produce. The remote object remains
		// canonical because filesystem and server upload times are incomparable.
		vaultA.seed("note.md", "edited by A", 999_999_999_999);
		const result = await runSyncPass(makeCtx(vaultA, remote, manifestA, "device-a"));
		expect(result.errors).toHaveLength(0);

		// B's content remains canonical at the original path...
		expect(vaultA.readText("note.md")).toBe("edited by B");
		expect(remote.readText("note.md")).toBe("edited by B");

		// ...and A's content survives as a conflict-copy, not discarded.
		const conflictCopyPaths = vaultA.allPaths().filter((p) => p.includes("conflicted copy"));
		expect(conflictCopyPaths).toHaveLength(1);
		expect(vaultA.readText(conflictCopyPaths[0])).toBe("edited by A");

		// Manifest reflects remote's content as the freshly-synced state.
		const entry = manifestA.get("note.md");
		expect(entry?.lastSyncedHash).toBeDefined();
		expect(entry?.mtime).toBe((await vaultA.stat("note.md")).mtime);
	});
});
