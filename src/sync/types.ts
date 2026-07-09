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
}

export interface RemoteFileState {
	path: string;
	contentHash: string;
	etag: string;
	lastModified: string;
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
