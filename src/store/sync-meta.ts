import { DerivedKeys, decryptString, encryptString, generateSaltBase64 } from "../crypto/crypto";
import { NotFoundError, PreconditionFailedError, S3Config, getObject, putObject } from "./s3-client";

const SYNC_META_KEY = "_sync-meta.json";
const KEY_CHECK_PLAINTEXT = "twine-key-check-v1";

interface SyncMeta {
	saltBase64: string;
	/** Encrypted verifier (BACKLOG.md #4): decrypting this with the derived
	 * content key must yield KEY_CHECK_PLAINTEXT. Lets a device detect a wrong
	 * passphrase immediately, instead of failing deep inside decryptPath()
	 * mid-list() with a cryptic WebCrypto error. Optional because buckets
	 * created before this migration don't have one yet. */
	keyCheck?: string;
}

export class PassphraseMismatchError extends Error {
	constructor() {
		super("Passphrase doesn't match this bucket's encryption key.");
		this.name = "PassphraseMismatchError";
	}
}

async function readMeta(config: S3Config): Promise<{ meta: SyncMeta; etag: string } | undefined> {
	try {
		const result = await getObject(config, SYNC_META_KEY);
		const meta = JSON.parse(new TextDecoder().decode(result.body)) as SyncMeta;
		return { meta, etag: result.etag };
	} catch (e) {
		if (e instanceof NotFoundError) return undefined;
		throw e;
	}
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
	const existing = await readMeta(config);
	if (existing) return existing.meta.saltBase64;

	const saltBase64 = generateSaltBase64();
	const body = new TextEncoder().encode(JSON.stringify({ saltBase64 } satisfies SyncMeta));

	try {
		await putObject(config, SYNC_META_KEY, body, { ifNoneMatch: "*", contentType: "application/json" });
		return saltBase64;
	} catch (e) {
		if (e instanceof PreconditionFailedError) {
			// Another device created it concurrently between our GET and PUT — use theirs.
			const raced = await readMeta(config);
			if (raced) return raced.meta.saltBase64;
		}
		throw e;
	}
}

/**
 * Verifies the derived content key can decrypt this bucket's key-check
 * verifier — throws {@link PassphraseMismatchError} if not, so callers can
 * fail a sync pass fast with a clear message instead of a cryptic error deep
 * inside list()/decryptPath(). Mutates nothing on mismatch.
 *
 * If this bucket predates the key-check migration (no `keyCheck` field yet),
 * this device establishes one — conditioned on the meta object's current
 * etag so a concurrent write from another device can't be silently clobbered;
 * on that race, re-reads and verifies against whichever value won instead of
 * overwriting it. Never overwrites an existing keyCheck.
 */
export async function verifyOrEstablishKeyCheck(config: S3Config, keys: DerivedKeys): Promise<void> {
	const existing = await readMeta(config);
	if (!existing) {
		// Salt is created before this is ever called (ensureSalt() runs first),
		// so this shouldn't normally happen; if the meta object is genuinely
		// missing there's nothing to verify against yet — proceed untrusted
		// rather than blocking a first-ever sync.
		return;
	}

	if (existing.meta.keyCheck !== undefined) {
		await assertKeyCheckMatches(keys, existing.meta.keyCheck);
		return;
	}

	const keyCheck = await encryptString(keys.contentKey, KEY_CHECK_PLAINTEXT);
	const updatedMeta: SyncMeta = { ...existing.meta, keyCheck };
	const body = new TextEncoder().encode(JSON.stringify(updatedMeta));

	try {
		await putObject(config, SYNC_META_KEY, body, { ifMatch: existing.etag, contentType: "application/json" });
	} catch (e) {
		if (!(e instanceof PreconditionFailedError)) throw e;

		// Someone else wrote to meta concurrently — re-read and verify against
		// whichever value won instead of overwriting it. If it still has no
		// keyCheck somehow, just proceed untrusted rather than looping forever.
		const raced = await readMeta(config);
		if (raced?.meta.keyCheck !== undefined) {
			await assertKeyCheckMatches(keys, raced.meta.keyCheck);
		}
	}
}

async function assertKeyCheckMatches(keys: DerivedKeys, keyCheck: string): Promise<void> {
	let decrypted: string;
	try {
		decrypted = await decryptString(keys.contentKey, keyCheck);
	} catch {
		throw new PassphraseMismatchError();
	}
	if (decrypted !== KEY_CHECK_PLAINTEXT) throw new PassphraseMismatchError();
}
