import { ManifestEntry } from "./types";

/**
 * Local, per-device sync state: "what did we last successfully sync." This is
 * NOT synced itself — it lives in this plugin's own data (via Obsidian's
 * loadData/saveData), separate from the vault's synced file tree.
 */
export class SyncManifest {
	private entries: Map<string, ManifestEntry>;

	constructor(initial: ManifestEntry[] = []) {
		this.entries = new Map(initial.map((e) => [e.path, e]));
	}

	static fromJSON(data: unknown): SyncManifest {
		if (Array.isArray(data)) {
			return new SyncManifest(data as ManifestEntry[]);
		}
		return new SyncManifest([]);
	}

	toJSON(): ManifestEntry[] {
		return Array.from(this.entries.values());
	}

	get(path: string): ManifestEntry | undefined {
		return this.entries.get(path);
	}

	set(entry: ManifestEntry): void {
		this.entries.set(entry.path, entry);
	}

	delete(path: string): void {
		this.entries.delete(path);
	}

	has(path: string): boolean {
		return this.entries.has(path);
	}

	allPaths(): string[] {
		return Array.from(this.entries.keys());
	}

	entriesList(): ManifestEntry[] {
		return Array.from(this.entries.values());
	}
}
