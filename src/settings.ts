import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TwinePlugin from "../main";
import { deriveKeys, exportRecoveryKey } from "./crypto/crypto";
import { splitEndpointAndBucket } from "./util/endpoint";

export class TwineSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: TwinePlugin
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;

		containerEl.createEl("h2", { text: "🧵 Twine" });
		containerEl.createEl("p", {
			text: "Syncs this vault to your own S3-compatible bucket (Cloudflare R2, Backblaze B2). Nothing leaves this device unencrypted.",
		});

		new Setting(containerEl)
			.setName("Endpoint")
			.setDesc(
				"e.g. https://<accountid>.r2.cloudflarestorage.com — pasting the bucket URL " +
					"straight from the Cloudflare dashboard (with the bucket name in the path) works too, it'll auto-split."
			)
			.addText((text) => {
				text.setPlaceholder("https://<accountid>.r2.cloudflarestorage.com");
				text.setValue(settings.endpoint).onChange(async (value) => {
					const trimmed = value.trim();
					const split = splitEndpointAndBucket(trimmed);

					if (split) {
						settings.endpoint = split.endpoint;
						settings.bucket = split.bucket;
						await this.plugin.saveSettings();
						this.display(); // re-render so the Bucket field reflects the split value
						return;
					}

					settings.endpoint = trimmed;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Region")
			.setDesc('"auto" for R2')
			.addText((text) =>
				text.setValue(settings.region).onChange(async (value) => {
					settings.region = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Bucket").addText((text) => {
			text.setPlaceholder("my-vault-bucket");
			text.setValue(settings.bucket).onChange(async (value) => {
				settings.bucket = value.trim();
				await this.plugin.saveSettings();
			});
		});

		new Setting(containerEl).setName("Access key ID").addText((text) => {
			text.setPlaceholder("R2 API token access key ID");
			text.setValue(settings.accessKeyId).onChange(async (value) => {
				settings.accessKeyId = value.trim();
				await this.plugin.saveSettings();
			});
		});

		new Setting(containerEl).setName("Secret access key").addText((text) => {
			text.inputEl.type = "password";
			text.setPlaceholder("R2 API token secret access key");
			text.setValue(settings.secretAccessKey).onChange(async (value) => {
				settings.secretAccessKey = value.trim();
				await this.plugin.saveSettings();
			});
		});

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Checks the endpoint/bucket/keys above actually reach the bucket, before you rely on them.")
			.addButton((button) =>
				button.setButtonText("Test connection").onClick(async () => {
					button.setDisabled(true).setButtonText("Testing…");
					try {
						await this.plugin.testConnection();
						new Notice("✅ Connected — bucket reachable.");
					} catch (error) {
						new Notice(`❌ Connection failed: ${String(error instanceof Error ? error.message : error)}`);
					} finally {
						button.setDisabled(false).setButtonText("Test connection");
					}
				})
			);

		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Used to label conflict-copy files, e.g. \"laptop\" or \"phone\".")
			.addText((text) =>
				text.setValue(settings.deviceName).onChange(async (value) => {
					settings.deviceName = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Sync interval (seconds)")
			.setDesc("How often to sync while the app is open, in addition to syncing on every file change.")
			.addText((text) =>
				text.setValue(String(settings.syncIntervalSeconds)).onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n > 0) {
						settings.syncIntervalSeconds = n;
						await this.plugin.saveSettings();
					}
				})
			);

		containerEl.createEl("h3", { text: "Encryption passphrase" });
		containerEl.createEl("p", {
			text: "Losing this passphrase (and not having exported a recovery key) means your synced data is permanently unrecoverable. There is no server-side recovery — that's the point of end-to-end encryption.",
			cls: "mod-warning",
		});

		new Setting(containerEl).setName("Passphrase").addText((text) => {
			text.inputEl.type = "password";
			text.setValue(settings.passphrase).onChange(async (value) => {
				settings.passphrase = value;
				await this.plugin.saveSettings();
			});
		});

		new Setting(containerEl)
			.setName("Export recovery key")
			.setDesc("Back this up somewhere safe outside the vault (password manager, printed copy).")
			.addButton((button) =>
				button.setButtonText("Export").onClick(async () => {
					await this.exportRecoveryKey();
				})
			);

		if (settings.lastSyncedAt) {
			containerEl.createEl("p", {
				text: `Last synced: ${new Date(settings.lastSyncedAt).toLocaleString()}`,
			});
		}
	}

	private async exportRecoveryKey(): Promise<void> {
		const settings = this.plugin.settings;
		if (!settings.passphrase) {
			new Notice("Enter a passphrase first.");
			return;
		}
		if (!settings.endpoint || !settings.bucket || !settings.accessKeyId || !settings.secretAccessKey) {
			new Notice("Enter the R2/S3 endpoint, bucket, and keys first — the salt is shared via the bucket.");
			return;
		}

		// Fetched from the bucket (or created there if this is the first device),
		// never generated locally — every device must share the same salt.
		const salt = await this.plugin.ensureSalt();
		const keys = await deriveKeys(settings.passphrase, salt);
		const recoveryKey = await exportRecoveryKey(keys);

		await navigator.clipboard.writeText(recoveryKey);
		new Notice("Recovery key copied to clipboard. Store it somewhere safe outside this vault.");
	}
}
