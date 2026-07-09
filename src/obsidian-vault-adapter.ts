import { TFile, Vault } from "obsidian";
import { VaultAdapter, VaultFileMeta } from "./sync/adapters";

/** Paths never handed to the sync engine — plugin/workspace state, not vault content. */
const IGNORED_PREFIXES = [".obsidian/workspace", ".obsidian/plugins", ".trash/"];

function isIgnored(path: string): boolean {
	return IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export class ObsidianVaultAdapter implements VaultAdapter {
	constructor(private readonly vault: Vault) {}

	async listFiles(): Promise<VaultFileMeta[]> {
		return this.vault
			.getFiles()
			.filter((f) => !isIgnored(f.path))
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
		if (file instanceof TFile) await this.vault.delete(file);
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
