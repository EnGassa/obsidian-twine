import { ManifestEntry } from "./types";
import { normalizePath } from "../util/path";

/**
 * Local, per-device sync state: "what did we last successfully sync." This is
 * NOT synced itself — it lives in this plugin's own data (via Obsidian's
 * loadData/saveData), separate from the vault's synced file tree.
 */
export class SyncManifest {
	private entries: Map<string, ManifestEntry>;

	constructor(initial: ManifestEntry[] = []) {
		this.entries = new Map(
			initial.map((e) => {
				const path = normalizePath(e.path);
				return [path, path === e.path ? e : { ...e, path }];
			})
		);
	}

	/** Normalizes path keys on load so a manifest persisted before the Unicode
	 * path-normalization migration (BACKLOG.md #3) — e.g. on a Mac reporting
	 * NFD paths — self-heals instead of permanently diverging from the
	 * now-always-normalized local/remote states it's compared against. */
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
		return this.entries.get(normalizePath(path));
	}

	set(entry: ManifestEntry): void {
		const path = normalizePath(entry.path);
		this.entries.set(path, path === entry.path ? entry : { ...entry, path });
	}

	delete(path: string): void {
		this.entries.delete(normalizePath(path));
	}

	has(path: string): boolean {
		return this.entries.has(normalizePath(path));
	}

	allPaths(): string[] {
		return Array.from(this.entries.keys());
	}

	entriesList(): ManifestEntry[] {
		return Array.from(this.entries.values());
	}
}
