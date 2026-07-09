/**
 * Content hashing for change detection. Computed on PLAINTEXT, before
 * encryption, so change detection never requires decrypting remote objects
 * to compare — the hash travels alongside the ciphertext as metadata.
 */
import { asBufferSource } from "./bytes";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", asBufferSource(bytes));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
