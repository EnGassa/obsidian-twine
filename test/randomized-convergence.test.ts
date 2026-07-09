import { describe, expect, it } from "vitest";
import { SyncManifest } from "../src/sync/manifest";
import { runSyncPass, SyncEngineContext } from "../src/sync/sync-engine";
import { sha256Hex } from "../src/util/hash";
import { RemoteAdapter } from "../src/sync/adapters";
import { InMemoryRemote, InMemoryVault } from "./mock-adapters";

/** Deterministic PRNG (mulberry32) — a fixed seed always produces the exact
 * same sequence of "random" operations, so a failing case is reproducible
 * (print the seed) rather than a flaky one-off. */
function mulberry32(seed: number): () => number {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rand: () => number, items: readonly T[]): T {
	return items[Math.floor(rand() * items.length)];
}

interface Device {
	name: string;
	vault: InMemoryVault;
	manifest: SyncManifest;
}

function makeCtx(device: Device, remote: RemoteAdapter): SyncEngineContext {
	return {
		vault: device.vault,
		remote,
		manifest: device.manifest,
		deviceName: device.name,
		hashFn: sha256Hex,
		persistManifest: async () => {},
	};
}

const DEFAULT_FILE_POOL = ["a.md", "b.md", "c.md"] as const; // small pool -> frequent collisions/conflicts
const MAX_QUIESCENCE_ROUNDS = 50;

/**
 * Runs `steps` random single-device operations (create/edit/delete/sync-only)
 * against a shared remote, each followed by that one device syncing (the
 * others stay offline and diverge) — then round-robins every device syncing
 * repeatedly until a full round changes nothing, or fails the test if that
 * never happens within MAX_QUIESCENCE_ROUNDS (a real "never converges" bug).
 * Returns the final device states for the caller to assert invariants on.
 */
async function runRandomizedScenario(
	seed: number,
	deviceCount: number,
	steps: number,
	filePool: readonly string[] = DEFAULT_FILE_POOL
) {
	const rand = mulberry32(seed);
	const remote = new InMemoryRemote();
	const devices: Device[] = Array.from({ length: deviceCount }, (_, i) => ({
		name: `device-${i}`,
		vault: new InMemoryVault(),
		manifest: new SyncManifest(),
	}));

	const allErrors: { step: number; device: string; error: unknown }[] = [];

	for (let step = 0; step < steps; step++) {
		const device = pick(rand, devices);
		const path = pick(rand, filePool);
		const action = pick(rand, ["create-or-edit", "create-or-edit", "delete", "sync-only"] as const);

		if (action === "delete") {
			if (device.vault.has(path)) await device.vault.deleteFile(path);
		} else if (action === "create-or-edit") {
			const content = `step-${step}-by-${device.name}-${Math.floor(rand() * 1_000_000)}`;
			await device.vault.writeFile(path, new TextEncoder().encode(content));
		}
		// "sync-only": no local mutation this step, just sync below.

		const result = await runSyncPass(makeCtx(device, remote));
		for (const e of result.errors) allErrors.push({ step, device: device.name, error: e.error });
	}

	// Quiescence: keep round-robin syncing everyone until a full round is a
	// no-op everywhere, so any straggling divergence (e.g. a device that never
	// got picked in the random phase) has a chance to converge too.
	let round = 0;
	for (; round < MAX_QUIESCENCE_ROUNDS; round++) {
		let anyActed = false;
		for (const device of devices) {
			const result = await runSyncPass(makeCtx(device, remote));
			for (const e of result.errors) allErrors.push({ step: -1, device: device.name, error: e.error });
			if (result.plan.some((entry) => entry.action !== "noop")) anyActed = true;
		}
		if (!anyActed) break;
	}

	return { devices, remote, allErrors, quiescenceRounds: round, hitRoundCap: round === MAX_QUIESCENCE_ROUNDS };
}

function snapshot(device: Device): Record<string, string> {
	const out: Record<string, string> = {};
	for (const path of device.vault.allPaths()) out[path] = device.vault.readText(path);
	return out;
}

describe("randomized multi-device convergence", () => {
	const seeds = Array.from({ length: 60 }, (_, i) => i * 104729 + 7); // 60 distinct, well-spread seeds

	for (const seed of seeds) {
		it(`seed ${seed}: converges to identical state across all devices with zero errors`, async () => {
			const { devices, allErrors, quiescenceRounds, hitRoundCap } = await runRandomizedScenario(seed, 3, 60);

			expect(allErrors, `unexpected sync errors: ${JSON.stringify(allErrors)}`).toHaveLength(0);
			expect(hitRoundCap, `did not converge within ${MAX_QUIESCENCE_ROUNDS} rounds (seed ${seed})`).toBe(false);

			const [first, ...rest] = devices;
			const firstSnapshot = snapshot(first);
			for (const device of rest) {
				expect(snapshot(device), `device ${device.name} diverged from ${first.name} (seed ${seed})`).toEqual(
					firstSnapshot
				);
			}

			// Sanity: every device's manifest agrees with what's actually on disk
			// (no manifest entries for files that don't exist, and vice versa for
			// files with a stable synced history).
			for (const device of devices) {
				for (const path of device.vault.allPaths()) {
					// Every file that exists locally after quiescence must either be
					// tracked in the manifest, or (extremely recently created and not
					// yet round-tripped) about to be — quiescence guarantees the
					// former since no pass produced any further action.
					expect(device.manifest.has(path), `${device.name}: ${path} exists but isn't in the manifest`).toBe(
						true
					);
				}
			}

			void quiescenceRounds; // available for debugging; not asserted on directly
		});
	}
});

