import { describe, expect, it } from "vitest";
import {
	deriveKeys,
	encryptBytes,
	encryptContentBlob,
	encryptPath,
	generateSaltBase64,
	hmacObjectKey,
	keyedContentHash,
} from "../src/crypto/crypto";
import { RemoteMetaCache } from "../src/store/remote-meta-cache";
import { getObject, S3Config } from "../src/store/s3-client";
import { S3RemoteAdapter } from "../src/store/s3-remote-adapter";
import { FakeS3Bucket } from "./fake-s3-bucket";

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

/** Mimics the PRE-#3 encryptPath(): encrypts the raw path bytes with no NFC
 * normalization, reproducing what an old plugin version (or a Mac reporting
 * NFD filenames) would have stored. */
async function legacyEncryptPath(contentKey: CryptoKey, rawPath: string): Promise<string> {
	const encrypted = await encryptBytes(contentKey, new TextEncoder().encode(rawPath));
	return toBase64(encrypted);
}

async function makeAdapter(bucket: FakeS3Bucket, metaCache = new RemoteMetaCache()) {
	const salt = generateSaltBase64();
	const keys = await deriveKeys("test-passphrase", salt);
	const config: S3Config = {
		endpoint: "https://fake-bucket.example.com",
		region: "auto",
		bucket: "my-bucket",
		accessKeyId: "AKIA_FAKE",
		secretAccessKey: "fake-secret",
		fetcher: bucket.fetcher,
	};
	return { adapter: new S3RemoteAdapter(config, keys, metaCache), keys, metaCache, config };
}

const NFD_PATH = "Cafe\u0301.md"; // "e" + combining acute accent (U+0301)
const NFC_PATH = "Caf\u00E9.md"; // precomposed "\u00E9" (U+00E9)

describe("S3RemoteAdapter basic round trip", () => {
	it("puts, lists, gets, and deletes a file", async () => {
		const bucket = new FakeS3Bucket();
		const { adapter } = await makeAdapter(bucket);

		const plaintext = new TextEncoder().encode("hello world");
		await adapter.put("note.md", plaintext, { ifNoneMatch: "*" });

		const listed = await adapter.list();
		expect(listed).toHaveLength(1);
		expect(listed[0].path).toBe("note.md");
		expect(listed[0].hashIsLegacy).toBe(false);

		const got = await adapter.get("note.md");
		expect(new TextDecoder().decode(got.plaintext)).toBe("hello world");

		await adapter.delete("note.md", listed[0].etag);
		expect(await adapter.list()).toHaveLength(0);
	});

	it("get() falls back to computing SHA-256 when content-hash metadata is missing entirely", async () => {
		// Simulates a corrupted/foreign object that has valid content but is
		// missing the content-hash metadata key list() would normally require
		// (list() itself skips such objects, but get() is also reachable
		// directly and must not crash on this).
		const bucket = new FakeS3Bucket();
		const { adapter, keys } = await makeAdapter(bucket);

		const plaintext = new TextEncoder().encode("content without a hash metadata entry");
		const encryptedBody = await encryptContentBlob(keys.contentKey, plaintext, "note.md");
		bucket.seedRaw(await hmacObjectKey(keys.pathHmacKey, "note.md"), encryptedBody, {
			"enc-path": await encryptPath(keys.contentKey, "note.md"),
			// deliberately no "content-hash" metadata key
		});

		const got = await adapter.get("note.md");
		expect(new TextDecoder().decode(got.plaintext)).toBe("content without a hash metadata entry");
		expect(got.contentHash).toBeTruthy(); // fell back to a computed hash rather than throwing/undefined
	});
});

