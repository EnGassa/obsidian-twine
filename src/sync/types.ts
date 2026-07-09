/** Shared types for the sync engine. */

export interface ManifestEntry {
	path: string;
	contentHash: string;
	mtime: number;
	size: number;
	/** ETag of the object as last observed on the remote after a successful sync. */
	remoteEtag: string;
	/** Content hash as last observed on the remote after a successful sync. */
	lastSyncedHash: string;
	deleted?: boolean;
}

export interface LocalFileState {
	path: string;
	contentHash: string;
	mtime: number;
	size: number;
	/**
	 * Legacy (unkeyed SHA-256) hash of the same content, computed only when
	 * there's no manifest baseline to compare against (see change-detector.ts
	 * "no manifestEntry" branches). Lets a first-ever sync of a path correctly
	 * recognize it as unchanged against a pre-migration remote object instead
	 * of misclassifying identical content as a conflict. See BACKLOG.md #2.
	 */
	legacyContentHash?: string;
}

export interface RemoteFileState {
	path: string;
	contentHash: string;
	etag: string;
	lastModified: string;
	/** True if this object predates the keyed content-hash migration (BACKLOG.md #2)
	 * and `contentHash` is therefore a bare SHA-256, not an HMAC. */
	hashIsLegacy?: boolean;
}

export type SyncAction =
	| "noop"
	| "uploadLocal"
	| "downloadRemote"
	| "conflict"
	| "deleteLocal"
	| "deleteRemote";

export interface SyncPlanEntry {
	path: string;
	action: SyncAction;
	local?: LocalFileState;
	remote?: RemoteFileState;
	manifestEntry?: ManifestEntry;
}
