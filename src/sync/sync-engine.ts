import { RemoteAdapter, VaultAdapter } from "./adapters";
import { buildSyncPlan } from "./change-detector";
import { resolveConflict } from "./conflict";
import { SyncManifest } from "./manifest";
import { LocalFileState, RemoteFileState, SyncPlanEntry } from "./types";
import { PreconditionFailedError } from "../store/s3-client";
import { sha256Hex } from "../util/hash";

export interface SyncEngineContext {
	vault: VaultAdapter;
	remote: RemoteAdapter;
	manifest: SyncManifest;
	deviceName: string;
	hashFn: (bytes: Uint8Array) => Promise<string>;
	/** Persist the manifest after every successful mutation, not just at pass end —
	 * so a crash mid-pass doesn't lose progress already made (Spike 3 test case). */
	persistManifest: () => Promise<void>;
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
}

async function applyConflict(ctx: SyncEngineContext, entry: SyncPlanEntry): Promise<void> {
	const resolution = resolveConflict(entry, ctx.deviceName);
	const remoteResult = await ctx.remote.get(entry.path);

	if (resolution.winner === "local") {
		// Local content becomes canonical: push it to remote, and preserve the
		// remote's divergent content as a conflict-copy file so nothing is lost.
		await ctx.vault.writeFile(resolution.conflictCopyPath, remoteResult.plaintext);

		const localBytes = await ctx.vault.readFile(entry.path);
		const { etag } = await ctx.remote.put(entry.path, localBytes, {
			ifMatch: entry.remote!.etag,
		});

		ctx.manifest.set({
			path: entry.path,
			contentHash: entry.local!.contentHash,
			mtime: entry.local!.mtime,
			size: entry.local!.size,
			remoteEtag: etag,
			lastSyncedHash: entry.local!.contentHash,
		});
	} else {
		// Remote content becomes canonical: preserve the local divergent content
		// as a conflict-copy file, then overwrite the canonical path with remote's.
		const localBytes = await ctx.vault.readFile(entry.path);
		await ctx.vault.writeFile(resolution.conflictCopyPath, localBytes);
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
	}

	// The conflict-copy file is intentionally left untracked in the manifest:
	// the next sync pass will see it as a brand-new local file and upload it,
	// no special-casing needed.
}

async function applyDeleteLocal(ctx: SyncEngineContext, entry: SyncPlanEntry): Promise<void> {
	await ctx.vault.deleteFile(entry.path);
	ctx.manifest.delete(entry.path);
}

async function applyDeleteRemote(ctx: SyncEngineContext, entry: SyncPlanEntry): Promise<void> {
	// Same reasoning as applyUploadLocal: condition on the freshly-observed
	// remote etag, not a potentially stale/corrupted cached manifest value.
	await ctx.remote.delete(entry.path, entry.remote?.etag);
	ctx.manifest.delete(entry.path);
}
