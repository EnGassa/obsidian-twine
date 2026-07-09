import { SyncPlanEntry } from "./types";

export interface ConflictResolution {
	/** Which side's content becomes canonical at the original path. */
	winner: "local" | "remote";
	/** Path the loser's content gets written to, alongside the canonical file. */
	conflictCopyPath: string;
}

/**
 * Conflicts never silently pick a winner by discarding the other side's
 * content. Both versions always survive: the winner keeps the original path,
 * the loser is preserved as a conflicted-copy file — same pattern Obsidian
 * Sync itself uses. mtime decides which one *looks* canonical; it does not
 * decide what gets deleted, because nothing gets deleted.
 */
export function resolveConflict(entry: SyncPlanEntry, deviceName: string, now: Date = new Date()): ConflictResolution {
	if (entry.action !== "conflict" || !entry.local || !entry.remote) {
		throw new Error(`resolveConflict called on a non-conflict plan entry for ${entry.path}`);
	}

	const localTime = entry.local.mtime;
	// Remote server-side LastModified is the tiebreaker of record: local device
	// clocks can drift or be wrong, whereas the storage provider's timestamp is
	// consistent across all devices talking to the same bucket.
	const remoteTime = Date.parse(entry.remote.lastModified);

	const winner: "local" | "remote" = localTime > remoteTime ? "local" : "remote";
	const conflictCopyPath = conflictCopyName(entry.path, deviceName, now);

	return { winner, conflictCopyPath };
}

function conflictCopyName(path: string, deviceName: string, when: Date): string {
	const lastDot = path.lastIndexOf(".");
	const hasExt = lastDot > path.lastIndexOf("/");
	const base = hasExt ? path.slice(0, lastDot) : path;
	const ext = hasExt ? path.slice(lastDot) : "";

	const stamp = when.toISOString().replace("T", " ").replace(/:/g, "").slice(0, 19);
	const safeDeviceName = deviceName.replace(/[\\/:*?"<>|]/g, "-");

	return `${base} (conflicted copy ${safeDeviceName} ${stamp})${ext}`;
}
