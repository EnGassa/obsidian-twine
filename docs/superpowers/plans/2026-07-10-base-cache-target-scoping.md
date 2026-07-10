# Base Cache Target Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope persisted and in-memory cache/key reuse to a target identity derived from endpoint + region + bucket to prevent reusing old encrypted bases against unrelated remote content when settings change.

**Architecture:** 
1. Maintain `baseCacheTarget` indicating the target (endpoint + region + bucket) the in-memory `baseCache` belongs to.
2. In `persist()`, verify `this.baseCacheTarget` and `this.persistedBaseCacheTarget` against the current target. If either mismatches, discard it to prevent persisting old entries under a new target.
3. In `loadSettingsAndManifest()`, verify `data.baseCacheTarget` against the current target, and discard `persistedBaseCache` if they mismatch.
4. Add a unit/integration test by mocking the Obsidian module that exercises `TwinePlugin` loading, persisting, and changing target settings to ensure proper cache cleanup.

**Tech Stack:** TypeScript, Vitest, Obsidian Plugin API.

## Global Constraints

- Use pnpm as the package manager.
- Verify correctness by running `pnpm test`, `pnpm lint`, and `pnpm build`.
- Do not discard or overwrite unrelated user changes in `main.ts`.

---

### Task 1: Write target-scoping regression tests

**Files:**
- Create: `test/plugin-target-scoping.test.ts`

**Interfaces:**
- Consumes: `TwinePlugin` from `main.ts`
- Produces: A suite of tests verifying target-scoping behavior of the plugin

- [ ] **Step 1: Write the failing tests**

Create the test file with tests that import `TwinePlugin`, mock the `obsidian` module, configure settings, save/load data, and assert that:
1. Reloading settings with the same target restores the cache.
2. Reloading settings with a different target discards the cache.
3. Changing settings (like bucket name) and saving settings clears the cache target and entries so they are not saved under the new target.

```typescript
import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock the obsidian module
vi.mock("obsidian", () => {
	return {
		Plugin: class MockPlugin {
			loadData = vi.fn();
			saveData = vi.fn();
			addSettingTab = vi.fn();
			addStatusBarItem = vi.fn(() => ({ setText: vi.fn() }));
			addRibbonIcon = vi.fn();
			addCommand = vi.fn();
		},
		Notice: class MockNotice {},
		Platform: {
			isMobile: false,
		},
	};
});

import TwinePlugin from "../main";
import { SerializedBaseCache } from "../src/sync/base-cache";

describe("TwinePlugin target scoping", () => {
	let plugin: any;
	let mockData: any;

	beforeEach(() => {
		plugin = new TwinePlugin();
		// Set up app mock
		plugin.app = {};
		mockData = {
			settings: {
				endpoint: "https://s3.example.com",
				region: "us-east-1",
				bucket: "bucket-a",
				passphrase: "test-passphrase",
				salt: "test-salt",
				deviceName: "test-device",
				syncIntervalSeconds: 10,
			},
			manifest: [],
			remoteMetaCache: {},
			baseCache: {
				version: 1,
				entries: {
					"note.md": {
						ciphertext: "fake-ciphertext",
						iv: "fake-iv",
						authTag: "fake-auth-tag",
						mtime: 12345,
						size: 10,
					},
				},
			} as SerializedBaseCache,
			baseCacheTarget: "https://s3.example.com|us-east-1|bucket-a",
		};
		plugin.loadData = vi.fn().mockResolvedValue(mockData);
		plugin.saveData = vi.fn().mockResolvedValue(undefined);
	});

	it("preserves the cache on load and persist if the target matches", async () => {
		await plugin.onload();
		expect(plugin.persistedBaseCache).toBeDefined();
		expect(plugin.persistedBaseCacheTarget).toBe("https://s3.example.com|us-east-1|bucket-a");

		// Persisting without changes should keep the cache and target
		await plugin.saveSettings();
		expect(plugin.saveData).toHaveBeenCalled();
		const saved = plugin.saveData.mock.calls[0][0];
		expect(saved.baseCache).toBeDefined();
		expect(saved.baseCacheTarget).toBe("https://s3.example.com|us-east-1|bucket-a");
	});

	it("discards the cache on load if the target does not match", async () => {
		mockData.baseCacheTarget = "https://s3.example.com|us-east-1|different-bucket";
		await plugin.onload();
		expect(plugin.persistedBaseCache).toBeUndefined();
		expect(plugin.persistedBaseCacheTarget).toBeUndefined();
	});

	it("discards the cache on persist if the settings target changes", async () => {
		await plugin.onload();
		expect(plugin.persistedBaseCache).toBeDefined();

		// Change bucket settings to a different bucket
		plugin.settings.bucket = "bucket-b";

		await plugin.saveSettings();
		const saved = plugin.saveData.mock.calls[0][0];
		expect(saved.baseCache).toBeUndefined();
		expect(saved.baseCacheTarget).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/plugin-target-scoping.test.ts`
Expected: Failure on assertions, as `main.ts` does not yet handle this scoping fully on load and persist.

---

### Task 2: Implement target scoping in TwinePlugin

**Files:**
- Modify: `main.ts`

**Interfaces:**
- Consumes: None
- Produces: A target-scoped implementation of baseCache in `TwinePlugin`

- [ ] **Step 1: Implement the changes in `main.ts`**

