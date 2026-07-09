import { Notice, Plugin } from "obsidian";
import { deriveKeys, DerivedKeys, generateSaltBase64 } from "./src/crypto/crypto";
import { ObsidianVaultAdapter } from "./src/obsidian-vault-adapter";
import { SelfSyncSettingTab } from "./src/settings";
import { DEFAULT_SETTINGS, SelfSyncSettings } from "./src/settings-schema";
import { S3Config } from "./src/store/s3-client";
import { S3RemoteAdapter } from "./src/store/s3-remote-adapter";
import { SyncManifest } from "./src/sync/manifest";
import { SyncQueue } from "./src/sync/queue";
import { runSyncPass } from "./src/sync/sync-engine";
import { registerSyncTriggers } from "./src/triggers/triggers";
import { sha256Hex } from "./src/util/hash";

interface PluginData {
	settings: SelfSyncSettings;
	manifest: unknown;
}

export default class SelfSyncPlugin extends Plugin {
	settings!: SelfSyncSettings;
	private syncManifest!: SyncManifest;
	private queue?: SyncQueue;
	private statusBarItem?: HTMLElement;

	async onload(): Promise<void> {
		await this.loadSettingsAndManifest();
		this.addSettingTab(new SelfSyncSettingTab(this.app, this));

		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar("idle");

		this.addRibbonIcon("refresh-cw", "Sync now", () => void this.queue?.triggerNow());
		this.addCommand({
			id: "self-sync-now",
			name: "Sync now",
			callback: () => void this.queue?.triggerNow(),
		});

		this.queue = new SyncQueue(2_500, () => this.runPass());
		registerSyncTriggers(this, this.app, this.queue, this.settings.syncIntervalSeconds * 1000);
	}

	onunload(): void {
		this.queue?.dispose();
	}

	async saveSettings(): Promise<void> {
		await this.persist();
	}

	private async loadSettingsAndManifest(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
		this.syncManifest = SyncManifest.fromJSON(data.manifest ?? []);

		if (!this.settings.saltBase64) {
			this.settings.saltBase64 = generateSaltBase64();
			await this.persist();
		}
	}

	private async persist(): Promise<void> {
		const payload: PluginData = { settings: this.settings, manifest: this.syncManifest.toJSON() };
		await this.saveData(payload);
	}

	private isConfigured(): boolean {
		const s = this.settings;
		return Boolean(s.endpoint && s.bucket && s.accessKeyId && s.secretAccessKey && s.passphrase);
	}

	private async getKeys(): Promise<DerivedKeys> {
		return deriveKeys(this.settings.passphrase, this.settings.saltBase64);
	}

	private updateStatusBar(state: "idle" | "syncing" | "error", detail?: string): void {
		if (!this.statusBarItem) return;
		const label = { idle: "Sync: idle", syncing: "Sync: syncing…", error: "Sync: error" }[state];
		this.statusBarItem.setText(detail ? `${label} (${detail})` : label);
	}

	private async runPass(): Promise<void> {
		if (!this.isConfigured()) return;

		this.updateStatusBar("syncing");
		try {
			const keys = await this.getKeys();
			const s3Config: S3Config = {
				endpoint: this.settings.endpoint,
				region: this.settings.region,
				bucket: this.settings.bucket,
				accessKeyId: this.settings.accessKeyId,
				secretAccessKey: this.settings.secretAccessKey,
			};

			const result = await runSyncPass({
				vault: new ObsidianVaultAdapter(this.app.vault),
				remote: new S3RemoteAdapter(s3Config, keys),
				manifest: this.syncManifest,
				deviceName: this.settings.deviceName || "unknown-device",
				hashFn: sha256Hex,
				persistManifest: () => this.persist(),
				log: (msg) => console.log(`[self-sync] ${msg}`),
			});

			this.settings.lastSyncedAt = Date.now();
			await this.persist();

			if (result.errors.length > 0) {
				this.updateStatusBar("error", `${result.errors.length} file(s) failed`);
				new Notice(`Self Sync: ${result.errors.length} file(s) failed to sync — see console.`);
			} else {
				this.updateStatusBar("idle", new Date().toLocaleTimeString());
			}
		} catch (error) {
			this.updateStatusBar("error");
			console.error("[self-sync] sync pass failed", error);
			new Notice(`Self Sync failed: ${String(error)}`);
		}
	}
}