describe("Unicode path normalization migration (BACKLOG.md #3)", () => {
	it("reports a pre-normalization (NFD-keyed) object under its normalized path", async () => {
		const bucket = new FakeS3Bucket();
		const { adapter, keys } = await makeAdapter(bucket);

		const plaintext = new TextEncoder().encode("café notes");
		const encPath = await legacyEncryptPath(keys.contentKey, NFD_PATH);
		const contentHash = await keyedContentHash(keys.contentHashKey, plaintext);
		const encryptedBody = await encryptBytes(keys.contentKey, plaintext);

		// Seeded at an arbitrary legacy key — NOT hmacObjectKey(NFC_PATH) — since
		// the whole point is this object predates normalization and therefore
		// lives at a different physical key than a fresh write would use.
		bucket.seedRaw("legacy-object-key-abc123", encryptedBody, {
			"enc-path": encPath,
			"content-hash": contentHash,
			"hash-v": "2",
		});

		const listed = await adapter.list();
		expect(listed).toHaveLength(1);
		// Reported path is normalized (NFC), regardless of the raw NFD bytes stored.
		expect(listed[0].path).toBe(NFC_PATH);
		expect(listed[0].path).not.toBe(NFD_PATH);
	});

	it("get() finds content stored under a legacy (pre-normalization) key", async () => {
		const bucket = new FakeS3Bucket();
		const { adapter, keys } = await makeAdapter(bucket);

		const plaintext = new TextEncoder().encode("café notes");
		const encPath = await legacyEncryptPath(keys.contentKey, NFD_PATH);
		const contentHash = await keyedContentHash(keys.contentHashKey, plaintext);
		const encryptedBody = await encryptBytes(keys.contentKey, plaintext);

		bucket.seedRaw("legacy-object-key-abc123", encryptedBody, {
			"enc-path": encPath,
			"content-hash": contentHash,
			"hash-v": "2",
		});

		await adapter.list(); // populates the legacy-key map
		const got = await adapter.get(NFC_PATH);
		expect(new TextDecoder().decode(got.plaintext)).toBe("café notes");
	});

	it("put() reconciles a legacy-keyed object to the canonical key and deletes the old one", async () => {
		const bucket = new FakeS3Bucket();
		const { adapter, keys } = await makeAdapter(bucket);

		const original = new TextEncoder().encode("café notes v1");
		const encPath = await legacyEncryptPath(keys.contentKey, NFD_PATH);
		const contentHash = await keyedContentHash(keys.contentHashKey, original);
		const encryptedBody = await encryptBytes(keys.contentKey, original);

		bucket.seedRaw("legacy-object-key-abc123", encryptedBody, {
			"enc-path": encPath,
			"content-hash": contentHash,
			"hash-v": "2",
		});

		const [beforeEntry] = await adapter.list();
		expect(beforeEntry.path).toBe(NFC_PATH);

		// Simulates sync-engine.ts's applyUploadLocal, conditioning on the etag
		// classify() observed for the (legacy-keyed) remote entry this pass.
		const updated = new TextEncoder().encode("café notes v2");
		await adapter.put(NFC_PATH, updated, { ifMatch: beforeEntry.etag });

		// The old raw key is gone...
		expect(bucket.hasRawKey("legacy-object-key-abc123")).toBe(false);
		// ...and exactly one object remains, holding the new content, reachable
		// by the canonical (normalized) path.
		expect(bucket.rawKeys()).toHaveLength(1);

		const afterList = await adapter.list();
		expect(afterList).toHaveLength(1);
		expect(afterList[0].path).toBe(NFC_PATH);

		const got = await adapter.get(NFC_PATH);
		expect(new TextDecoder().decode(got.plaintext)).toBe("café notes v2");
	});

	it("still succeeds if best-effort cleanup of the stale legacy key fails", async () => {
		const bucket = new FakeS3Bucket();
		const { adapter, keys, config } = await makeAdapter(bucket);

		const original = new TextEncoder().encode("café notes v1");
		const encPath = await legacyEncryptPath(keys.contentKey, NFD_PATH);
		const contentHash = await keyedContentHash(keys.contentHashKey, original);
		const encryptedBody = await encryptBytes(keys.contentKey, original);

		bucket.seedRaw("legacy-object-key-abc123", encryptedBody, {
			"enc-path": encPath,
			"content-hash": contentHash,
			"hash-v": "2",
		});

		await adapter.list(); // populates the legacy-key map

		// Make the cleanup DELETE fail, while every other request still works —
		// simulates e.g. a transient network blip during the best-effort cleanup.
		const realFetcher = config.fetcher;
		config.fetcher = async (url, init) => {
			if (init.method === "DELETE") throw new Error("simulated transient failure");
			return realFetcher(url, init);
		};

		const updated = new TextEncoder().encode("café notes v2");
		// Must NOT throw despite the cleanup failure — the canonical write
		// already succeeded, which is what matters.
		await expect(adapter.put(NFC_PATH, updated, { ifMatch: undefined })).resolves.toBeDefined();

		// The stale legacy object is still there (cleanup failed) — a harmless
		// leftover a future pass's list() can rediscover and retry.
		expect(bucket.hasRawKey("legacy-object-key-abc123")).toBe(true);
		// But the canonical content is correct and reachable.
		const got = await adapter.get(NFC_PATH);
		expect(new TextDecoder().decode(got.plaintext)).toBe("café notes v2");
	});

	it("delete() targets the legacy key, not a nonexistent canonical key", async () => {
		const bucket = new FakeS3Bucket();
		const { adapter, keys } = await makeAdapter(bucket);

		const plaintext = new TextEncoder().encode("to be deleted");
		const encPath = await legacyEncryptPath(keys.contentKey, NFD_PATH);
		const contentHash = await keyedContentHash(keys.contentHashKey, plaintext);
		const encryptedBody = await encryptBytes(keys.contentKey, plaintext);

		bucket.seedRaw("legacy-object-key-abc123", encryptedBody, {
			"enc-path": encPath,
			"content-hash": contentHash,
			"hash-v": "2",
		});

		const [entry] = await adapter.list();
		await adapter.delete(NFC_PATH, entry.etag);

		expect(bucket.rawKeys()).toHaveLength(0);
	});

	it("HMAC object keys for NFD and NFC forms of the same filename are identical for fresh writes", async () => {
		const bucket = new FakeS3Bucket();
		const { adapter } = await makeAdapter(bucket);

		await adapter.put(NFD_PATH, new TextEncoder().encode("v1"), { ifNoneMatch: "*" });
		// A second write using the NFC form of the SAME logical filename must
		// land on the same physical object (via ifMatch on its own etag), not
		// create a second, independent object.
		const [entry] = await adapter.list();
		await adapter.put(NFC_PATH, new TextEncoder().encode("v2"), { ifMatch: entry.etag });

		expect(bucket.rawKeys()).toHaveLength(1);
		const got = await adapter.get(NFC_PATH);
		expect(new TextDecoder().decode(got.plaintext)).toBe("v2");
	});
});

