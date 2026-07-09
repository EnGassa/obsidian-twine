/**
 * All crypto here uses native WebCrypto (crypto.subtle), which is available
 * identically in Electron (desktop) and the Obsidian mobile WebView — no WASM
 * bundle (e.g. libsodium) needed. See plan: "Encryption" section.
 */

import { asBufferSource } from "../util/bytes";

const PBKDF2_ITERATIONS = 600_000; // OWASP 2023+ recommendation for PBKDF2-HMAC-SHA256
const AES_KEY_LENGTH = 256;
const GCM_NONCE_BYTES = 12;
const SALT_BYTES = 16;

export interface DerivedKeys {
	/** Encrypts/decrypts file contents. */
	contentKey: CryptoKey;
	/** HMACs vault-relative paths into opaque, deterministic object keys. */
	pathHmacKey: CryptoKey;
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

	return { contentKey, pathHmacKey };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

/** Encrypts plaintext bytes; output is `nonce(12) || ciphertext+tag`. */
export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
	const nonce = new Uint8Array(GCM_NONCE_BYTES);
	crypto.getRandomValues(nonce);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: asBufferSource(nonce) }, key, asBufferSource(plaintext))
	);
	return concatBytes(nonce, ciphertext);
}

/** Decrypts a blob produced by {@link encryptBytes}. */
export async function decryptBytes(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
	const nonce = blob.slice(0, GCM_NONCE_BYTES);
	const ciphertext = blob.slice(GCM_NONCE_BYTES);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: asBufferSource(nonce) },
		key,
		asBufferSource(ciphertext)
	);
	return new Uint8Array(plaintext);
}

/** Encrypts a UTF-8 string path, base64-encoded, for storage as object metadata. */
export async function encryptPath(key: CryptoKey, path: string): Promise<string> {
	const encoded = new TextEncoder().encode(path);
	const encrypted = await encryptBytes(key, encoded);
	return toBase64(encrypted);
}

export async function decryptPath(key: CryptoKey, encryptedPathBase64: string): Promise<string> {
	const blob = fromBase64(encryptedPathBase64);
	const decrypted = await decryptBytes(key, blob);
	return new TextDecoder().decode(decrypted);
}

/**
 * Deterministically derives the opaque object key used in the bucket for a
 * given vault-relative path, so listing the bucket never reveals note titles
 * or folder structure. Hex-encoded HMAC-SHA256(pathHmacKey, path).
 */
export async function hmacObjectKey(pathHmacKey: CryptoKey, path: string): Promise<string> {
	const encoded = new TextEncoder().encode(path);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", pathHmacKey, asBufferSource(encoded)));
	return Array.from(sig)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Exports the raw derived content+path key material as a single recovery
 * string the user can back up independently of remembering their passphrase.
 * Losing both the passphrase and this recovery key means permanent data loss
 * by design (E2E — there is no server-side recovery path).
 */
export async function exportRecoveryKey(keys: DerivedKeys): Promise<string> {
	const rawContent = new Uint8Array(await crypto.subtle.exportKey("raw", keys.contentKey));
	const rawPath = new Uint8Array(await crypto.subtle.exportKey("raw", keys.pathHmacKey));
	return `${toBase64(rawContent)}.${toBase64(rawPath)}`;
}

export async function importRecoveryKey(recoveryKey: string): Promise<DerivedKeys> {
	const [contentB64, pathB64] = recoveryKey.split(".");
	if (!contentB64 || !pathB64) {
		throw new Error("Malformed recovery key: expected '<base64>.<base64>'");
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
	return { contentKey, pathHmacKey };
}
