import { App, Vault, TFile } from "obsidian";
import { VaultAdapter, VaultFileMeta } from "./sync/adapters";

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
		return this.vault
			.getFiles()
			.filter((f) => !this.isIgnored(f.path))
			.map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
	}

	async readFile(path: string): Promise<Uint8Array> {
		const file = this.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`Not a file: ${path}`);
		return new Uint8Array(await this.vault.readBinary(file));
	}

	async writeFile(path: string, data: Uint8Array): Promise<void> {
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.vault.modifyBinary(existing, data.buffer as ArrayBuffer);
			return;
		}

		await this.ensureParentFolders(path);
		await this.vault.createBinary(path, data.buffer as ArrayBuffer);
	}

	async deleteFile(path: string): Promise<void> {
		const file = this.vault.getAbstractFileByPath(path);
		// trashFile() (not vault.delete()) respects the user's configured
		// deletion preference — permanent, system trash, or Obsidian's .trash.
		if (file instanceof TFile) await this.app.fileManager.trashFile(file);
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
