import { describe, expect, it } from "vitest";
import { deriveKeys, exportRecoveryKey, importRecoveryKey, generateSaltBase64 } from "../src/crypto/crypto";
import { BaseContentCache } from "../src/sync/base-cache";
import { RemoteMetaCache } from "../src/store/remote-meta-cache";
import { S3Config } from "../src/store/s3-client";
import { S3RemoteAdapter } from "../src/store/s3-remote-adapter";
import { getOrCreateSharedSalt, PassphraseMismatchError, verifyOrEstablishKeyCheck } from "../src/store/sync-meta";
import { FakeS3Bucket } from "./fake-s3-bucket";

function makeConfig(bucket: FakeS3Bucket): S3Config {
	return {
		endpoint: "https://fake-bucket.example.com",
		region: "auto",
		bucket: "my-bucket",
		accessKeyId: "AKIA_FAKE",
		secretAccessKey: "fake-secret",
		fetcher: bucket.fetcher,
	};
}

/**
 * End-to-end coverage of BACKLOG.md #9's acceptance criterion: "with a
 * correct recovery key and NO passphrase set, a device can fully sync an
 * existing bucket." Exercises the same DerivedKeys type and S3RemoteAdapter
 * path main.ts's getKeys() uses for both the passphrase-derivation and
 * recovery-key-import branches — main.ts itself is thin Obsidian-Plugin glue
 * around this, already covered by the project's typecheck.
 */
describe("recovery key import enables full sync with no passphrase (BACKLOG.md #9)", () => {
	it("persists encrypted base records across reload and treats a changed key as a cache miss", async () => {
		const salt = generateSaltBase64();
		const keys = await deriveKeys("cache-passphrase", salt);
		const cache = new BaseContentCache(keys.contentKey);
		await cache.set("note.md", new TextEncoder().encode("base text"));
		const reloaded = BaseContentCache.fromJSON(keys.contentKey, cache.toJSON());
		expect(new TextDecoder().decode((await reloaded.get("note.md"))!)).toBe("base text");

		const changedKeys = await deriveKeys("different-passphrase", salt);
		const changed = BaseContentCache.fromJSON(changedKeys.contentKey, cache.toJSON());
		expect(await changed.get("note.md")).toBeUndefined();
	});

	it("device B, holding only device A's exported recovery key, can list/get/put against the bucket", async () => {
		const bucket = new FakeS3Bucket();
		const config = makeConfig(bucket);

		// Device A: normal passphrase-derived setup, uploads a file, exports a
		// recovery key (mirrors settings.ts's exportRecoveryKey() flow).
		const salt = await getOrCreateSharedSalt(config);
		const deviceAKeys = await deriveKeys("device-a-passphrase", salt);
		await verifyOrEstablishKeyCheck(config, deviceAKeys); // establishes the keyCheck

		const deviceAAdapter = new S3RemoteAdapter(config, deviceAKeys, new RemoteMetaCache());
		await deviceAAdapter.put("note.md", new TextEncoder().encode("hello from device A"), { ifNoneMatch: "*" });

		const recoveryKey = await exportRecoveryKey(deviceAKeys);

		// Device B: NO passphrase at all, only the recovery key (mirrors
		// settings.ts's importRecoveryKey() flow / main.ts getKeys()'s
		// importedRecoveryKey branch).
		const deviceBKeys = await importRecoveryKey(recoveryKey);
		await expect(verifyOrEstablishKeyCheck(config, deviceBKeys)).resolves.toBeUndefined();

		const deviceBAdapter = new S3RemoteAdapter(config, deviceBKeys, new RemoteMetaCache());

		// list()
		const listed = await deviceBAdapter.list();
		expect(listed).toHaveLength(1);
		expect(listed[0].path).toBe("note.md");

		// get() — decrypts device A's content using only the imported keys.
		const got = await deviceBAdapter.get("note.md");
		expect(new TextDecoder().decode(got.plaintext)).toBe("hello from device A");

		// put() — device B can write back too, fully participating in sync.
		await deviceBAdapter.put("note.md", new TextEncoder().encode("edited by device B"), {
			ifMatch: listed[0].etag,
		});
		const gotAfterEdit = await deviceAAdapter.get("note.md");
		expect(new TextDecoder().decode(gotAfterEdit.plaintext)).toBe("edited by device B");
	});

	it("a malformed recovery key produces a clear, catchable error rather than syncing garbage", async () => {
		await expect(importRecoveryKey("not-a-real-recovery-key")).rejects.toThrow(/Malformed recovery key/);
	});

	it("an unrelated (well-formed but wrong-provenance) recovery key fails the bucket's key-check", async () => {
		const bucket = new FakeS3Bucket();
		const config = makeConfig(bucket);
		const salt = await getOrCreateSharedSalt(config);

		const realKeys = await deriveKeys("real-passphrase", salt);
		await verifyOrEstablishKeyCheck(config, realKeys); // establishes the keyCheck

		// A recovery key that's syntactically valid but derived from a totally
		// different passphrase against the SAME salt (e.g. exported from a
		// different vault's setup, or a stale export from before a passphrase
		// change) — well-formed, but the wrong key material for this bucket.
		const unrelatedRecoveryKey = await exportRecoveryKey(await deriveKeys("totally-different-passphrase", salt));
		const importedWrongKeys = await importRecoveryKey(unrelatedRecoveryKey);

		await expect(verifyOrEstablishKeyCheck(config, importedWrongKeys)).rejects.toThrow(PassphraseMismatchError);
	});
});
