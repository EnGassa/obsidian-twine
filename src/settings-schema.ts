export interface TwineSettings {
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
	/**
	 * Raw recovery-key string (see crypto.ts exportRecoveryKey/importRecoveryKey),
	 * imported via Settings when the passphrase is unknown but a previously
	 * exported recovery key is on hand (BACKLOG.md #9). When set, this takes
	 * priority over `passphrase` for deriving sync keys — see main.ts getKeys().
	 * Same trust tier as `passphrase`/the R2 keys already stored here: plaintext
	 * in data.json, never leaves the device or gets uploaded anywhere.
	 */
	importedRecoveryKey: string;
	deviceName: string;
	syncIntervalSeconds: number;
	lastSyncedAt: number | null;
}

export const DEFAULT_SETTINGS: TwineSettings = {
	endpoint: "",
	region: "auto",
	bucket: "",
	accessKeyId: "",
	secretAccessKey: "",
	saltBase64: "",
	passphrase: "",
	importedRecoveryKey: "",
	deviceName: "",
	syncIntervalSeconds: 20,
	lastSyncedAt: null,
};
