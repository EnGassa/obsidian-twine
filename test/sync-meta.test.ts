import { describe, expect, it } from "vitest";
import { deriveKeys, generateSaltBase64 } from "../src/crypto/crypto";
import { S3Config } from "../src/store/s3-client";
import {
	PassphraseMismatchError,
	getOrCreateSharedSalt,
	verifyOrEstablishKeyCheck,
} from "../src/store/sync-meta";
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

describe("getOrCreateSharedSalt", () => {
	it("creates a salt on first call and reuses it thereafter", async () => {
		const bucket = new FakeS3Bucket();
		const config = makeConfig(bucket);

		const salt1 = await getOrCreateSharedSalt(config);
		const salt2 = await getOrCreateSharedSalt(config);
		expect(salt1).toBe(salt2);
	});

	it("propagates a genuine network/server error instead of treating it as 'not found'", async () => {
		const bucket = new FakeS3Bucket();
		const config = makeConfig(bucket);
		config.fetcher = async () => {
			throw new Error("simulated network failure");
		};

		await expect(getOrCreateSharedSalt(config)).rejects.toThrow("simulated network failure");
	});

	it("resolves against the winner when two devices race to create the salt concurrently", async () => {
		const bucket = new FakeS3Bucket();
		const config = makeConfig(bucket);

		// Simulate device B creating the salt object in the gap between our GET
		// (finding nothing) and our conditional PUT.
		const realFetcher = bucket.fetcher;
		let interceded = false;
		let racersSalt: string | undefined;
		config.fetcher = async (url, init) => {
			if (!interceded && init.method === "PUT") {
				interceded = true;
				racersSalt = await getOrCreateSharedSalt({ ...config, fetcher: realFetcher });
			}
			return realFetcher(url, init);
		};

		const ourSalt = await getOrCreateSharedSalt(config);
		expect(interceded).toBe(true);
		expect(ourSalt).toBe(racersSalt); // both devices converge on the winner's salt
	});

	it("propagates a non-precondition error from the creating PUT", async () => {
		const bucket = new FakeS3Bucket();
		const config = makeConfig(bucket);
		const realFetcher = bucket.fetcher;
		config.fetcher = async (url, init) => {
			if (init.method === "PUT") throw new Error("simulated network failure during create");
			return realFetcher(url, init);
		};

		await expect(getOrCreateSharedSalt(config)).rejects.toThrow("simulated network failure during create");
	});
});

describe("verifyOrEstablishKeyCheck (BACKLOG.md #4)", () => {
	it("establishes a keyCheck on first use, then verifies successfully with the same passphrase", async () => {
		const bucket = new FakeS3Bucket();
		const config = makeConfig(bucket);
		const salt = await getOrCreateSharedSalt(config);
		const keys = await deriveKeys("correct-passphrase", salt);

		// First call: no keyCheck exists yet, establishes one, doesn't throw.
		await expect(verifyOrEstablishKeyCheck(config, keys)).resolves.toBeUndefined();

		// Second call with the SAME (correct) passphrase: verifies cleanly.
		await expect(verifyOrEstablishKeyCheck(config, keys)).resolves.toBeUndefined();
	});

	it("throws PassphraseMismatchError for a second device with the wrong passphrase", async () => {
		const bucket = new FakeS3Bucket();
		const config = makeConfig(bucket);
		const salt = await getOrCreateSharedSalt(config);

		const correctKeys = await deriveKeys("correct-passphrase", salt);
		await verifyOrEstablishKeyCheck(config, correctKeys); // establishes the keyCheck

		const wrongKeys = await deriveKeys("totally-wrong-passphrase", salt);
		await expect(verifyOrEstablishKeyCheck(config, wrongKeys)).rejects.toThrow(PassphraseMismatchError);
	});

	it("does not mutate the bucket when verification fails", async () => {
		const bucket = new FakeS3Bucket();
		const config = makeConfig(bucket);
		const salt = await getOrCreateSharedSalt(config);

		const correctKeys = await deriveKeys("correct-passphrase", salt);
		await verifyOrEstablishKeyCheck(config, correctKeys);
		const keysBeforeMismatch = bucket.rawKeys();

		const wrongKeys = await deriveKeys("wrong-passphrase", salt);
		await expect(verifyOrEstablishKeyCheck(config, wrongKeys)).rejects.toThrow(PassphraseMismatchError);

		expect(bucket.rawKeys()).toEqual(keysBeforeMismatch);
	});

	it("never overwrites an existing keyCheck once established", async () => {
		const bucket = new FakeS3Bucket();
		const config = makeConfig(bucket);
		const salt = await getOrCreateSharedSalt(config);

		const keys = await deriveKeys("correct-passphrase", salt);
		await verifyOrEstablishKeyCheck(config, keys);

		const metaKeyRaw = bucket.rawKeys().find((k) => k.includes("_sync-meta"));
		expect(metaKeyRaw).toBeDefined();

		// A second, correct verification should be a pure read — no additional
		// mutation of the stored keyCheck value.
		const putCountBefore = bucket.requestCounts.PUT;
		await verifyOrEstablishKeyCheck(config, keys);
		expect(bucket.requestCounts.PUT).toBe(putCountBefore);
	});

	it("resolves against the winner when two devices race to establish keyCheck concurrently", async () => {
		const bucket = new FakeS3Bucket();
		const config = makeConfig(bucket);
		const salt = await getOrCreateSharedSalt(config);
		const keys = await deriveKeys("shared-correct-passphrase", salt);

		// Simulate device B writing its own keyCheck to the meta object in the
		// gap between our GET and our conditional PUT, by intercepting the very
		// next PUT this test issues and injecting a concurrent write first.
		const realFetcher = bucket.fetcher;
		let interceded = false;
		config.fetcher = async (url, init) => {
			if (!interceded && init.method === "PUT") {
				interceded = true;
				// Device B established its own (matching) keyCheck first.
				await verifyOrEstablishKeyCheck(config2, keys);
			}
			return realFetcher(url, init);
		};
		const config2: S3Config = { ...config, fetcher: realFetcher };

		// Our own establish attempt races against the injected concurrent write
		// above; it should detect the 412, re-read, and verify against the
		// winning (matching) value rather than throwing or double-writing.
		await expect(verifyOrEstablishKeyCheck(config, keys)).resolves.toBeUndefined();
		expect(interceded).toBe(true);
	});

	it("propagates a genuine network/server error while establishing a keyCheck", async () => {
		const bucket = new FakeS3Bucket();
		const config = makeConfig(bucket);
		const salt = await getOrCreateSharedSalt(config);
		const keys = await deriveKeys("some-passphrase", salt);

		const realFetcher = bucket.fetcher;
		config.fetcher = async (url, init) => {
			if (init.method === "PUT") throw new Error("simulated network failure");
			return realFetcher(url, init);
		};

		await expect(verifyOrEstablishKeyCheck(config, keys)).rejects.toThrow("simulated network failure");
	});

	it("does nothing (proceeds untrusted) when the meta object is missing entirely", async () => {
		// Shouldn't normally happen (salt is always created first), but the
		// function documents this as a deliberate non-throwing fallback rather
		// than an error — verify that contract directly.
		const bucket = new FakeS3Bucket();
		const config = makeConfig(bucket);
		// Salt value is irrelevant here — no meta object exists at all, so
		// verifyOrEstablishKeyCheck() returns before ever deriving anything from it.
		const keys = await deriveKeys("passphrase", generateSaltBase64());

		await expect(verifyOrEstablishKeyCheck(config, keys)).resolves.toBeUndefined();
		expect(bucket.rawKeys()).toHaveLength(0); // nothing was created
	});
});
