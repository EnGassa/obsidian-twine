import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TwinePlugin from "../main";
import { deriveKeys, exportRecoveryKey, importRecoveryKey } from "./crypto/crypto";
import { PassphraseMismatchError } from "./store/sync-meta";
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

		containerEl.createEl("p", {
			text: "🧵 Syncs this vault to your own S3-compatible bucket (Cloudflare R2, Backblaze B2). Nothing leaves this device unencrypted.",
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

		new Setting(containerEl).setName("Encryption passphrase").setHeading();
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

		new Setting(containerEl).setName("Recovery").setHeading();

		if (settings.importedRecoveryKey) {
			containerEl.createEl("p", {
				text: "A recovery key is imported and currently in use for sync instead of the passphrase above.",
			});
			new Setting(containerEl)
				.setName("Clear imported recovery key")
				.setDesc("Reverts to using the passphrase above for sync.")
				.addButton((button) =>
					button.setButtonText("Clear").onClick(async () => {
						settings.importedRecoveryKey = "";
						await this.plugin.saveSettings();
						this.display();
					})
				);
		} else {
			containerEl.createEl("p", {
				text: "Forgot the passphrase but have a previously exported recovery key? Paste it here to sync " +
					"without it. This stores the key material on this device — same trust tier as the passphrase " +
					"and R2 keys already stored here.",
			});
			let recoveryKeyInput = "";
			new Setting(containerEl)
				.setName("Import recovery key")
				.addText((text) => {
					text.setPlaceholder("<base64>.<base64>.<base64>");
					text.onChange((value) => {
						recoveryKeyInput = value.trim();
					});
				})
				.addButton((button) =>
					button.setButtonText("Import").onClick(async () => {
						await this.importRecoveryKey(recoveryKeyInput);
					})
				);
		}

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

		try {
			await this.plugin.verifyKeys(keys);
		} catch (error) {
			if (error instanceof PassphraseMismatchError) {
				new Notice("❌ This passphrase doesn't match this bucket — exporting it would produce a useless recovery key.");
				return;
			}
			throw error;
		}

		const recoveryKey = await exportRecoveryKey(keys);

		await navigator.clipboard.writeText(recoveryKey);
		new Notice("Recovery key copied to clipboard. Store it somewhere safe outside this vault.");
	}

	private async importRecoveryKey(recoveryKeyInput: string): Promise<void> {
		const settings = this.plugin.settings;
		if (!recoveryKeyInput) {
			new Notice("Paste a recovery key first.");
			return;
		}
		if (!settings.endpoint || !settings.bucket || !settings.accessKeyId || !settings.secretAccessKey) {
			new Notice("Enter the R2/S3 endpoint, bucket, and keys first.");
			return;
		}

		let keys;
		try {
			keys = await importRecoveryKey(recoveryKeyInput);
		} catch (error) {
			new Notice(`❌ ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		try {
			await this.plugin.verifyKeys(keys);
		} catch (error) {
			if (error instanceof PassphraseMismatchError) {
				new Notice("❌ This recovery key doesn't match this bucket.");
				return;
			}
			throw error;
		}

		settings.importedRecoveryKey = recoveryKeyInput;
		await this.plugin.saveSettings();
		new Notice("✅ Recovery key imported — sync will use it instead of the passphrase.");
		this.display();
	}
}