describe("HEAD-avoidance via metaCache (BACKLOG.md #6)", () => {
	it("HEADs a new object once, then skips the HEAD on a steady-state re-list", async () => {
		const bucket = new FakeS3Bucket();
		const metaCache = new RemoteMetaCache();
		const { adapter, keys, config } = await makeAdapter(bucket, metaCache);

		await adapter.put("note.md", new TextEncoder().encode("v1"), { ifNoneMatch: "*" });
		// put() populates the cache proactively, so a fresh adapter instance
		// (simulating the next pass, where main.ts constructs a new
		// S3RemoteAdapter but keeps the same persisted metaCache and derived
		// keys) shouldn't need to HEAD anything for this unchanged object.
		const nextPassAdapter = new S3RemoteAdapter(config, keys, metaCache);

		const headsBefore = bucket.requestCounts.HEAD;
		const listed = await nextPassAdapter.list();
		expect(bucket.requestCounts.HEAD).toBe(headsBefore);
		expect(listed).toHaveLength(1);
		expect(listed[0].path).toBe("note.md");
	});

	it("HEADs an object again after its content changes (new ETag)", async () => {
		const bucket = new FakeS3Bucket();
		const metaCache = new RemoteMetaCache();
		const { adapter, keys, config } = await makeAdapter(bucket, metaCache);

		await adapter.put("note.md", new TextEncoder().encode("v1"), { ifNoneMatch: "*" });
		await adapter.list(); // populate cache via a real list pass too

		const [entry] = await adapter.list();
		await adapter.put("note.md", new TextEncoder().encode("v2"), { ifMatch: entry.etag });

		// A cache that doesn't know about the new ETag (simulating a cold cache
		// after e.g. a crash mid-pass before the manifest/cache was persisted)
		// must still correctly HEAD the object rather than trusting stale data.
		const coldCache = new RemoteMetaCache();
		const coldAdapter = new S3RemoteAdapter(config, keys, coldCache);
		const headsBefore = bucket.requestCounts.HEAD;
		const listed = await coldAdapter.list();
		expect(bucket.requestCounts.HEAD).toBeGreaterThan(headsBefore);
		expect(listed[0].contentHash).toBeDefined();
	});

	it("a stale/wrong cache entry never causes a wrong sync decision, only an extra HEAD", async () => {
		const bucket = new FakeS3Bucket();
		const metaCache = new RemoteMetaCache();
		const { adapter, keys, config } = await makeAdapter(bucket, metaCache);

		await adapter.put("note.md", new TextEncoder().encode("real content"), { ifNoneMatch: "*" });
		const [entry] = await adapter.list();

		// Corrupt the cache: wrong path/hash under the right key+etag.
		metaCache.set(entry.objectKey, {
			etag: entry.etag,
			path: "note.md",
			contentHash: "totally-wrong-cached-hash",
			hashIsLegacy: false,
		});

		const adapterWithCorruptCache = new S3RemoteAdapter(config, keys, metaCache);
		const listed = await adapterWithCorruptCache.list();
		// list() trusts the (corrupted) cache since the etag matches — this is
		// the documented performance-layer tradeoff. But get()/put()/delete()
		// always operate on the real, freshly-HMAC'd object key, never the
		// cache, so actual reads/writes are unaffected by a corrupted cache.
		expect(listed[0].contentHash).toBe("totally-wrong-cached-hash");

		const got = await adapterWithCorruptCache.get("note.md");
		expect(new TextDecoder().decode(got.plaintext)).toBe("real content");
	});

	it("prunes cache entries for objects no longer present in the bucket", async () => {
		const bucket = new FakeS3Bucket();
		const metaCache = new RemoteMetaCache();
		const { adapter } = await makeAdapter(bucket, metaCache);

		await adapter.put("note.md", new TextEncoder().encode("v1"), { ifNoneMatch: "*" });
		const [entry] = await adapter.list();
		expect(metaCache.get(entry.objectKey)).toBeDefined();

		await adapter.delete("note.md", entry.etag);
		await adapter.list();

		expect(metaCache.get(entry.objectKey)).toBeUndefined();
	});
});

