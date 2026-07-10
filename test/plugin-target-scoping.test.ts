import { vi, describe, it, expect, beforeEach, Mock } from "vitest";
import { App, PluginManifest } from "obsidian";
import TwinePlugin from "../main";
import { SerializedBaseCache } from "../src/sync/base-cache";
import { TwineSettings } from "../src/settings-schema";


describe("TwinePlugin target scoping", () => {
	let plugin: TwinePlugin;
	let mockData: {
		settings: TwineSettings;
		manifest: unknown[];
		remoteMetaCache: Record<string, unknown>;
		baseCache: SerializedBaseCache;
		baseCacheTarget?: string;
	};

	beforeEach(() => {
		// Mock globals for Obsidian's browser environment
		(globalThis as unknown as Record<string, unknown>).window = globalThis;
		(globalThis as unknown as Record<string, unknown>).activeDocument = {
			visibilityState: "visible",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		};

		plugin = new TwinePlugin(null as unknown as App, null as unknown as PluginManifest);
		// Set up app mock
		plugin.app = {
			workspace: {
				onLayoutReady: vi.fn(),
			} as unknown as App["workspace"],
			vault: {
				on: vi.fn(),
			} as unknown as App["vault"],
		} as unknown as App;
		mockData = {
			settings: {
				endpoint: "https://s3.example.com",
				region: "us-east-1",
				bucket: "bucket-a",
				accessKeyId: "fake-key-id",
				secretAccessKey: "fake-secret-key",
				passphrase: "test-passphrase",
				saltBase64: "test-salt",
				importedRecoveryKey: "",
				deviceName: "test-device",
				syncIntervalSeconds: 10,
				lastSyncedAt: null,
			},
			manifest: [],
			remoteMetaCache: {},
			baseCache: {
				entries: {
					"note.md": {
						ciphertext: "fake-ciphertext",
						access: 1,
					},
				},
				nextAccess: 2,
			} as SerializedBaseCache,
			baseCacheTarget: "https://s3.example.com|us-east-1|bucket-a",
		};
		plugin.loadData = vi.fn().mockResolvedValue(mockData);
		plugin.saveData = vi.fn().mockResolvedValue(undefined);
	});

	it("preserves the cache on load and persist if the target matches", async () => {
		await plugin.onload();
		expect(plugin["persistedBaseCache"]).toBeDefined();
		expect(plugin["persistedBaseCacheTarget"]).toBe("https://s3.example.com|us-east-1|bucket-a");

		// Persisting without changes should keep the cache and target
		await plugin.saveSettings();
		expect(plugin.saveData).toHaveBeenCalled();
		const saved = (plugin.saveData as Mock).mock.calls[0][0];
		expect(saved.baseCache).toBeDefined();
		expect(saved.baseCacheTarget).toBe("https://s3.example.com|us-east-1|bucket-a");
	});

	it("discards the cache on load if the target does not match", async () => {
		mockData.baseCacheTarget = "https://s3.example.com|us-east-1|different-bucket";
		await plugin.onload();
		expect(plugin["persistedBaseCache"]).toBeUndefined();
		expect(plugin["persistedBaseCacheTarget"]).toBeUndefined();
	});

	it("discards the cache on persist if the settings target changes", async () => {
		await plugin.onload();
		expect(plugin["persistedBaseCache"]).toBeDefined();

		// Change bucket settings to a different bucket
		plugin.settings.bucket = "bucket-b";

		await plugin.saveSettings();
		const saved = (plugin.saveData as Mock).mock.calls[0][0];
		expect(saved.baseCache).toBeUndefined();
		expect(saved.baseCacheTarget).toBeUndefined();
		expect(plugin["persistedBaseCache"]).toBeUndefined();
		expect(plugin["persistedBaseCacheTarget"]).toBeUndefined();
		expect(plugin["baseCache"]).toBeUndefined();
		expect(plugin["baseCacheTarget"]).toBeUndefined();
	});
});
