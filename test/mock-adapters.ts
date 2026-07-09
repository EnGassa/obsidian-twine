import { PreconditionFailedError } from "../src/store/s3-client";
import { RemoteAdapter, RemoteGetResult, RemoteObjectMeta, RemotePutOptions, VaultAdapter, VaultFileMeta } from "../src/sync/adapters";
import { sha256Hex } from "../src/util/hash";

interface VaultRecord {
	data: Uint8Array;
	mtime: number;
}

/** In-memory stand-in for a real Obsidian vault, for testing the sync engine
 * without launching Obsidian. mtime strictly increases per write within a
 * single test run so "newest wins the conflict copy name" is deterministic. */
export class InMemoryVault implements VaultAdapter {
	private files = new Map<string, VaultRecord>();
	private clock = 1;
	/** Per-path readFile() call counts, for tests asserting on unnecessary
	 * re-reads (e.g. BACKLOG.md #8's mtime-bookkeeping regression test). */
	readCounts = new Map<string, number>();

	async listFiles(): Promise<VaultFileMeta[]> {
		return Array.from(this.files.entries()).map(([path, rec]) => ({
			path,
			mtime: rec.mtime,
			size: rec.data.byteLength,
		}));
	}

	async readFile(path: string): Promise<Uint8Array> {
		const rec = this.files.get(path);
		if (!rec) throw new Error(`Not found: ${path}`);
		this.readCounts.set(path, (this.readCounts.get(path) ?? 0) + 1);
		return rec.data;
	}

	async writeFile(path: string, data: Uint8Array, mtime?: number): Promise<void> {
		this.files.set(path, { data, mtime: mtime ?? this.clock++ });
	}

	async deleteFile(path: string): Promise<void> {
		this.files.delete(path);
	}

	async stat(path: string): Promise<VaultFileMeta> {
		const rec = this.files.get(path);
		if (!rec) throw new Error(`Not found: ${path}`);
		return { path, mtime: rec.mtime, size: rec.data.byteLength };
	}

	/** Test helper: directly seed a file without going through writeFile's clock. */
	seed(path: string, text: string, mtime: number): void {
		this.files.set(path, { data: new TextEncoder().encode(text), mtime });
	}

	has(path: string): boolean {
		return this.files.has(path);
	}

	readText(path: string): string {
		const rec = this.files.get(path);
		if (!rec) throw new Error(`Not found: ${path}`);
		return new TextDecoder().decode(rec.data);
	}

	allPaths(): string[] {
		return Array.from(this.files.keys());
	}
}

interface RemoteRecord {
	plaintext: Uint8Array;
	etag: string;
	contentHash: string;
	lastModified: string;
}

/** In-memory stand-in for the encrypted S3 bucket. No actual encryption here —
 * the sync engine only depends on the RemoteAdapter interface, so this mock
 * exercises the engine's conflict/race logic without a live bucket, per Phase
 * 0 Spike 3 in the plan. Conditional writes (ifMatch/ifNoneMatch) mirror real
 * S3/R2 412 semantics via the same PreconditionFailedError sync-engine.ts
 * already handles. */
export class InMemoryRemote implements RemoteAdapter {
	private objects = new Map<string, RemoteRecord>();
	private etagCounter = 0;
	private clock = 1_000_000; // seeded far above InMemoryVault's mtime clock

	async list(): Promise<RemoteObjectMeta[]> {
		return Array.from(this.objects.entries()).map(([path, rec]) => ({
			objectKey: path,
			path,
			etag: rec.etag,
			lastModified: rec.lastModified,
			contentHash: rec.contentHash,
		}));
	}

	async get(path: string): Promise<RemoteGetResult> {
		const rec = this.objects.get(path);
		if (!rec) throw new Error(`Not found: ${path}`);
		return { plaintext: rec.plaintext, etag: rec.etag, contentHash: rec.contentHash };
	}

	async put(path: string, plaintext: Uint8Array, options: RemotePutOptions = {}): Promise<{ etag: string }> {
		const existing = this.objects.get(path);

		if (options.ifMatch !== undefined && existing?.etag !== options.ifMatch) {
			throw new PreconditionFailedError();
		}
		if (options.ifNoneMatch === "*" && existing !== undefined) {
			throw new PreconditionFailedError();
		}

		const etag = `etag-${++this.etagCounter}`;
		const contentHash = await sha256Hex(plaintext);
		const lastModified = new Date(this.clock++).toISOString();
		this.objects.set(path, { plaintext, etag, contentHash, lastModified });
		return { etag };
	}

	async delete(path: string, ifMatch?: string): Promise<void> {
		const existing = this.objects.get(path);
		if (ifMatch !== undefined && existing?.etag !== ifMatch) {
			throw new PreconditionFailedError();
		}
		this.objects.delete(path);
	}

	/** Test helper: seed remote state directly, bypassing conditional-write checks. */
	async seed(path: string, text: string, lastModified: string): Promise<void> {
		const plaintext = new TextEncoder().encode(text);
		const etag = `etag-${++this.etagCounter}`;
		const contentHash = await sha256Hex(plaintext);
		this.objects.set(path, { plaintext, etag, contentHash, lastModified });
	}

	has(path: string): boolean {
		return this.objects.has(path);
	}

	readText(path: string): string {
		const rec = this.objects.get(path);
		if (!rec) throw new Error(`Not found: ${path}`);
		return new TextDecoder().decode(rec.plaintext);
	}

	allPaths(): string[] {
		return Array.from(this.objects.keys());
	}
}
