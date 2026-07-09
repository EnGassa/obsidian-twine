import { describe, expect, it } from "vitest";
import { deriveKeys, encryptBytes, generateSaltBase64 } from "../src/crypto/crypto";
import { RemoteMetaCache } from "../src/store/remote-meta-cache";
import { S3Config } from "../src/store/s3-client";
import { S3RemoteAdapter } from "../src/store/s3-remote-adapter";
import { buildSyncPlan } from "../src/sync/change-detector";
import { SyncManifest } from "../src/sync/manifest";
import { sha256Hex } from "../src/util/hash";
import { FakeS3Bucket } from "./fake-s3-bucket";

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

async function makeAdapter(bucket: FakeS3Bucket) {
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
	return { adapter: new S3RemoteAdapter(config, keys, new RemoteMetaCache()), keys, config };
}

const NFD_PATH = "Café.md"; // "e" + combining acute accent (U+0301)
const NFC_PATH = "Café.md"; // precomposed "é" (U+00E9)

/**
 * Each migration item (#2 keyed hash, #3 path normalization, #7 AAD binding)
 * was tested in isolation. This exercises the worst case: a single object
 * that predates ALL THREE migrations at once (a real possibility — any
 * object written by the very first pre-migration release, on a Mac, still
 * sitting in someone's bucket today) — the oldest possible on-disk format:
 * - plaintext SHA-256 content-hash metadata, no hash-v marker (pre-#2)
 * - encrypted path stored in raw NFD form, object keyed by HMAC(NFD) (pre-#3)
 * - content ciphertext with no version byte and no AAD (pre-#7)
 */
describe("an object predating all three migrations at once reconciles correctly", () => {
	it("list() correctly identifies it as legacy on every axis, and get() still decrypts it", async () => {
		const bucket = new FakeS3Bucket();
		const { adapter, keys } = await makeAdapter(bucket);

		const plaintext = new TextEncoder().encode("café notes from the very first release");

		// Simulate the oldest possible write: encryptPath() with NO normalization,
		// encryptBytes() with NO AAD/version byte, and a bare SHA-256 content hash.
		const legacyEncPath = toBase64(await encryptBytes(keys.contentKey, new TextEncoder().encode(NFD_PATH)));
		const legacyBody = await encryptBytes(keys.contentKey, plaintext); // no AAD, no version byte
		const legacyHash = await sha256Hex(plaintext); // bare SHA-256, no hash-v marker

		bucket.seedRaw("ancient-legacy-object-key", legacyBody, {
			"enc-path": legacyEncPath,
			"content-hash": legacyHash,
			// deliberately no "hash-v" key at all
		});

		const listed = await adapter.list();
		expect(listed).toHaveLength(1);
		expect(listed[0].path).toBe(NFC_PATH); // path migration: reported normalized
		expect(listed[0].hashIsLegacy).toBe(true); // hash migration: correctly flagged legacy
		expect(listed[0].contentHash).toBe(legacyHash);

		// get() must still decrypt despite no AAD/version byte having ever existed.
		const got = await adapter.get(NFC_PATH);
		expect(new TextDecoder().decode(got.plaintext)).toBe("café notes from the very first release");
	});

	it("a single re-upload fully migrates the object across all three axes at once", async () => {
		const bucket = new FakeS3Bucket();
		const { adapter, keys } = await makeAdapter(bucket);

		const original = new TextEncoder().encode("café notes v1");
		const legacyEncPath = toBase64(await encryptBytes(keys.contentKey, new TextEncoder().encode(NFD_PATH)));
		const legacyBody = await encryptBytes(keys.contentKey, original);
		const legacyHash = await sha256Hex(original);

		bucket.seedRaw("ancient-legacy-object-key", legacyBody, {
			"enc-path": legacyEncPath,
			"content-hash": legacyHash,
		});

		const [before] = await adapter.list();
		expect(before.hashIsLegacy).toBe(true);

		// A normal reconciling upload — exactly what applyUploadLocal does after
		// change-detector.ts's legacy-hash-aware comparison decides this path
		// needs (re-)uploading.
		const updated = new TextEncoder().encode("café notes v2");
		await adapter.put(NFC_PATH, updated, { ifMatch: before.etag });

		// Old key is gone, replaced by exactly one fully-migrated object.
		expect(bucket.hasRawKey("ancient-legacy-object-key")).toBe(false);
		expect(bucket.rawKeys()).toHaveLength(1);

		const [after] = await adapter.list();
		expect(after.path).toBe(NFC_PATH);
		expect(after.hashIsLegacy).toBe(false); // now keyed-HMAC, not bare SHA-256

		// Content decrypts via the new AAD-bound path too.
		const got = await adapter.get(NFC_PATH);
		expect(new TextDecoder().decode(got.plaintext)).toBe("café notes v2");
	});

	it("a first-ever sync of a fully-legacy bucket from a brand-new device converges without a spurious conflict", async () => {
		// This is the change-detector.ts scenario BACKLOG.md #2's migration note
		// worried about most: a device with NO manifest entry (never seen this
		// path before) syncing against a fully-legacy remote object whose
		// content happens to be byte-IDENTICAL to what's already on local disk.
		const bucket = new FakeS3Bucket();
		const { adapter, keys } = await makeAdapter(bucket);

		const content = new TextEncoder().encode("identical content on both sides");
		const legacyEncPath = toBase64(await encryptBytes(keys.contentKey, new TextEncoder().encode(NFC_PATH)));
		const legacyBody = await encryptBytes(keys.contentKey, content);
		const legacyHash = await sha256Hex(content);

		bucket.seedRaw("some-legacy-key", legacyBody, {
			"enc-path": legacyEncPath,
			"content-hash": legacyHash,
		});

		// Exercise the real change-detector path: build local/remote states the
		// way sync-engine.ts's computeLocalStates/computeRemoteStates would, and
		// verify classify() says "noop", not "conflict".
		const remoteStates = (await adapter.list()).map((o) => ({
			path: o.path,
			contentHash: o.contentHash,
			etag: o.etag,
			lastModified: o.lastModified,
			hashIsLegacy: o.hashIsLegacy,
		}));

		const localLegacyHash = await sha256Hex(content);
		const localState = {
			path: NFC_PATH,
			contentHash: "some-keyed-hmac-hash-would-go-here",
			legacyContentHash: localLegacyHash,
			mtime: 1,
			size: content.byteLength,
		};

		const plan = buildSyncPlan(new SyncManifest(), [localState], remoteStates);
		expect(plan).toHaveLength(1);
		expect(plan[0].action).toBe("noop");
	});
});
