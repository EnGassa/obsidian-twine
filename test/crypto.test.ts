import { describe, expect, it } from "vitest";
import {
	decryptBytes,
	decryptContentBlob,
	deriveKeys,
	encryptBytes,
	encryptContentBlob,
	encryptPath,
	exportRecoveryKey,
	generateSaltBase64,
	hmacObjectKey,
	importRecoveryKey,
	keyedContentHash,
} from "../src/crypto/crypto";

describe("deriveKeys", () => {
	it("derives three independent keys from one passphrase+salt", async () => {
		const salt = generateSaltBase64();
		const keys = await deriveKeys("correct horse battery staple", salt);

		expect(keys.contentKey).toBeDefined();
		expect(keys.pathHmacKey).toBeDefined();
		expect(keys.contentHashKey).toBeDefined();

		// Sanity: the content-hash key actually produces different output than
		// hashing with a differently-derived key would (keys aren't accidentally
		// aliased to the same material).
		const bytes = new TextEncoder().encode("hello");
		const hash1 = await keyedContentHash(keys.contentHashKey, bytes);

		const otherKeys = await deriveKeys("different passphrase", salt);
		const hash2 = await keyedContentHash(otherKeys.contentHashKey, bytes);

		expect(hash1).not.toBe(hash2);
	});

	it("is deterministic given the same passphrase and salt", async () => {
		const salt = generateSaltBase64();
		const keysA = await deriveKeys("my passphrase", salt);
		const keysB = await deriveKeys("my passphrase", salt);

		const bytes = new TextEncoder().encode("hello world");
		const hashA = await keyedContentHash(keysA.contentHashKey, bytes);
		const hashB = await keyedContentHash(keysB.contentHashKey, bytes);

		expect(hashA).toBe(hashB);
	});
});

describe("keyedContentHash", () => {
	it("differs from a bare unkeyed hash of the same content", async () => {
		const salt = generateSaltBase64();
		const keys = await deriveKeys("passphrase", salt);
		const bytes = new TextEncoder().encode("some note content");

		const keyed = await keyedContentHash(keys.contentHashKey, bytes);

		// A keyed HMAC-SHA256 hex digest and a bare SHA-256 hex digest of the
		// same bytes should not collide for realistic inputs — this is a smoke
		// test that we're not accidentally computing plain SHA-256 here.
		const plainDigest = await crypto.subtle.digest("SHA-256", bytes);
		const plainHex = Array.from(new Uint8Array(plainDigest))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");

		expect(keyed).not.toBe(plainHex);
	});
});

describe("encryptBytes / decryptBytes round trip", () => {
	it("recovers the original plaintext", async () => {
		const salt = generateSaltBase64();
		const keys = await deriveKeys("passphrase", salt);
		const plaintext = new TextEncoder().encode("# My Note\n\nSome content here.");

		const ciphertext = await encryptBytes(keys.contentKey, plaintext);
		const decrypted = await decryptBytes(keys.contentKey, ciphertext);

		expect(new TextDecoder().decode(decrypted)).toBe("# My Note\n\nSome content here.");
	});
});

describe("recovery key export/import", () => {
	it("round-trips a 3-part recovery key", async () => {
		const salt = generateSaltBase64();
		const keys = await deriveKeys("passphrase", salt);

		const recoveryKey = await exportRecoveryKey(keys);
		expect(recoveryKey.split(".")).toHaveLength(3);

		const imported = await importRecoveryKey(recoveryKey);

		const plaintext = new TextEncoder().encode("round trip check");
		const ciphertext = await encryptBytes(keys.contentKey, plaintext);
		const decrypted = await decryptBytes(imported.contentKey, ciphertext);
		expect(new TextDecoder().decode(decrypted)).toBe("round trip check");

		const bytes = new TextEncoder().encode("hash check");
		const originalHash = await keyedContentHash(keys.contentHashKey, bytes);
		const importedHash = await keyedContentHash(imported.contentHashKey, bytes);
		expect(originalHash).toBe(importedHash);
	});

	it("rejects a legacy 2-part recovery key with a clear error", async () => {
		const legacyKey = "c29tZWJhc2U2NA==.YW5vdGhlcmJhc2U2NA==";
		await expect(importRecoveryKey(legacyKey)).rejects.toThrow(/missing the third key part/);
	});

	it("rejects a malformed key", async () => {
		await expect(importRecoveryKey("not-a-valid-key")).rejects.toThrow(/Malformed recovery key/);
	});
});