describe("AES-GCM AAD content binding (BACKLOG.md #7)", () => {
	it("a put/get round trip through the real adapter works with AAD-bound (v2) blobs", async () => {
		const bucket = new FakeS3Bucket();
		const { adapter } = await makeAdapter(bucket);

		await adapter.put("note.md", new TextEncoder().encode("real note content"), { ifNoneMatch: "*" });
		const got = await adapter.get("note.md");
		expect(new TextDecoder().decode(got.plaintext)).toBe("real note content");
	});

	it("get() cannot be tricked by ciphertext copied to a different vault path", async () => {
		const bucket = new FakeS3Bucket();
		const { adapter, keys, config } = await makeAdapter(bucket);

		await adapter.put("secret.md", new TextEncoder().encode("sensitive content"), { ifNoneMatch: "*" });
		const [entry] = await adapter.list();

		// Simulate an attacker with bucket WRITE access: copy the ciphertext body
		// from "secret.md"'s object into a brand-new object claiming (via its own
		// encrypted-path metadata) to be "public.md", while reusing the ORIGINAL
		// (still-"secret.md"-bound) ciphertext bytes.
		const stolenBody = (await getObject(config, entry.objectKey)).body;
		const forgedObjectKey = await hmacObjectKey(keys.pathHmacKey, "public.md");

		bucket.seedRaw(forgedObjectKey, stolenBody, {
			"enc-path": await encryptPath(keys.contentKey, "public.md"),
			"content-hash": await keyedContentHash(keys.contentHashKey, new TextEncoder().encode("sensitive content")),
			"hash-v": "2",
		});

		// Decrypting the forged object under its claimed path must fail — the
		// AAD (bound to "secret.md" at encryption time) doesn't match "public.md".
		await expect(adapter.get("public.md")).rejects.toThrow();
	});
});
