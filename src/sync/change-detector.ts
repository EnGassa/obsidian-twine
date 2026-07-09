import { SyncManifest } from "./manifest";
import { LocalFileState, RemoteFileState, SyncPlanEntry } from "./types";

/**
 * Pure diff logic: given the last-synced manifest plus a fresh snapshot of
 * local and remote file states, classify what needs to happen per path.
 * Deliberately storage- and vault-agnostic so it can be exercised directly
 * against mocked states in tests (see Phase 0 Spike 3 in the plan) before any
 * real R2/vault wiring exists.
 *
 * Safety property: content is never silently destroyed. A deletion racing an
 * edit always resolves in favor of keeping the edited content; only a true
 * content-vs-content divergence produces a "conflict" (handled by
 * conflict.ts, which preserves both versions as separate files).
 */
export function buildSyncPlan(
	manifest: SyncManifest,
	localStates: LocalFileState[],
	remoteStates: RemoteFileState[]
): SyncPlanEntry[] {
	const localByPath = new Map(localStates.map((s) => [s.path, s]));
	const remoteByPath = new Map(remoteStates.map((s) => [s.path, s]));

	const allPaths = new Set<string>([
		...localByPath.keys(),
		...remoteByPath.keys(),
		...manifest.allPaths(),
	]);

	const plan: SyncPlanEntry[] = [];

	for (const path of allPaths) {
		const local = localByPath.get(path);
		const remote = remoteByPath.get(path);
		const manifestEntry = manifest.get(path);

		plan.push(classify(path, local, remote, manifestEntry));
	}

	return plan;
}

function classify(
	path: string,
	local: LocalFileState | undefined,
	remote: RemoteFileState | undefined,
	manifestEntry: ReturnType<SyncManifest["get"]>
): SyncPlanEntry {
	const base = { path, local, remote, manifestEntry };

	// Neither side has the file (manifest-only stale entry) -> cleanup, no transfer.
	if (!local && !remote) {
		return { ...base, action: "noop" };
	}

	// New file on one side only, never synced before.
	if (local && !remote && !manifestEntry) {
		return { ...base, action: "uploadLocal" };
	}
	if (!local && remote && !manifestEntry) {
		return { ...base, action: "downloadRemote" };
	}

	// Local exists, remote doesn't, and we've synced this path before -> remote was deleted.
	if (local && !remote && manifestEntry) {
		const localChanged = local.contentHash !== manifestEntry.lastSyncedHash;
		// Local edited since last sync: keep the edit, resurrect on remote rather
		// than silently discarding it because the other side deleted the file.
		return { ...base, action: localChanged ? "uploadLocal" : "deleteLocal" };
	}

	// Remote exists, local doesn't, and we've synced this path before -> local was deleted.
	if (!local && remote && manifestEntry) {
		const remoteChanged = remote.contentHash !== manifestEntry.lastSyncedHash;
		// Remote edited since last sync: keep the edit, restore it locally rather
		// than propagating the local deletion over new content.
		return { ...base, action: remoteChanged ? "downloadRemote" : "deleteRemote" };
	}

	// Both sides have the file.
	if (local && remote) {
		if (!manifestEntry) {
			// Never synced before, both sides independently have this path. If the
			// remote object predates the keyed content-hash migration (BACKLOG.md
			// #2), its stored hash isn't in the same format as local.contentHash
			// (keyed HMAC) — compare against local's legacy SHA-256 instead so
			// byte-identical content isn't misclassified as a conflict.
			const matches = remote.hashIsLegacy
				? local.legacyContentHash !== undefined && local.legacyContentHash === remote.contentHash
				: local.contentHash === remote.contentHash;
			return { ...base, action: matches ? "noop" : "conflict" };
		}

		const localChanged = local.contentHash !== manifestEntry.lastSyncedHash;
		const remoteChanged = remote.contentHash !== manifestEntry.lastSyncedHash;

		if (!localChanged && !remoteChanged) return { ...base, action: "noop" };
		if (localChanged && !remoteChanged) return { ...base, action: "uploadLocal" };
		if (!localChanged && remoteChanged) return { ...base, action: "downloadRemote" };

		// Both changed: converged to the same content is a noop, otherwise conflict.
		return { ...base, action: local.contentHash === remote.contentHash ? "noop" : "conflict" };
	}

	// Unreachable given the exhaustive cases above.
	return { ...base, action: "noop" };
}
