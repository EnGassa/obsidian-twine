import { SyncPlanEntry } from "./types";

export interface ConflictResolution {
	/** Which side's content becomes canonical at the original path. */
	winner: "local" | "remote";
	/** Path the loser's content gets written to, alongside the canonical file. */
	conflictCopyPath: string;
}

/**
 * Conflicts never silently pick a winner by discarding the other side's
 * content. Both versions always survive: the remote object remains canonical
 * at the original path, while the local divergent content is preserved as a
 * conflicted-copy file. Keeping the already-committed remote object canonical
 * avoids treating local filesystem time and remote upload time as comparable.
 */
export function resolveConflict(entry: SyncPlanEntry, deviceName: string, now: Date = new Date()): ConflictResolution {
	if (entry.action !== "conflict" || !entry.local || !entry.remote) {
		throw new Error(`resolveConflict called on a non-conflict plan entry for ${entry.path}`);
	}

	const winner = "remote" as const;
	const conflictCopyPath = conflictCopyName(entry.path, deviceName, now, entry.local.contentHash);

	return { winner, conflictCopyPath };
}

function conflictCopyName(path: string, deviceName: string, when: Date, losingHash: string): string {
	const lastDot = path.lastIndexOf(".");
	const lastSlash = path.lastIndexOf("/");
	const hasExt = lastDot > lastSlash + 1;
	const base = hasExt ? path.slice(0, lastDot) : path;
	const ext = hasExt ? path.slice(lastDot) : "";

	const stamp = when.toISOString().replace("T", " ").replace(/:/g, "").replace(/Z$/, "");
	const safeDeviceName = deviceName.replace(/[\\/:*?"<>|]/g, "-");
	const shortHash = losingHash.slice(0, 8) || "unknown";

	return `${base} (conflicted copy ${safeDeviceName} ${stamp} ${shortHash})${ext}`;
}