describe("Unicode path normalization (BACKLOG.md #3)", () => {
	// Constructed via explicit code points rather than typed literals, since a
	// source file/editor can silently normalize typed Unicode — these must
	// stay genuinely distinct byte sequences for the test to mean anything.
	const nfd = "Café.md"; // "e" + combining acute accent (U+0301)
	const nfc = "Café.md"; // precomposed "é" (U+00E9)

	it("produces the same HMAC object key for NFD and NFC forms of the same filename", async () => {
		const salt = generateSaltBase64();
		const keys = await deriveKeys("passphrase", salt);

		expect(nfd).not.toBe(nfc); // sanity: the two literals really are distinct byte sequences
		expect(await hmacObjectKey(keys.pathHmacKey, nfd)).toBe(await hmacObjectKey(keys.pathHmacKey, nfc));
	});

	it("encryptPath produces the same ciphertext (path stored) for NFD and NFC input", async () => {
		const salt = generateSaltBase64();
		const keys = await deriveKeys("passphrase", salt);

		// encryptBytes uses a random nonce, so ciphertexts differ, but decrypting
		// both must yield the identical (normalized) stored path string.
		const { decryptPath } = await import("../src/crypto/crypto");
		const encFromNfd = await encryptPath(keys.contentKey, nfd);
		const encFromNfc = await encryptPath(keys.contentKey, nfc);

		expect(await decryptPath(keys.contentKey, encFromNfd)).toBe(await decryptPath(keys.contentKey, encFromNfc));
		expect(await decryptPath(keys.contentKey, encFromNfd)).toBe(nfc);
	});
});

describe("encryptContentBlob / decryptContentBlob AAD binding (BACKLOG.md #7)", () => {
	it("round-trips when decrypted with the same path used to encrypt", async () => {
		const salt = generateSaltBase64();
		const keys = await deriveKeys("passphrase", salt);
		const plaintext = new TextEncoder().encode("secret note contents");

		const blob = await encryptContentBlob(keys.contentKey, plaintext, "note.md");
		const decrypted = await decryptContentBlob(keys.contentKey, blob, "note.md");

		expect(new TextDecoder().decode(decrypted)).toBe("secret note contents");
	});

	it("produces a blob prefixed with the v2 version byte", async () => {
		const salt = generateSaltBase64();
		const keys = await deriveKeys("passphrase", salt);
		const blob = await encryptContentBlob(keys.contentKey, new TextEncoder().encode("x"), "note.md");

		expect(blob[0]).toBe(0x02);
	});

	it("fails to decrypt when the path (AAD) doesn't match — the core anti-transplant property", async () => {
		const salt = generateSaltBase64();
		const keys = await deriveKeys("passphrase", salt);
		const plaintext = new TextEncoder().encode("secret note contents");

		// Simulates an attacker with bucket write access copying this
		// ciphertext to a different object key (i.e. a different vault path).
		const blob = await encryptContentBlob(keys.contentKey, plaintext, "real-note.md");

		await expect(decryptContentBlob(keys.contentKey, blob, "different-note.md")).rejects.toThrow();
	});

	it("falls back to decrypting a legacy (pre-#7, no-AAD) blob successfully", async () => {
		const salt = generateSaltBase64();
		const keys = await deriveKeys("passphrase", salt);
		const plaintext = new TextEncoder().encode("old content, encrypted before AAD binding existed");

		// Mimics the pre-#7 format: plain encryptBytes(), no version byte, no AAD.
		const legacyBlob = await encryptBytes(keys.contentKey, plaintext);
		expect(legacyBlob[0]).not.toBe(undefined); // sanity: blob is non-empty

		const decrypted = await decryptContentBlob(keys.contentKey, legacyBlob, "any-path-at-all.md");
		expect(new TextDecoder().decode(decrypted)).toBe("old content, encrypted before AAD binding existed");
	});

	it("correctly falls back even when a legacy blob's real (random) nonce happens to start with the v2 marker byte", async () => {
		const salt = generateSaltBase64();
		const keys = await deriveKeys("passphrase", salt);
		const plaintext = new TextEncoder().encode("edge case content");

		// Constructs a genuine legacy-format blob (nonce || ciphertext+tag, no
		// AAD) using a CHOSEN nonce whose first byte is 0x02 — simulating the
		// ~1/256 chance a real legacy blob's random nonce starts that way,
		// without relying on flaky randomness to hit the case.
		const nonce = new Uint8Array(12);
		nonce[0] = 0x02;
		const { asBufferSource } = await import("../src/util/bytes");
		const ciphertext = new Uint8Array(
			await crypto.subtle.encrypt({ name: "AES-GCM", iv: asBufferSource(nonce) }, keys.contentKey, asBufferSource(plaintext))
		);
		const legacyBlob = new Uint8Array(nonce.length + ciphertext.length);
		legacyBlob.set(nonce, 0);
		legacyBlob.set(ciphertext, nonce.length);
		expect(legacyBlob[0]).toBe(0x02); // sanity: the collision is real

		// The v2 attempt reads blob[1:13] as if it were the nonce (off by one
		// from the true nonce) with AAD that was never used at encryption time —
		// must fail its auth-tag check and fall back to the correct legacy
		// interpretation, not throw or return garbage.
		const decrypted = await decryptContentBlob(keys.contentKey, legacyBlob, "some-path.md");
		expect(new TextDecoder().decode(decrypted)).toBe("edge case content");
	});
});
