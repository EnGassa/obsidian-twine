import {
	DerivedKeys,
	decryptContentBlob,
	decryptPath,
	encryptContentBlob,
	encryptPath,
	hmacObjectKey,
	keyedContentHash,
} from "../crypto/crypto";
import { sha256Hex } from "../util/hash";
import { normalizePath } from "../util/path";
import { RemoteAdapter, RemoteGetResult, RemoteObjectMeta, RemotePutOptions } from "../sync/adapters";
import { RemoteMetaCache } from "./remote-meta-cache";
import { S3Config, deleteObject, getObject, headObject, listObjects, putObject } from "./s3-client";

const META_PATH_KEY = "enc-path";
const META_HASH_KEY = "content-hash";
/** Present (value "2") only on objects written with the keyed-HMAC content
 * hash (BACKLOG.md #2). Its absence means the object's `content-hash`
 * metadata is a bare SHA-256, from before that migration. */
const META_HASH_VERSION_KEY = "hash-v";
const CURRENT_HASH_VERSION = "2";

/**
 * Adapts the encrypted S3-compatible bucket to the sync engine's generic
 * RemoteAdapter interface. Object keys in the bucket are HMAC(path) — opaque
 * to anyone without the derived key — with the real path and plaintext
 * content hash carried as encrypted/plain object metadata respectively.
 *
 * list() avoids a HEAD-per-object where possible: metaCache (BACKLOG.md #6)
 * remembers each object's decrypted metadata by ETag, so a steady-state pass
 * — the common case, run every ~20s while the app is open — only issues the
 * one LIST call and HEADs nothing. New/changed objects (ETag not in cache,
 * or not matching) still get HEAD'd exactly once, populating the cache for
 * next time.
 */
export class S3RemoteAdapter implements RemoteAdapter {
	/**
	 * Populated by list(): normalized path -> actual bucket object key, for
	 * objects whose stored (decrypted) path wasn't already NFC-normalized when
	 * it was written — i.e. from a pre-normalization version of the plugin, or
	 * a device whose OS reports paths in NFD (BACKLOG.md #3). HMAC(path) is
	 * computed from the NORMALIZED path everywhere in this class, so such an
	 * object physically lives at a different key than a fresh write of the
	 * same logical path would use. get/put/delete below consult this map so a
	 * single logical path never silently splits into two remote objects, and
	 * so put()/delete() don't apply a caller's ifMatch/etag (captured against
	 * this legacy key) to the wrong (nonexistent) canonical key.
	 */
	private legacyKeysByPath = new Map<string, string>();

	constructor(
		private readonly config: S3Config,
		private readonly keys: DerivedKeys,
		private readonly metaCache: RemoteMetaCache = new RemoteMetaCache()
	) {}

	async list(): Promise<RemoteObjectMeta[]> {
		this.legacyKeysByPath.clear();
		const objects = await listObjects(this.config, "");
		const results: RemoteObjectMeta[] = [];
		const seenKeys = new Set<string>();

		for (const obj of objects) {
			seenKeys.add(obj.key);
			const cached = this.metaCache.get(obj.key);

			let path: string;
			let contentHash: string;
			let hashIsLegacy: boolean;

			if (cached && cached.etag === obj.etag) {
				({ path, contentHash, hashIsLegacy } = cached);
			} else {
				const head = await headObject(this.config, obj.key);
				const encPath = head.metadata[META_PATH_KEY];
				const rawHash = head.metadata[META_HASH_KEY];
				if (!encPath || !rawHash) continue; // not one of our objects, skip

				const rawPath = await decryptPath(this.keys.contentKey, encPath);
				path = normalizePath(rawPath);
				contentHash = rawHash;
				hashIsLegacy = head.metadata[META_HASH_VERSION_KEY] !== CURRENT_HASH_VERSION;

				this.metaCache.set(obj.key, { etag: obj.etag, path, contentHash, hashIsLegacy });
			}

			// Cheap (pure crypto, no network) so this always runs, cache hit or
			// miss — needed on every pass to keep legacyKeysByPath current, since
			// it's rebuilt from scratch each list() call.
			const canonicalKey = await hmacObjectKey(this.keys.pathHmacKey, path);
			if (canonicalKey !== obj.key) this.legacyKeysByPath.set(path, obj.key);

			results.push({ objectKey: obj.key, path, etag: obj.etag, lastModified: obj.lastModified, contentHash, hashIsLegacy });
		}

		this.metaCache.retainOnly(seenKeys);
		return results;
	}

