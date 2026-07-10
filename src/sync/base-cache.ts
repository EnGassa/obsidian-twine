import { decryptContentBlob, encryptContentBlob } from "../crypto/crypto";
import { normalizePath } from "../util/path";

export const BASE_CACHE_ENTRY_LIMIT = 128 * 1024;
export const BASE_CACHE_TOTAL_LIMIT = 512 * 1024;

export interface SerializedBaseCacheEntry {
	ciphertext: string;
	/** Monotonic access sequence used for LRU eviction. */
	access: number;
}

export interface SerializedBaseCache {
	entries: Record<string, SerializedBaseCacheEntry>;
	nextAccess?: number;
}

interface Entry {
	ciphertext: Uint8Array;
	access: number;
}

function isEligible(path: string, bytes?: Uint8Array): boolean {
	if (bytes && bytes.byteLength > BASE_CACHE_ENTRY_LIMIT) return false;
	const lower = normalizePath(path).toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdx") || lower.endsWith(".txt");
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function decodeBase64(value: unknown): Uint8Array {
	if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
		throw new Error("Invalid cache ciphertext");
	}
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class BaseContentCache {
	private readonly entries = new Map<string, Entry>();
	private nextAccess = 1;

	static fromJSON(contentKey: CryptoKey, serialized: unknown): BaseContentCache {
		return new BaseContentCache(contentKey, serialized);
	}

	constructor(private readonly contentKey: CryptoKey, serialized?: SerializedBaseCache | string | unknown) {
		if (typeof serialized === "string") {
			try {
				serialized = JSON.parse(serialized) as unknown;
			} catch {
				return;
			}
		}
		if (!isRecord(serialized) || !isRecord(serialized.entries)) return;
		for (const [rawPath, rawEntry] of Object.entries(serialized.entries)) {
			const path = normalizePath(rawPath);
			try {
				if (!isEligible(path) || !isRecord(rawEntry)) continue;
				const ciphertext = decodeBase64(rawEntry.ciphertext);
				const access = rawEntry.access;
				if (!(typeof access === "number" && Number.isSafeInteger(access) && access > 0) || ciphertext.length === 0) continue;
				this.entries.set(path, { ciphertext, access });
				this.nextAccess = Math.max(this.nextAccess, access + 1);
			} catch {
				// Ignore only the malformed record; other entries remain usable.
			}
		}
		if (typeof serialized.nextAccess === "number" && Number.isSafeInteger(serialized.nextAccess)) {
			this.nextAccess = Math.max(this.nextAccess, serialized.nextAccess);
		}
		this.evict();
	}

	async get(path: string): Promise<Uint8Array | undefined> {
		const normalized = normalizePath(path);
		if (!isEligible(normalized)) return undefined;
		const entry = this.entries.get(normalized);
		if (!entry) return undefined;
		try {
			const bytes = await decryptContentBlob(this.contentKey, entry.ciphertext, normalized);
			if (bytes.byteLength > BASE_CACHE_ENTRY_LIMIT) throw new Error("Invalid cache size");
			entry.access = this.nextAccess++;
			return bytes;
		} catch {
			this.entries.delete(normalized);
			return undefined;
		}
	}

	async set(path: string, bytes: Uint8Array): Promise<void> {
		const normalized = normalizePath(path);
		this.entries.delete(normalized);
		if (!isEligible(normalized, bytes)) return;
		try {
			const ciphertext = await encryptContentBlob(this.contentKey, bytes, normalized);
			if (ciphertext.byteLength > BASE_CACHE_TOTAL_LIMIT) return;
			this.entries.set(normalized, { ciphertext, access: this.nextAccess++ });
			this.evict();
		} catch {
			// A failed encryption must not leave stale plaintext or metadata behind.
		}
	}

	delete(path: string): void {
		this.entries.delete(normalizePath(path));
	}

	toJSON(): SerializedBaseCache {
		const entries: Record<string, SerializedBaseCacheEntry> = {};
		for (const [path, entry] of this.entries) {
			entries[path] = { ciphertext: encodeBase64(entry.ciphertext), access: entry.access };
		}
		return { entries, nextAccess: this.nextAccess };
	}

	private evict(): void {
		let total = 0;
		for (const entry of this.entries.values()) total += entry.ciphertext.byteLength;
		while (total > BASE_CACHE_TOTAL_LIMIT && this.entries.size > 0) {
			let oldestPath: string | undefined;
			let oldestAccess = Number.POSITIVE_INFINITY;
			for (const [path, entry] of this.entries) {
				if (entry.access < oldestAccess) {
					oldestAccess = entry.access;
					oldestPath = path;
				}
			}
			if (!oldestPath) break;
			const removed = this.entries.get(oldestPath);
			this.entries.delete(oldestPath);
			total -= removed?.ciphertext.byteLength ?? 0;
		}
	}
}
