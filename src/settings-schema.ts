export interface SelfSyncSettings {
	endpoint: string; // e.g. "https://<accountid>.r2.cloudflarestorage.com"
	region: string; // "auto" for R2
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Base64 PBKDF2 salt. Generated once on first setup, never regenerated. */
	saltBase64: string;
	/**
	 * Cached locally so sync can run unattended (foreground timer, app-open)
	 * without prompting every launch. Accepted risk for a personal-use tool
	 * (see plan risk #3): plaintext in data.json, same tier as the R2 keys
	 * already stored here. Never leaves the device or gets uploaded anywhere.
	 */
	passphrase: string;
	deviceName: string;
	syncIntervalSeconds: number;
	ignorePatterns: string[];
	lastSyncedAt: number | null;
}

export const DEFAULT_SETTINGS: SelfSyncSettings = {
	endpoint: "",
	region: "auto",
	bucket: "",
	accessKeyId: "",
	secretAccessKey: "",
	saltBase64: "",
	passphrase: "",
	deviceName: "",
	syncIntervalSeconds: 90,
	ignorePatterns: [".obsidian/workspace*", ".trash/**"],
	lastSyncedAt: null,
};
