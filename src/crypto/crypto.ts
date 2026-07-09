/**
 * All crypto here uses native WebCrypto (crypto.subtle), which is available
 * identically in Electron (desktop) and the Obsidian mobile WebView — no WASM
 * bundle (e.g. libsodium) needed. See plan: "Encryption" section.
 */

import { asBufferSource } from "../util/bytes";
import { normalizePath } from "../util/path";

const PBKDF2_ITERATIONS = 600_000; // OWASP 2023+ recommendation for PBKDF2-HMAC-SHA256
const AES_KEY_LENGTH = 256;
const GCM_NONCE_BYTES = 12;
const SALT_BYTES = 16;

export interface DerivedKeys {
	/** Encrypts/decrypts file contents. */
	contentKey: CryptoKey;
	/** HMACs vault-relative paths into opaque, deterministic object keys. */
	pathHmacKey: CryptoKey;
	/**
	 * HMACs plaintext content into the change-detection hash stored as remote
	 * object metadata. Keyed (rather than bare SHA-256) so a party with bucket
	 * read access but not the passphrase can't fingerprint known plaintext by
	 * hashing candidate documents and comparing against stored hashes.
	 */
	contentHashKey: CryptoKey;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function generateSaltBase64(): string {
	const salt = new Uint8Array(SALT_BYTES);
	crypto.getRandomValues(salt);
	return toBase64(salt);
}

/**
 * Derives two independent keys from one passphrase+salt: one for AES-GCM
 * content encryption, one for HMAC-based path obfuscation. Using distinct
 * `info`-like PBKDF2 salts (base salt concatenated with a purpose label)
 * keeps the two keys cryptographically independent from a single secret.
 */
export async function deriveKeys(passphrase: string, saltBase64: string): Promise<DerivedKeys> {
	const baseSalt = fromBase64(saltBase64);
	const encoder = new TextEncoder();

	const passphraseKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(passphrase),
		"PBKDF2",
		false,
		["deriveKey"]
	);

	const contentSalt = concatBytes(baseSalt, encoder.encode("selfsync-content-v1"));
	const pathSalt = concatBytes(baseSalt, encoder.encode("selfsync-path-v1"));
	const hashSalt = concatBytes(baseSalt, encoder.encode("selfsync-contenthash-v1"));

	const contentKey = await crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt: asBufferSource(contentSalt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
		passphraseKey,
		{ name: "AES-GCM", length: AES_KEY_LENGTH },
		true,
		["encrypt", "decrypt"]
	);

	const pathHmacKey = await crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt: asBufferSource(pathSalt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
		passphraseKey,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		true,
		["sign"]
	);

	const contentHashKey = await crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt: asBufferSource(hashSalt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
		passphraseKey,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		true,
		["sign"]
	);

	return { contentKey, pathHmacKey, contentHashKey };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

/** Encrypts plaintext bytes; output is `nonce(12) || ciphertext+tag`. `additionalData`,
 * if given, is AES-GCM AAD: authenticated but not encrypted, and required again
 * (identical) to decrypt — see {@link encryptContentBlob} for why. */
export async function encryptBytes(
	key: CryptoKey,
	plaintext: Uint8Array,
	additionalData?: Uint8Array
): Promise<Uint8Array> {
	const nonce = new Uint8Array(GCM_NONCE_BYTES);
	crypto.getRandomValues(nonce);
	const algo: AesGcmParams = { name: "AES-GCM", iv: asBufferSource(nonce) };
	if (additionalData) algo.additionalData = asBufferSource(additionalData);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt(algo, key, asBufferSource(plaintext)));
	return concatBytes(nonce, ciphertext);
}

/** Decrypts a blob produced by {@link encryptBytes}. `additionalData` must match
 * whatever was passed at encryption time, or decryption fails. */
export async function decryptBytes(
	key: CryptoKey,
	blob: Uint8Array,
	additionalData?: Uint8Array
): Promise<Uint8Array> {
	const nonce = blob.slice(0, GCM_NONCE_BYTES);
	const ciphertext = blob.slice(GCM_NONCE_BYTES);
	const algo: AesGcmParams = { name: "AES-GCM", iv: asBufferSource(nonce) };
	if (additionalData) algo.additionalData = asBufferSource(additionalData);
	const plaintext = await crypto.subtle.decrypt(algo, key, asBufferSource(ciphertext));
	return new Uint8Array(plaintext);
}

const CONTENT_BLOB_VERSION_V2 = 0x02;

/**
 * Encrypts file content bound to its vault path via AES-GCM additional
 * authenticated data (BACKLOG.md #7): pairs the ciphertext with the path it
 * belongs to, so a party with bucket WRITE access can't copy ciphertext from
 * one object key to another and have it decrypt successfully under the
 * wrong path. Output: `0x02 || nonce(12) || ciphertext+tag`. Path is
 * normalized to NFC first (BACKLOG.md #3), since that's what's used as AAD
 * on the decrypting side too.
 */
export async function encryptContentBlob(key: CryptoKey, plaintext: Uint8Array, path: string): Promise<Uint8Array> {
	const aad = new TextEncoder().encode(normalizePath(path));
	const body = await encryptBytes(key, plaintext, aad);
	const out = new Uint8Array(body.length + 1);
	out[0] = CONTENT_BLOB_VERSION_V2;
	out.set(body, 1);
	return out;
}