Update `main.ts` to:
1. Declare `private baseCacheTarget?: string;` property.
2. In `loadSettingsAndManifest()`, check if `data.baseCacheTarget` matches `this.getCacheTarget()`. If it does, initialize `persistedBaseCache` and `persistedBaseCacheTarget`. Otherwise, set them to `undefined`.
3. In `getKeys()`, set `this.baseCacheTarget = target` when `this.baseCache` is initialized.
4. In `persist()`, check if `this.baseCacheTarget !== target` and if so clear `this.baseCache` and `this.baseCacheTarget`. Similarly check `this.persistedBaseCacheTarget !== target` and if so clear `this.persistedBaseCache` and `this.persistedBaseCacheTarget`. Use `this.baseCache ? target : this.persistedBaseCacheTarget` as the persisted `baseCacheTarget`.

Specifically, update the code in `main.ts`:
```typescript
	private baseCache?: BaseContentCache;
	private baseCacheTarget?: string;
	private persistedBaseCache?: SerializedBaseCache;
	private persistedBaseCacheTarget?: string;
```

In `loadSettingsAndManifest()`:
```typescript
	private async loadSettingsAndManifest(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
		this.syncManifest = SyncManifest.fromJSON(data.manifest ?? []);
		this.remoteMetaCache = RemoteMetaCache.fromJSON(data.remoteMetaCache);
		
		const target = this.getCacheTarget();
		if (data.baseCacheTarget === target) {
			this.persistedBaseCache = data.baseCache;
			this.persistedBaseCacheTarget = data.baseCacheTarget;
		} else {
			this.persistedBaseCache = undefined;
			this.persistedBaseCacheTarget = undefined;
		}
	}
```

In `persist()`:
```typescript
	private async persist(): Promise<void> {
		const target = this.getCacheTarget();
		if (this.baseCache && this.baseCacheTarget !== target) {
			this.baseCache = undefined;
			this.baseCacheTarget = undefined;
		}
		if (this.persistedBaseCacheTarget && this.persistedBaseCacheTarget !== target) {
			this.persistedBaseCache = undefined;
			this.persistedBaseCacheTarget = undefined;
		}

		const payload: PluginData = {
			settings: this.settings,
			manifest: this.syncManifest.toJSON(),
			remoteMetaCache: this.remoteMetaCache.toJSON(),
			baseCache: this.baseCache?.toJSON() ?? this.persistedBaseCache,
			baseCacheTarget: this.baseCache ? target : this.persistedBaseCacheTarget,
		};
		await this.saveData(payload);
	}
```

In `getKeys()`:
```typescript
	private async getKeys(): Promise<DerivedKeys> {
		const target = this.getCacheTarget();
		if (this.settings.importedRecoveryKey) {
			const recoveryKey = this.settings.importedRecoveryKey;
			if (this.cachedKeys?.source === "recovery" && this.cachedKeys.recoveryKey === recoveryKey && this.cachedKeys.target === target) {
				this.baseCache ??= BaseContentCache.fromJSON(this.cachedKeys.keys.contentKey, this.persistedBaseCache);
				this.baseCacheTarget = target;
				return this.cachedKeys.keys;
			}

			const keys = await importRecoveryKey(recoveryKey);
			await verifyOrEstablishKeyCheck(this.getS3Config(), keys);
			this.cachedKeys = { source: "recovery", recoveryKey, target, keys };
			// A newly selected key source must never reuse entries encrypted for a
			// previous source. On first load, persisted entries are attempted so a
			// restart with the same key can recover them; authentication failures
			// are treated as misses by BaseContentCache.
			this.baseCache = BaseContentCache.fromJSON(keys.contentKey, this.persistedBaseCacheTarget === target ? this.persistedBaseCache : undefined);
			this.baseCacheTarget = target;
			this.persistedBaseCache = undefined;
			this.persistedBaseCacheTarget = undefined;
			return keys;
		}

		const salt = await this.ensureSalt();
		const passphrase = this.settings.passphrase;

		if (
			this.cachedKeys?.source === "passphrase" &&
			this.cachedKeys.passphrase === passphrase &&
			this.cachedKeys.salt === salt &&
			this.cachedKeys.target === target
		) {
			this.baseCache ??= BaseContentCache.fromJSON(this.cachedKeys.keys.contentKey, this.persistedBaseCache);
			this.baseCacheTarget = target;
			return this.cachedKeys.keys;
		}

		const keys = await deriveKeys(passphrase, salt);
		await verifyOrEstablishKeyCheck(this.getS3Config(), keys);
		this.cachedKeys = { source: "passphrase", passphrase, salt, target, keys };
		this.baseCache = BaseContentCache.fromJSON(keys.contentKey, this.persistedBaseCacheTarget === target ? this.persistedBaseCache : undefined);
		this.baseCacheTarget = target;
		this.persistedBaseCache = undefined;
		this.persistedBaseCacheTarget = undefined;
		return keys;
	}
```

- [ ] **Step 2: Run focused test to verify it passes**

Run: `pnpm vitest run test/plugin-target-scoping.test.ts`
Expected: PASS

- [ ] **Step 3: Run full suite and verify correctness**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: PASS, no typescript compiler errors, no lint warnings.

- [ ] **Step 4: Commit**

```bash
git add main.ts test/plugin-target-scoping.test.ts docs/superpowers/plans/2026-07-10-base-cache-target-scoping.md
git commit -m "feat: scope persisted base cache to target endpoint/region/bucket"
```
