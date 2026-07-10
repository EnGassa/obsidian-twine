import { RemoteAdapter, VaultAdapter } from "./adapters";
import { buildSyncPlan } from "./change-detector";
import { resolveConflict } from "./conflict";
import { SyncManifest } from "./manifest";
import { LocalFileState, RemoteFileState, SyncPlanEntry } from "./types";
import { PreconditionFailedError } from "../store/s3-client";
import { sha256Hex } from "../util/hash";
import { BaseContentCache, isBaseCacheEligibleBytes } from "./base-cache";
import { mergeText } from "./text-merge";

export interface SyncEngineContext {
	vault: VaultAdapter;
	remote: RemoteAdapter;
	manifest: SyncManifest;
	deviceName: string;
	hashFn: (bytes: Uint8Array) => Promise<string>;
	/** Persist the manifest after every successful mutation, not just at pass end —
	 * so a crash mid-pass doesn't lose progress already made (Spike 3 test case). */
	persistManifest: () => Promise<void>;
	baseCache?: BaseContentCache;
	log?: (message: string) => void;
}

export interface SyncPassResult {
	plan: SyncPlanEntry[];
	errors: { path: string; error: unknown }[];
}

/** Builds fresh local file states, rehashing only files whose mtime/size changed
 * since the last sync (the manifest's cheap check), per plan section 2.2. */
async function computeLocalStates(ctx: SyncEngineContext): Promise<LocalFileState[]> {
	const files = await ctx.vault.listFiles();
	const states: LocalFileState[] = [];

	for (const file of files) {
		const manifestEntry = ctx.manifest.get(file.path);
		const unchangedSinceSync =
			manifestEntry !== undefined &&
			manifestEntry.mtime === file.mtime &&
			manifestEntry.size === file.size;

		if (unchangedSinceSync) {
			states.push({
				path: file.path,
				contentHash: manifestEntry.contentHash,
				mtime: file.mtime,
				size: file.size,
			});
			continue;
		}

		const bytes = await ctx.vault.readFile(file.path);
		const contentHash = await ctx.hashFn(bytes);

		// No manifest baseline for this path means change-detector.ts may need to
		// compare directly against a remote object's hash with no prior sync to
		// anchor the comparison. If that remote object predates the keyed
		// content-hash migration (BACKLOG.md #2), its stored hash is a bare
		// SHA-256 — compute that here too (bytes are already in hand) so
		// identical content isn't misclassified as a conflict. Cheap: this branch
		// only runs for genuinely new-to-this-device paths, not the common
		// unchanged-file steady state above.
		const legacyContentHash = manifestEntry === undefined ? await sha256Hex(bytes) : undefined;

		states.push({ path: file.path, contentHash, mtime: file.mtime, size: file.size, legacyContentHash });
	}

	return states;
}

async function computeRemoteStates(ctx: SyncEngineContext): Promise<RemoteFileState[]> {
	const objects = await ctx.remote.list();
	return objects.map((o) => ({
		path: o.path,
		contentHash: o.contentHash,
		etag: o.etag,
		lastModified: o.lastModified,
	}));
}

export async function runSyncPass(ctx: SyncEngineContext): Promise<SyncPassResult> {
	const [localStates, remoteStates] = await Promise.all([
		computeLocalStates(ctx),
		computeRemoteStates(ctx),
	]);

	const plan = buildSyncPlan(ctx.manifest, localStates, remoteStates);
	const errors: { path: string; error: unknown }[] = [];

	for (const entry of plan) {
		if (entry.action === "noop") {
			if (reconcileNoopManifest(ctx.manifest, entry)) await ctx.persistManifest();
			if (entry.local && entry.remote && ctx.baseCache) {
				try {
					await ctx.baseCache.set(entry.path, await ctx.vault.readFile(entry.path));
				} catch {
					// Cache refresh is best-effort and must not fail a sync pass.
				}
			}
			continue;
		}

		try {
			await applyEntry(ctx, entry);
			await ctx.persistManifest();
		} catch (error) {
			if (error instanceof PreconditionFailedError) {
				// Remote changed concurrently since we listed it. Don't update the
				// manifest for this path — leaving it stale means next pass will
				// re-list, re-classify, and reconcile against the current remote state.
				ctx.log?.(`Conflict on concurrent write for ${entry.path}, will reconcile next pass`);
			} else {
				ctx.log?.(`Sync error for ${entry.path}: ${String(error)}`);
				errors.push({ path: entry.path, error });
			}
		}
	}

	return { plan, errors };
}

