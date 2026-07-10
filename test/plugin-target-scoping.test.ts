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
			registerEvent = vi.fn();
			registerInterval = vi.fn();
			register = vi.fn();
		},
		Notice: class MockNotice {},
		Platform: {
			isMobile: false,
		},
		PluginSettingTab: class MockPluginSettingTab {
			constructor(public app: any, public plugin: any) {}
			display() {}
		},
		Setting: class MockSetting {
			constructor(public containerEl: any) {}
			setName = vi.fn().mockReturnThis();
			setDesc = vi.fn().mockReturnThis();
			addText = vi.fn().mockReturnThis();
			addToggle = vi.fn().mockReturnThis();
			addButton = vi.fn().mockReturnThis();
		},
		App: class MockApp {},
		Vault: class MockVault {},
		TFile: class MockTFile {},
		requestUrl: vi.fn(),
	};
});

import TwinePlugin from "../main.ts";
import { SerializedBaseCache } from "../src/sync/base-cache";

describe("TwinePlugin target scoping", () => {
	let plugin: any;
	let mockData: any;

	beforeEach(() => {
		// Mock globals for Obsidian's browser environment
		(global as any).window = global;
		(global as any).activeDocument = {
			visibilityState: "visible",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		};

		plugin = new TwinePlugin();
		// Set up app mock
		plugin.app = {
			workspace: {
				onLayoutReady: vi.fn(),
			},
			vault: {
				on: vi.fn(),
			},
		};
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
