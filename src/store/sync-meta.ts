import { generateSaltBase64 } from "../crypto/crypto";
import { NotFoundError, PreconditionFailedError, S3Config, getObject, putObject } from "./s3-client";

const SYNC_META_KEY = "_sync-meta.json";

interface SyncMeta {
	saltBase64: string;
}

/**
 * The PBKDF2 salt must be identical across every device syncing to this
 * bucket, or each device derives a different key from the same passphrase
 * and nothing decrypts across devices. Stored UNENCRYPTED as a small
 * metadata object in the bucket — safe, because the salt alone is useless
 * without the passphrase — so a second device picks it up automatically
 * instead of requiring the user to copy it out-of-band.
 */
export async function getOrCreateSharedSalt(config: S3Config): Promise<string> {
	try {
		const result = await getObject(config, SYNC_META_KEY);
		const meta = JSON.parse(new TextDecoder().decode(result.body)) as SyncMeta;
		return meta.saltBase64;
	} catch (e) {
		if (!(e instanceof NotFoundError)) throw e;
	}

	const saltBase64 = generateSaltBase64();
	const body = new TextEncoder().encode(JSON.stringify({ saltBase64 } satisfies SyncMeta));

	try {
		await putObject(config, SYNC_META_KEY, body, { ifNoneMatch: "*", contentType: "application/json" });
		return saltBase64;
	} catch (e) {
		if (e instanceof PreconditionFailedError) {
			// Another device created it concurrently between our GET and PUT — use theirs.
			const result = await getObject(config, SYNC_META_KEY);
			const meta = JSON.parse(new TextDecoder().decode(result.body)) as SyncMeta;
			return meta.saltBase64;
		}
		throw e;
	}
}