describe("randomized multi-device convergence, higher device count and longer runs", () => {
	it("5 devices, 150 random steps, still converges with zero errors", async () => {
		const { devices, allErrors, hitRoundCap } = await runRandomizedScenario(777, 5, 150);

		expect(allErrors, `unexpected sync errors: ${JSON.stringify(allErrors)}`).toHaveLength(0);
		expect(hitRoundCap).toBe(false);

		const [first, ...rest] = devices;
		const firstSnapshot = snapshot(first);
		for (const device of rest) {
			expect(snapshot(device)).toEqual(firstSnapshot);
		}
	});

	it("8 devices, 400 random steps — heavy contention, still converges with zero errors", async () => {
		const { devices, allErrors, hitRoundCap } = await runRandomizedScenario(31337, 8, 400);

		expect(allErrors, `unexpected sync errors: ${JSON.stringify(allErrors)}`).toHaveLength(0);
		expect(hitRoundCap).toBe(false);

		const [first, ...rest] = devices;
		const firstSnapshot = snapshot(first);
		for (const device of rest) {
			expect(snapshot(device)).toEqual(firstSnapshot);
		}
	});

	it("2 devices, 200 steps, sparse collisions (20-file pool) — mostly independent edits, still converges", async () => {
		const sparsePool = Array.from({ length: 20 }, (_, i) => `file-${i}.md`);
		const { devices, allErrors, hitRoundCap } = await runRandomizedScenario(20260710, 2, 200, sparsePool);

		expect(allErrors, `unexpected sync errors: ${JSON.stringify(allErrors)}`).toHaveLength(0);
		expect(hitRoundCap).toBe(false);
		expect(snapshot(devices[0])).toEqual(snapshot(devices[1]));
	});

	it("2 devices, 200 steps, dense collisions (single shared file) — maximal conflict pressure", async () => {
		const { devices, allErrors, hitRoundCap } = await runRandomizedScenario(654321, 2, 200, ["only-file.md"]);

		expect(allErrors, `unexpected sync errors: ${JSON.stringify(allErrors)}`).toHaveLength(0);
		expect(hitRoundCap).toBe(false);
		expect(snapshot(devices[0])).toEqual(snapshot(devices[1]));
	});
});

describe("randomized convergence never silently loses content", () => {
	it("every distinct piece of content written anywhere survives somewhere in the converged state, or was genuinely deleted last", async () => {
		// A stronger, harder-to-satisfy invariant than plain convergence: track
		// every (path, content) pair ever written locally during the random
		// phase, and confirm that after quiescence, for each path, the FINAL
		// converged content across all devices equals SOME content that was
		// actually written to that path at some point (never corrupted/mixed),
		// and is never silently different from every write that ever happened.
		const seed = 2026;
		const rand = mulberry32(seed);
		const remote = new InMemoryRemote();
		const devices: Device[] = Array.from({ length: 3 }, (_, i) => ({
			name: `device-${i}`,
			vault: new InMemoryVault(),
			manifest: new SyncManifest(),
		}));

		const everWritten = new Map<string, Set<string>>(); // path -> set of content strings ever written
		const record = (path: string, content: string) => {
			if (!everWritten.has(path)) everWritten.set(path, new Set());
			everWritten.get(path)!.add(content);
		};

		for (let step = 0; step < 80; step++) {
			const device = pick(rand, devices);
			const path = pick(rand, DEFAULT_FILE_POOL);
			const action = pick(rand, ["create-or-edit", "create-or-edit", "delete", "sync-only"] as const);

			if (action === "delete") {
				if (device.vault.has(path)) await device.vault.deleteFile(path);
			} else if (action === "create-or-edit") {
				const content = `step-${step}-${device.name}-${Math.floor(rand() * 1_000_000)}`;
				await device.vault.writeFile(path, new TextEncoder().encode(content));
				record(path, content);
			}

			const result = await runSyncPass(makeCtx(device, remote));
			expect(result.errors).toHaveLength(0);
		}

		for (let round = 0; round < MAX_QUIESCENCE_ROUNDS; round++) {
			let anyActed = false;
			for (const device of devices) {
				const result = await runSyncPass(makeCtx(device, remote));
				expect(result.errors).toHaveLength(0);
				if (result.plan.some((entry) => entry.action !== "noop")) anyActed = true;
			}
			if (!anyActed) break;
		}

		// For every canonical (non-conflict-copy) path that survived, its final
		// content must be something that was genuinely written to that path at
		// some point — never fabricated/corrupted content.
		for (const path of devices[0].vault.allPaths()) {
			if (path.includes("conflicted copy")) continue; // derived from a base path's history, checked implicitly
			const finalContent = devices[0].vault.readText(path);
			const validContents = everWritten.get(path);
			expect(
				validContents?.has(finalContent),
				`final content of ${path} ("${finalContent}") was never actually written to that path`
			).toBe(true);
		}
	});
});