	async get(path: string): Promise<RemoteGetResult> {
		const normalized = normalizePath(path);
		const objectKey = this.legacyKeysByPath.get(normalized) ?? (await hmacObjectKey(this.keys.pathHmacKey, normalized));
		const result = await getObject(this.config, objectKey);
		// decryptContentBlob() tries the AAD-bound format first (bound to
		// `normalized`) and falls back to the pre-#7 unbound format — see
		// BACKLOG.md #7. Note this means a legacy-keyed object (BACKLOG.md #3,
		// content stored under a DIFFERENT path at write time) still decrypts:
		// pre-#7 blobs have no AAD to mismatch in the first place.
		const plaintext = await decryptContentBlob(this.keys.contentKey, result.body, normalized);
		const contentHash = result.metadata[META_HASH_KEY] ?? (await sha256Hex(plaintext));

		return { plaintext, etag: result.etag, contentHash };
	}

	async put(path: string, plaintext: Uint8Array, options: RemotePutOptions = {}): Promise<{ etag: string }> {
		const normalized = normalizePath(path);
		const legacyKey = this.legacyKeysByPath.get(normalized);
		const objectKey = await hmacObjectKey(this.keys.pathHmacKey, normalized);

		const [encPath, contentHash, encryptedBody] = await Promise.all([
			encryptPath(this.keys.contentKey, normalized),
			keyedContentHash(this.keys.contentHashKey, plaintext),
			encryptContentBlob(this.keys.contentKey, plaintext, normalized),
		]);

		// The canonical (normalized-path) key doesn't exist yet when a legacy key
		// is on record — the caller's ifMatch/ifNoneMatch was computed against
		// the legacy key's observed state, which doesn't apply at this key.
		// ifNoneMatch:"*" is the correct condition: this write should only
		// proceed if nothing has raced us to create the canonical key already.
		const writeOptions = legacyKey
			? { ifNoneMatch: "*" as const }
			: { ifMatch: options.ifMatch, ifNoneMatch: options.ifNoneMatch };

		const result = await putObject(this.config, objectKey, encryptedBody, {
			...writeOptions,
			contentType: "application/octet-stream",
			metadata: {
				[META_PATH_KEY]: encPath,
				[META_HASH_KEY]: contentHash,
				[META_HASH_VERSION_KEY]: CURRENT_HASH_VERSION,
			},
		});

		if (legacyKey) {
			// Best-effort cleanup: the canonical copy above is already safely
			// written, so a failure here just leaves a harmless stale duplicate
			// for a future list() to notice and retry — not worth failing the
			// whole put over.
			try {
				await deleteObject(this.config, legacyKey);
			} catch {
				// ignore — see comment above
			}
			this.legacyKeysByPath.delete(normalized);
		}

		// Populate the cache immediately with what we just wrote, so a later
		// pass's list() doesn't need to HEAD this object to learn what its own
		// write already told it.
		this.metaCache.set(objectKey, { etag: result.etag, path: normalized, contentHash, hashIsLegacy: false });

		return result;
	}

	async delete(path: string, ifMatch?: string): Promise<void> {
		const normalized = normalizePath(path);
		const legacyKey = this.legacyKeysByPath.get(normalized);
		const objectKey = legacyKey ?? (await hmacObjectKey(this.keys.pathHmacKey, normalized));
		await deleteObject(this.config, objectKey, ifMatch);
		if (legacyKey) this.legacyKeysByPath.delete(normalized);
	}
}