/**
 * A "noop" classification means local and remote already agree — but that
 * can be true the very first time this device ever sees the path (e.g. two
 * devices independently syncing identical baseline content, or a prior pass
 * converged both sides to the same hash after a would-be conflict). Without
 * recording that agreement in the manifest, this device would treat the path
 * as "never synced" forever, breaking all future divergence detection for
 * it. Returns true if the manifest was changed (caller persists only then).
 */
function reconcileNoopManifest(manifest: SyncManifest, entry: SyncPlanEntry): boolean {
	if (!entry.local && !entry.remote) {
		if (manifest.has(entry.path)) {
			manifest.delete(entry.path);
			return true;
		}
		return false;
	}

	if (entry.local && entry.remote) {
		const upToDate =
			entry.manifestEntry !== undefined &&
			entry.manifestEntry.lastSyncedHash === entry.local.contentHash &&
			entry.manifestEntry.remoteEtag === entry.remote.etag;

		if (upToDate) return false;

		manifest.set({
			path: entry.path,
			contentHash: entry.local.contentHash,
			mtime: entry.local.mtime,
			size: entry.local.size,
			remoteEtag: entry.remote.etag,
			lastSyncedHash: entry.local.contentHash,
		});
		return true;
	}

	return false;
}

async function applyEntry(ctx: SyncEngineContext, entry: SyncPlanEntry): Promise<void> {
	switch (entry.action) {
		case "uploadLocal":
			return applyUploadLocal(ctx, entry);
		case "downloadRemote":
			return applyDownloadRemote(ctx, entry);
		case "conflict":
			return applyConflict(ctx, entry);
		case "deleteLocal":
			return applyDeleteLocal(ctx, entry);
		case "deleteRemote":
			return applyDeleteRemote(ctx, entry);
		case "noop":
			return;
	}
}

async function applyUploadLocal(ctx: SyncEngineContext, entry: SyncPlanEntry): Promise<void> {
	const local = entry.local!;
	const bytes = await ctx.vault.readFile(entry.path);
	const contentHash = local.contentHash;

	// Condition on the etag classify() just observed THIS pass (entry.remote),
	// not the manifest's cached one — the cached value can go stale or (as
	// happened live 2026-07-09) get corrupted, and conditioning on it instead
	// of the freshly-listed remote state means a bad cached value can never
	// self-heal: every retry keeps failing against the same wrong condition.
	const options = entry.remote ? { ifMatch: entry.remote.etag } : { ifNoneMatch: "*" as const };

	const { etag } = await ctx.remote.put(entry.path, bytes, options);

	ctx.manifest.set({
		path: entry.path,
		contentHash,
		mtime: local.mtime,
		size: local.size,
		remoteEtag: etag,
		lastSyncedHash: contentHash,
	});
	await ctx.baseCache?.set(entry.path, bytes);
}

async function applyDownloadRemote(ctx: SyncEngineContext, entry: SyncPlanEntry): Promise<void> {
	const result = await ctx.remote.get(entry.path);
	await ctx.vault.writeFile(entry.path, result.plaintext);
	// Real mtime the vault just assigned, not Date.now() — see adapters.ts'
	// VaultAdapter#stat doc comment (BACKLOG.md #8): using the wrong value here
	// makes computeLocalStates() miss its cheap unchanged-check on every single
	// pass after a download, forcing a needless full re-read+re-hash forever.
	const stat = await ctx.vault.stat(entry.path);

	ctx.manifest.set({
		path: entry.path,
		contentHash: result.contentHash,
		mtime: stat.mtime,
		size: stat.size,
		remoteEtag: result.etag,
		lastSyncedHash: result.contentHash,
	});
	await ctx.baseCache?.set(entry.path, result.plaintext);
}

