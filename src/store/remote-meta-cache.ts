export interface CachedObjectMeta {
	etag: string;
	path: string;
	contentHash: string;
	hashIsLegacy: boolean;
}

/**
 * Persisted cache of decrypted object metadata (path, content hash, hash
 * version), keyed by raw bucket object key, so a steady-state list() pass
 * can skip the per-object HEAD request whenever the freshly-listed ETag
 * still matches what's cached — see BACKLOG.md #6. Without this, every pass
 * (every ~20s while the app is open) issues one HEAD per bucket object just
 * to recover metadata that S3's LIST response doesn't include.
 *
 * NOT the sync manifest: the manifest is keyed by vault path and tracks
 * per-device sync state (what was last successfully synced). This cache is
 * keyed by raw bucket object key and only remembers "what does this
 * specific object's metadata currently decrypt to" — a pure performance
 * layer. If it's ever empty, stale, or wrong, list() just falls back to
 * HEADing that object; it can never cause a wrong sync decision, only an
 * avoidable HEAD request.
 */
export class RemoteMetaCache {
	private entries: Map<string, CachedObjectMeta>;

	constructor(initial: Record<string, CachedObjectMeta> = {}) {
		this.entries = new Map(Object.entries(initial));
	}

	static fromJSON(data: unknown): RemoteMetaCache {
		if (data && typeof data === "object" && !Array.isArray(data)) {
			return new RemoteMetaCache(data as Record<string, CachedObjectMeta>);
		}
		return new RemoteMetaCache();
	}

	toJSON(): Record<string, CachedObjectMeta> {
		return Object.fromEntries(this.entries);
	}

	get(objectKey: string): CachedObjectMeta | undefined {
		return this.entries.get(objectKey);
	}

	set(objectKey: string, meta: CachedObjectMeta): void {
		this.entries.set(objectKey, meta);
	}

	/** Drops entries for object keys not present in the given set — called
	 * after each list() so the cache doesn't grow unboundedly as objects are
	 * deleted, renamed (re-keyed), or reconciled off a legacy key. */
	retainOnly(objectKeys: ReadonlySet<string>): void {
		for (const key of this.entries.keys()) {
			if (!objectKeys.has(key)) this.entries.delete(key);
		}
	}
}
