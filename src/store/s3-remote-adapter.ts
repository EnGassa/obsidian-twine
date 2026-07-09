import { DerivedKeys, decryptBytes, decryptPath, encryptBytes, encryptPath, hmacObjectKey } from "../crypto/crypto";
import { sha256Hex } from "../util/hash";
import { RemoteAdapter, RemoteGetResult, RemoteObjectMeta, RemotePutOptions } from "../sync/adapters";
import { S3Config, deleteObject, getObject, headObject, listObjects, putObject } from "./s3-client";

const META_PATH_KEY = "enc-path";
const META_HASH_KEY = "content-hash";

/**
 * Adapts the encrypted S3-compatible bucket to the sync engine's generic
 * RemoteAdapter interface. Object keys in the bucket are HMAC(path) — opaque
 * to anyone without the derived key — with the real path and plaintext
 * content hash carried as encrypted/plain object metadata respectively.
 *
 * Note: list() does a HEAD request per bucket object to recover metadata,
 * since S3 ListObjectsV2 doesn't return custom metadata. Fine at personal
 * vault scale (hundreds of files); a future optimization could skip the HEAD
 * for objects whose ETag matches what's already in the local manifest.
 */
export class S3RemoteAdapter implements RemoteAdapter {
	constructor(
		private readonly config: S3Config,
		private readonly keys: DerivedKeys
	) {}

	async list(): Promise<RemoteObjectMeta[]> {
		const objects = await listObjects(this.config, "");
		const results: RemoteObjectMeta[] = [];

		for (const obj of objects) {
			const head = await headObject(this.config, obj.key);
			const encPath = head.metadata[META_PATH_KEY];
			const contentHash = head.metadata[META_HASH_KEY];
			if (!encPath || !contentHash) continue; // not one of our objects, skip

			const path = await decryptPath(this.keys.contentKey, encPath);
			results.push({ objectKey: obj.key, path, etag: obj.etag, lastModified: obj.lastModified, contentHash });
		}

		return results;
	}

	async get(path: string): Promise<RemoteGetResult> {
		const objectKey = await hmacObjectKey(this.keys.pathHmacKey, path);
		const result = await getObject(this.config, objectKey);
		const plaintext = await decryptBytes(this.keys.contentKey, result.body);
		const contentHash = result.metadata[META_HASH_KEY] ?? (await sha256Hex(plaintext));

		return { plaintext, etag: result.etag, contentHash };
	}

	async put(path: string, plaintext: Uint8Array, options: RemotePutOptions = {}): Promise<{ etag: string }> {
		const objectKey = await hmacObjectKey(this.keys.pathHmacKey, path);
		const [encPath, contentHash, encryptedBody] = await Promise.all([
			encryptPath(this.keys.contentKey, path),
			sha256Hex(plaintext),
			encryptBytes(this.keys.contentKey, plaintext),
		]);

		return putObject(this.config, objectKey, encryptedBody, {
			ifMatch: options.ifMatch,
			ifNoneMatch: options.ifNoneMatch,
			contentType: "application/octet-stream",
			metadata: { [META_PATH_KEY]: encPath, [META_HASH_KEY]: contentHash },
		});
	}

	async delete(path: string, ifMatch?: string): Promise<void> {
		const objectKey = await hmacObjectKey(this.keys.pathHmacKey, path);
		await deleteObject(this.config, objectKey, ifMatch);
	}
}