/**
 * Decrypts a blob produced by {@link encryptContentBlob}, or a legacy
 * (pre-AAD-migration) blob produced by plain {@link encryptBytes} with no
 * AAD and no version byte. Tries the v2 (AAD-bound) interpretation first;
 * AES-GCM's authentication tag makes a false-positive match on a legacy
 * blob — whose first (random) nonce byte might coincidentally equal 0x02 —
 * cryptographically negligible, so falling back to the legacy
 * interpretation whenever the v2 attempt fails is safe.
 */
export async function decryptContentBlob(key: CryptoKey, blob: Uint8Array, path: string): Promise<Uint8Array> {
	if (blob[0] === CONTENT_BLOB_VERSION_V2) {
		try {
			const aad = new TextEncoder().encode(normalizePath(path));
			return await decryptBytes(key, blob.slice(1), aad);
		} catch {
			// Not actually a v2 blob (coincidental leading byte) — fall through.
		}
	}
	return decryptBytes(key, blob);
}

/** Encrypts a UTF-8 string, base64-encoded — for small string values (paths,
 * key-check verifiers) that need to travel as object metadata/JSON. */
export async function encryptString(key: CryptoKey, text: string): Promise<string> {
	const encrypted = await encryptBytes(key, new TextEncoder().encode(text));
	return toBase64(encrypted);
}

export async function decryptString(key: CryptoKey, encryptedBase64: string): Promise<string> {
	const decrypted = await decryptBytes(key, fromBase64(encryptedBase64));
	return new TextDecoder().decode(decrypted);
}

/** Encrypts a UTF-8 string path, base64-encoded, for storage as object metadata.
 * Normalizes to NFC first — see util/path.ts and BACKLOG.md #3. */
export async function encryptPath(key: CryptoKey, path: string): Promise<string> {
	return encryptString(key, normalizePath(path));
}

export async function decryptPath(key: CryptoKey, encryptedPathBase64: string): Promise<string> {
	return decryptString(key, encryptedPathBase64);
}

/**
 * Deterministically derives the opaque object key used in the bucket for a
 * given vault-relative path, so listing the bucket never reveals note titles
 * or folder structure. Hex-encoded HMAC-SHA256(pathHmacKey, path).
 * Normalizes to NFC first — see util/path.ts and BACKLOG.md #3.
 */
export async function hmacObjectKey(pathHmacKey: CryptoKey, path: string): Promise<string> {
	const encoded = new TextEncoder().encode(normalizePath(path));
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", pathHmacKey, asBufferSource(encoded)));
	return Array.from(sig)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Keyed content hash used for change detection, stored as remote object
 * metadata. Unlike a bare SHA-256 (the pre-migration format — see
 * BACKLOG.md #2), this can't be used by someone with bucket read access to
 * fingerprint known plaintext, since it requires the derived key to compute.
 */
export async function keyedContentHash(contentHashKey: CryptoKey, bytes: Uint8Array): Promise<string> {
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", contentHashKey, asBufferSource(bytes)));
	return Array.from(sig)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Exports the raw derived content+path+hash key material as a single
 * recovery string the user can back up independently of remembering their
 * passphrase. Losing both the passphrase and this recovery key means
 * permanent data loss by design (E2E — there is no server-side recovery
 * path).
 *
 * Format: `<content>.<path>.<hash>` (3 base64 parts). Older exports (before
 * the keyed content-hash migration, BACKLOG.md #2) produced a 2-part
 * `<content>.<path>` string with no hash key — those cannot be imported here
 * since the hash key was never derived independently and can't be recovered
 * after the fact; importRecoveryKey() rejects them with a clear error.
 */
export async function exportRecoveryKey(keys: DerivedKeys): Promise<string> {
	const rawContent = new Uint8Array(await crypto.subtle.exportKey("raw", keys.contentKey));
	const rawPath = new Uint8Array(await crypto.subtle.exportKey("raw", keys.pathHmacKey));
	const rawHash = new Uint8Array(await crypto.subtle.exportKey("raw", keys.contentHashKey));
	return `${toBase64(rawContent)}.${toBase64(rawPath)}.${toBase64(rawHash)}`;
}

export async function importRecoveryKey(recoveryKey: string): Promise<DerivedKeys> {
	const parts = recoveryKey.split(".");

	if (parts.length === 2) {
		throw new Error(
			"This recovery key was exported before Twine added keyed content-hashing " +
				"and is missing the third key part — it can't be imported. Re-export a " +
				"fresh recovery key from a device with the correct passphrase configured."
		);
	}

	const [contentB64, pathB64, hashB64] = parts;
	if (!contentB64 || !pathB64 || !hashB64) {
		throw new Error("Malformed recovery key: expected '<base64>.<base64>.<base64>'");
	}

	const contentKey = await crypto.subtle.importKey(
		"raw",
		asBufferSource(fromBase64(contentB64)),
		{ name: "AES-GCM", length: AES_KEY_LENGTH },
		true,
		["encrypt", "decrypt"]
	);
	const pathHmacKey = await crypto.subtle.importKey(
		"raw",
		asBufferSource(fromBase64(pathB64)),
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		true,
		["sign"]
	);
	const contentHashKey = await crypto.subtle.importKey(
		"raw",
		asBufferSource(fromBase64(hashB64)),
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		true,
		["sign"]
	);
	return { contentKey, pathHmacKey, contentHashKey };
}