async function applyConflict(ctx: SyncEngineContext, entry: SyncPlanEntry): Promise<void> {
	const remoteResult = await ctx.remote.get(entry.path);
	const localBytes = await ctx.vault.readFile(entry.path);

	// Attempt a diff3 merge only with an authenticated, cached text base and
	// decodable text on both current sides. Any ambiguity falls through to the
	// lossless conflict-copy behavior below.
	const baseBytes = await ctx.baseCache?.get(entry.path);
	if (baseBytes && isBaseCacheEligibleBytes(entry.path, localBytes) && isBaseCacheEligibleBytes(entry.path, remoteResult.plaintext)) {
		let base: string;
		let local: string;
		let remote: string;
		try {
			const decoder = new TextDecoder("utf-8", { fatal: true });
			base = decoder.decode(baseBytes);
			local = decoder.decode(localBytes);
			remote = decoder.decode(remoteResult.plaintext);
		} catch {
			// Unsupported/binary or malformed UTF-8 content uses preservation.
			base = local = remote = "";
		}
		if (base || local || remote || (baseBytes.byteLength === 0 && localBytes.byteLength === 0 && remoteResult.plaintext.byteLength === 0)) {
			const merged = mergeText(base, local, remote);
			if (merged.status === "merged") {
				const mergedBytes = new TextEncoder().encode(merged.text);
				try {
					const { etag } = await ctx.remote.put(entry.path, mergedBytes, { ifMatch: remoteResult.etag });
					await ctx.vault.writeFile(entry.path, mergedBytes);
					const stat = await ctx.vault.stat(entry.path);
					const contentHash = await ctx.hashFn(mergedBytes);
					ctx.manifest.set({ path: entry.path, contentHash, mtime: stat.mtime, size: stat.size, remoteEtag: etag, lastSyncedHash: contentHash });
					await ctx.baseCache?.set(entry.path, mergedBytes);
					return;
				} catch (error) {
					if (!(error instanceof PreconditionFailedError)) throw error;
					const latest = await ctx.remote.get(entry.path);
					await preserveConflict(ctx, entry, localBytes, latest);
					return;
				}
			}
		}
	}

	await preserveConflict(ctx, entry, localBytes, remoteResult);
}

async function preserveConflict(ctx: SyncEngineContext, entry: SyncPlanEntry, localBytes: Uint8Array, remoteResult: { plaintext: Uint8Array; etag: string; contentHash: string }): Promise<void> {
	const resolution = resolveConflict(entry, ctx.deviceName);
	// The remote object remains canonical. Preserve the local divergent content
	// at a collision-proof path, then replace the local original with remote's.
	const copy = await allocateConflictCopy(ctx, resolution.conflictCopyPath, localBytes);
	if (!copy.reused) await ctx.vault.writeFile(copy.path, localBytes);
	await ctx.vault.writeFile(entry.path, remoteResult.plaintext);
	// Real mtime the vault just assigned — see applyDownloadRemote's comment
	// and BACKLOG.md #8.
	const stat = await ctx.vault.stat(entry.path);

	ctx.manifest.set({
		path: entry.path,
		contentHash: remoteResult.contentHash,
		mtime: stat.mtime,
		size: stat.size,
		remoteEtag: remoteResult.etag,
		lastSyncedHash: remoteResult.contentHash,
	});
	await ctx.baseCache?.set(entry.path, remoteResult.plaintext);

	// The conflict-copy file is intentionally left untracked in the manifest:
	// the next sync pass will see it as a brand-new local file and upload it,
	// no special-casing needed.
}

async function allocateConflictCopy(
	ctx: SyncEngineContext,
	basePath: string,
	content: Uint8Array
): Promise<{ path: string; reused: boolean }> {
	const occupied = new Set((await ctx.vault.listFiles()).map((file) => file.path));

	for (let suffix = 1; suffix <= 10_000; suffix++) {
		const candidate = suffix === 1 ? basePath : appendNumericSuffix(basePath, suffix);
		if (!occupied.has(candidate)) return { path: candidate, reused: false };

		const existing = await ctx.vault.readFile(candidate);
		if (bytesEqual(existing, content)) return { path: candidate, reused: true };
	}

	throw new Error(`Unable to allocate a unique conflict-copy path for ${basePath}`);
}

function appendNumericSuffix(path: string, suffix: number): string {
	const lastDot = path.lastIndexOf(".");
	const lastSlash = path.lastIndexOf("/");
	if (lastDot > lastSlash + 1) return `${path.slice(0, lastDot)} ${suffix}${path.slice(lastDot)}`;
	return `${path} ${suffix}`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

async function applyDeleteLocal(ctx: SyncEngineContext, entry: SyncPlanEntry): Promise<void> {
	await ctx.vault.deleteFile(entry.path);
	ctx.manifest.delete(entry.path);
	ctx.baseCache?.delete(entry.path);
}

async function applyDeleteRemote(ctx: SyncEngineContext, entry: SyncPlanEntry): Promise<void> {
	// Same reasoning as applyUploadLocal: condition on the freshly-observed
	// remote etag, not a potentially stale/corrupted cached manifest value.
	await ctx.remote.delete(entry.path, entry.remote?.etag);
	ctx.manifest.delete(entry.path);
	ctx.baseCache?.delete(entry.path);
}
