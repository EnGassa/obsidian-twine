import { Notice, Platform, Plugin } from "obsidian";
import { deriveKeys, DerivedKeys, importRecoveryKey, keyedContentHash } from "./src/crypto/crypto";
import { ObsidianVaultAdapter } from "./src/obsidian-vault-adapter";
import { obsidianFetcher } from "./src/store/obsidian-fetcher";
import { TwineSettingTab } from "./src/settings";
import { DEFAULT_SETTINGS, TwineSettings } from "./src/settings-schema";
import { RemoteMetaCache } from "./src/store/remote-meta-cache";
import { listObjects, S3Config } from "./src/store/s3-client";
import { S3RemoteAdapter } from "./src/store/s3-remote-adapter";
import { getOrCreateSharedSalt, PassphraseMismatchError, verifyOrEstablishKeyCheck } from "./src/store/sync-meta";
import { SyncManifest } from "./src/sync/manifest";
import { SyncQueue } from "./src/sync/queue";
import { runSyncPass } from "./src/sync/sync-engine";
import { BaseContentCache, SerializedBaseCache } from "./src/sync/base-cache";
import { registerSyncTriggers } from "./src/triggers/triggers";

interface PluginData {
	settings: TwineSettings;
	manifest: unknown;
	remoteMetaCache: unknown;
	baseCache?: SerializedBaseCache;
	baseCacheTarget?: string;
}

export default class TwinePlugin extends Plugin {
	settings!: TwineSettings;
	private syncManifest!: SyncManifest;
	/** Persisted across passes (not re-created per pass, unlike S3RemoteAdapter
	 * itself) so its HEAD-avoidance cache actually pays off across the ~20s
	 * foreground interval — see BACKLOG.md #6. */
	private remoteMetaCache!: RemoteMetaCache;
	private queue?: SyncQueue;
	private baseCache?: BaseContentCache;
	private baseCacheTarget?: string;
	private persistedBaseCache?: SerializedBaseCache;
	private persistedBaseCacheTarget?: string;
	private statusBarItem?: HTMLElement;
	/** Cached to avoid re-running PBKDF2 (600k iterations, twice) on every
	 * sync pass. Invalidated whenever the input it was derived from changes —
	 * see getKeys(). Two sources (BACKLOG.md #9): the usual passphrase+salt
	 * derivation, or an imported recovery-key string used verbatim (no PBKDF2
	 * needed — a recovery key already IS raw key material). */
	private cachedKeys?:
		| { source: "passphrase"; passphrase: string; salt: string; target: string; keys: DerivedKeys }
		| { source: "recovery"; recoveryKey: string; target: string; keys: DerivedKeys };

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
		this.remoteMetaCache = RemoteMetaCache.fromJSON(data.remoteMetaCache);
		this.persistedBaseCache = data.baseCache;
		this.persistedBaseCacheTarget = data.baseCacheTarget;
		const target = this.getCacheTarget();
		if (this.persistedBaseCacheTarget !== target) {
			this.persistedBaseCache = undefined;
			this.persistedBaseCacheTarget = undefined;
		}
	}

	private async persist(): Promise<void> {
		const target = this.getCacheTarget();
		if (this.baseCacheTarget && this.baseCacheTarget !== target) {
			this.baseCache = undefined;
			this.baseCacheTarget = undefined;
			this.cachedKeys = undefined;
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

	private isConfigured(): boolean {
		const s = this.settings;
		return Boolean(
			s.endpoint && s.bucket && s.accessKeyId && s.secretAccessKey && (s.passphrase || s.importedRecoveryKey)
		);
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

	private getCacheTarget(): string {
		const s = this.settings;
		return `${s.endpoint}|${s.region}|${s.bucket}`;
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

	/** Throws {@link PassphraseMismatchError} if `keys` doesn't match this
	 * bucket's key-check verifier. Exposed for the settings UI (recovery key
	 * export/import) to avoid acting on key material — passphrase-derived or
	 * imported — that's silently wrong for this bucket. */
	async verifyKeys(keys: DerivedKeys): Promise<void> {
		await verifyOrEstablishKeyCheck(this.getS3Config(), keys);
	}

	/**
	 * An imported recovery key (BACKLOG.md #9) takes priority over the
	 * passphrase when both happen to be set — it's raw key material, not a
	 * secret to re-derive from, so there's no salt/PBKDF2 step for it. Either
	 * way, verifyOrEstablishKeyCheck() runs once per fresh derivation (not on
	 * cache hits) so a wrong passphrase OR a malformed/mismatched recovery key
	 * fails fast with a clear error instead of a cryptic one deep in list().
	 */
	private async getKeys(): Promise<DerivedKeys> {
		const target = this.getCacheTarget();
		if (this.settings.importedRecoveryKey) {
			const recoveryKey = this.settings.importedRecoveryKey;
			if (this.cachedKeys?.source === "recovery" && this.cachedKeys.recoveryKey === recoveryKey && this.cachedKeys.target === target) {
				if (!this.baseCache) {
					this.baseCache = BaseContentCache.fromJSON(this.cachedKeys.keys.contentKey, this.persistedBaseCache);
					this.baseCacheTarget = target;
				}
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
			if (!this.baseCache) {
				this.baseCache = BaseContentCache.fromJSON(this.cachedKeys.keys.contentKey, this.persistedBaseCache);
				this.baseCacheTarget = target;
			}
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
				vault: new ObsidianVaultAdapter(this.app),
				remote: new S3RemoteAdapter(s3Config, keys, this.remoteMetaCache),
				manifest: this.syncManifest,
				deviceName: this.settings.deviceName || "unknown-device",
				hashFn: (bytes) => keyedContentHash(keys.contentHashKey, bytes),
				persistManifest: () => this.persist(),
				baseCache: this.baseCache,
				log: (msg) => console.log(`[twine] ${msg}`),
			});

			this.settings.lastSyncedAt = Date.now();
			await this.persist();

			if (result.errors.length > 0) {
				this.updateStatusBar("error", `${result.errors.length} file(s) failed`);
				new Notice(`Twine: ${result.errors.length} file(s) failed to sync — see console.`);
			} else {
				this.updateStatusBar("idle", new Date().toLocaleTimeString());

				// addStatusBarItem() isn't supported on Obsidian mobile at all (desktop-only
				// API), so the status bar above is silently invisible there. Mobile users'
				// only feedback is this Notice — shown only when a pass actually changed
				// something, not on every idle poll, so it doesn't spam every ~20s.
				const actedCount = result.plan.filter((entry) => entry.action !== "noop").length;
				if (Platform.isMobile && actedCount > 0) {
					new Notice(`🧵 Twine: synced ${actedCount} file${actedCount === 1 ? "" : "s"}.`);
				}
			}
		} catch (error) {
			this.updateStatusBar("error");
			if (error instanceof PassphraseMismatchError) {
				console.error("[twine] passphrase mismatch for this bucket");
				new Notice("🧵 Twine: passphrase doesn't match this bucket — check Settings → Twine.");
			} else {
				console.error("[twine] sync pass failed", error);
				new Notice(`Twine failed: ${String(error)}`);
			}
		}
	}
}
