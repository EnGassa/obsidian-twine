import { Notice, Plugin } from "obsidian";
import { deriveKeys, DerivedKeys } from "./src/crypto/crypto";
import { ObsidianVaultAdapter } from "./src/obsidian-vault-adapter";
import { obsidianFetcher } from "./src/store/obsidian-fetcher";
import { TwineSettingTab } from "./src/settings";
import { DEFAULT_SETTINGS, TwineSettings } from "./src/settings-schema";
import { listObjects, S3Config } from "./src/store/s3-client";
import { S3RemoteAdapter } from "./src/store/s3-remote-adapter";
import { getOrCreateSharedSalt } from "./src/store/sync-meta";
import { SyncManifest } from "./src/sync/manifest";
import { SyncQueue } from "./src/sync/queue";
import { runSyncPass } from "./src/sync/sync-engine";
import { registerSyncTriggers } from "./src/triggers/triggers";
import { sha256Hex } from "./src/util/hash";

interface PluginData {
	settings: TwineSettings;
	manifest: unknown;
}

export default class TwinePlugin extends Plugin {
	settings!: TwineSettings;
	private syncManifest!: SyncManifest;
	private queue?: SyncQueue;
	private statusBarItem?: HTMLElement;

	async onload(): Promise<void> {
		await this.loadSettingsAndManifest();
		this.addSettingTab(new TwineSettingTab(this.app, this));

		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar("idle");

		this.addRibbonIcon("refresh-cw", "🧵 Twine: Sync now", () => void this.queue?.triggerNow());
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.queue?.triggerNow(),
		});

		this.queue = new SyncQueue(1_200, () => this.runPass());
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
	}

	private async persist(): Promise<void> {
		const payload: PluginData = { settings: this.settings, manifest: this.syncManifest.toJSON() };
		await this.saveData(payload);
	}

	private isConfigured(): boolean {
		const s = this.settings;
		return Boolean(s.endpoint && s.bucket && s.accessKeyId && s.secretAccessKey && s.passphrase);
	}

	private getS3Config(): S3Config {
		return {
			endpoint: this.settings.endpoint,
			region: this.settings.region,
			bucket: this.settings.bucket,
			accessKeyId: this.settings.accessKeyId,
			secretAccessKey: this.settings.secretAccessKey,
			fetcher: obsidianFetcher,
		};
	}

	/**
	 * Cheap connectivity check for the settings UI: lists the bucket with the
	 * currently-entered endpoint/bucket/keys, without needing a passphrase or
	 * a full sync pass. Throws with whatever error s3-client.ts produced
	 * (auth failure, bucket not found, network error) — settings.ts surfaces
	 * that message directly rather than needing its own error classification.
	 */
	async testConnection(): Promise<void> {
		await listObjects(this.getS3Config(), "");
	}

	/**
	 * The PBKDF2 salt must be identical across every device syncing to this
	 * bucket (same passphrase + different salt = different key = nothing
	 * decrypts across devices). Fetched from the bucket itself (unencrypted,
	 * see src/store/sync-meta.ts) rather than generated locally per-device,
	 * so a second device picks up the first device's salt automatically.
	 */
	async ensureSalt(): Promise<string> {
		if (this.settings.saltBase64) return this.settings.saltBase64;

		const salt = await getOrCreateSharedSalt(this.getS3Config());
		this.settings.saltBase64 = salt;
		await this.persist();
		return salt;
	}

	private async getKeys(): Promise<DerivedKeys> {
		const salt = await this.ensureSalt();
		return deriveKeys(this.settings.passphrase, salt);
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
			const s3Config = this.getS3Config();

			const result = await runSyncPass({
				vault: new ObsidianVaultAdapter(this.app.vault),
				remote: new S3RemoteAdapter(s3Config, keys),
				manifest: this.syncManifest,
				deviceName: this.settings.deviceName || "unknown-device",
				hashFn: sha256Hex,
				persistManifest: () => this.persist(),
				log: (msg) => console.log(`[twine] ${msg}`),
			});

			this.settings.lastSyncedAt = Date.now();
			await this.persist();

			if (result.errors.length > 0) {
				this.updateStatusBar("error", `${result.errors.length} file(s) failed`);
				new Notice(`Twine: ${result.errors.length} file(s) failed to sync — see console.`);
			} else {
				this.updateStatusBar("idle", new Date().toLocaleTimeString());
			}
		} catch (error) {
			this.updateStatusBar("error");
			console.error("[twine] sync pass failed", error);
			new Notice(`Twine failed: ${String(error)}`);
		}
	}
}
