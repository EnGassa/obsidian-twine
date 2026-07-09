/**
 * Phase 0, Spike 2: empirically confirm R2's S3 API honors conditional PUT
 * (`If-Match`) with a 412 on mismatch — the one correctness-critical
 * primitive the sync engine borrows from the storage provider for race
 * safety between two of your own devices.
 *
 * Requires a real R2 bucket + API token. Run with:
 *   R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com \
 *   R2_BUCKET=<bucket> \
 *   R2_ACCESS_KEY_ID=<key> \
 *   R2_SECRET_ACCESS_KEY=<secret> \
 *   pnpm exec tsx spikes/r2-conditional-write/spike.ts
 *
 * This creates and deletes one throwaway object (key: "selfsync-spike-test")
 * in the bucket. Safe to run against a real bucket you intend to use for
 * sync, since it cleans up after itself.
 */

import { deleteObject, getObject, PreconditionFailedError, putObject, S3Config } from "../../src/store/s3-client";

const KEY = "selfsync-spike-test";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		console.error(`Missing required env var: ${name}`);
		process.exit(1);
	}
	return value;
}

async function main(): Promise<void> {
	const config: S3Config = {
		endpoint: requireEnv("R2_ENDPOINT"),
		region: process.env.R2_REGION ?? "auto",
		bucket: requireEnv("R2_BUCKET"),
		accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
		secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
	};

	console.log("1. Cleaning up any stale spike object from a previous run...");
	await deleteObject(config, KEY).catch(() => {});

	console.log("2. Creating initial object with If-None-Match: * (should succeed)...");
	const initial = await putObject(config, KEY, new TextEncoder().encode("v1"), { ifNoneMatch: "*" });
	console.log(`   OK — etag: ${initial.etag}`);

	console.log("3. Re-creating with If-None-Match: * again (should FAIL with 412 — object now exists)...");
	try {
		await putObject(config, KEY, new TextEncoder().encode("v1-again"), { ifNoneMatch: "*" });
		console.error("   UNEXPECTED: second create succeeded — If-None-Match is not being enforced!");
		process.exitCode = 1;
	} catch (e) {
		if (e instanceof PreconditionFailedError) {
			console.log("   OK — got 412 as expected.");
		} else {
			throw e;
		}
	}

	console.log("4. Updating with correct If-Match (should succeed)...");
	const updated = await putObject(config, KEY, new TextEncoder().encode("v2"), { ifMatch: initial.etag });
	console.log(`   OK — new etag: ${updated.etag}`);

	console.log("5. Racing a stale If-Match (using the OLD etag — should FAIL with 412)...");
	try {
		await putObject(config, KEY, new TextEncoder().encode("v3-stale-write"), { ifMatch: initial.etag });
		console.error("   UNEXPECTED: stale conditional write succeeded — race protection is NOT working!");
		process.exitCode = 1;
	} catch (e) {
		if (e instanceof PreconditionFailedError) {
			console.log("   OK — got 412 as expected. Conditional-write race protection works.");
		} else {
			throw e;
		}
	}

	console.log("6. Verifying final content is v2 (the stale write must not have applied)...");
	const final = await getObject(config, KEY);
	const finalText = new TextDecoder().decode(final.body);
	if (finalText !== "v2") {
		console.error(`   UNEXPECTED final content: "${finalText}" (expected "v2")`);
		process.exitCode = 1;
	} else {
		console.log('   OK — content is "v2" as expected.');
	}

	console.log("7. Cleaning up spike object...");
	await deleteObject(config, KEY, updated.etag);

	if (process.exitCode !== 1) {
		console.log("\nAll checks passed: R2's S3 API enforces If-Match/If-None-Match conditional writes correctly.");
	} else {
		console.log("\nOne or more checks FAILED — see above. Do not rely on conditional-write race safety until this is resolved.");
	}
}

main().catch((e) => {
	console.error("Spike script crashed:", e);
	process.exit(1);
});
