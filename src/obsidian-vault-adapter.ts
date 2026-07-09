import { App, Vault, TFile } from "obsidian";
import { VaultAdapter, VaultFileMeta } from "./sync/adapters";
import { normalizePath } from "./util/path";

export class ObsidianVaultAdapter implements VaultAdapter {
	constructor(private readonly app: App) {}

	private get vault(): Vault {
		return this.app.vault;
	}

	/** Paths never handed to the sync engine — plugin/workspace state, not vault
	 * content. Uses Vault#configDir rather than a hardcoded ".obsidian", since
	 * users can (and do) configure a different config folder name. */
	private isIgnored(path: string): boolean {
		const configDir = this.vault.configDir;
		return (
			path.startsWith(`${configDir}/workspace`) ||
			path.startsWith(`${configDir}/plugins`) ||
			path.startsWith(".trash/")
		);
	}

	async listFiles(): Promise<VaultFileMeta[]> {
		// Normalized so the same logical file reports the same path regardless
		// of which OS's filesystem API produced it (see util/path.ts). Note this
		// doesn't fully close the Unicode gap: getAbstractFileByPath() below
		// still looks the file up by whatever form the OS/Obsidian actually
		// indexed it under, which is a residual platform risk we can't resolve
		// from here — see BACKLOG.md #3.
		return this.vault
			.getFiles()
			.filter((f) => !this.isIgnored(f.path))
			.map((f) => ({ path: normalizePath(f.path), mtime: f.stat.mtime, size: f.stat.size }));
	}

	async readFile(path: string): Promise<Uint8Array> {
		const file = this.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) throw new Error(`Not a file: ${path}`);
		return new Uint8Array(await this.vault.readBinary(file));
	}

	async writeFile(path: string, data: Uint8Array): Promise<void> {
		const normalized = normalizePath(path);
		const existing = this.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await this.vault.modifyBinary(existing, data.buffer as ArrayBuffer);
			return;
		}

		await this.ensureParentFolders(normalized);
		await this.vault.createBinary(normalized, data.buffer as ArrayBuffer);
	}

	async deleteFile(path: string): Promise<void> {
		const file = this.vault.getAbstractFileByPath(normalizePath(path));
		// trashFile() (not vault.delete()) respects the user's configured
		// deletion preference — permanent, system trash, or Obsidian's .trash.
		if (file instanceof TFile) await this.app.fileManager.trashFile(file);
	}

	async stat(path: string): Promise<VaultFileMeta> {
		const normalized = normalizePath(path);
		const file = this.vault.getAbstractFileByPath(normalized);
		if (!(file instanceof TFile)) throw new Error(`Not a file: ${path}`);
		return { path: normalized, mtime: file.stat.mtime, size: file.stat.size };
	}

	private async ensureParentFolders(path: string): Promise<void> {
		const parts = path.split("/").slice(0, -1);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.vault.getAbstractFileByPath(current)) {
				await this.vault.createFolder(current).catch(() => {
					/* race with another createFolder call; folder now exists either way */
				});
			}
		}
	}
}
