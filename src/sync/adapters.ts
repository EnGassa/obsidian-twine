/**
 * Storage-agnostic interfaces the sync engine depends on. Real
 * implementations wrap the Obsidian Vault API and the R2/S3 client; test
 * code implements these against a plain in-memory Map (see Phase 0 Spike 3),
 * so the engine's conflict/race logic can be exercised without a live vault
 * or bucket.
 */

export interface VaultFileMeta {
	path: string;
	mtime: number;
	size: number;
}

export interface VaultAdapter {
	listFiles(): Promise<VaultFileMeta[]>;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, data: Uint8Array, mtime?: number): Promise<void>;
	deleteFile(path: string): Promise<void>;
	/** Real on-disk mtime/size for a just-written file, per the vault's own
	 * bookkeeping. Used after downloadRemote/conflict writes (BACKLOG.md #8)
	 * to record what the vault ACTUALLY assigned, rather than Date.now() —
	 * which nearly always differs from it (by even a few ms), causing the
	 * cheap mtime/size unchanged-check in computeLocalStates() to miss on the
	 * very next pass and force an unnecessary full re-read+re-hash. */
	stat(path: string): Promise<VaultFileMeta>;
}

export interface RemoteObjectMeta {
	/** Opaque (HMAC'd) object key as stored in the bucket. */
	objectKey: string;
	/** Real vault-relative path, recovered by decrypting metadata. */
	path: string;
	etag: string;
	lastModified: string;
	/** Plaintext content hash, carried as object metadata so it survives encryption. */
	contentHash: string;
	/** True if this object predates the keyed content-hash migration (BACKLOG.md #2). */
	hashIsLegacy?: boolean;
}

export interface RemoteGetResult {
	plaintext: Uint8Array;
	etag: string;
	contentHash: string;
}

export interface RemotePutOptions {
	ifMatch?: string;
	ifNoneMatch?: "*";
}

export interface RemoteAdapter {
	/** Lists and decrypts metadata for every object under this vault's prefix. */
	list(): Promise<RemoteObjectMeta[]>;
	/** Fetches and decrypts a single object by its real vault-relative path. */
	get(path: string): Promise<RemoteGetResult>;
	/** Encrypts and uploads plaintext under the given vault-relative path. */
	put(path: string, plaintext: Uint8Array, options?: RemotePutOptions): Promise<{ etag: string }>;
	delete(path: string, ifMatch?: string): Promise<void>;
}
