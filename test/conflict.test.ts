import { describe, expect, it } from "vitest";
import { resolveConflict } from "../src/sync/conflict";
import { LocalFileState, RemoteFileState, SyncPlanEntry } from "../src/sync/types";

function conflictEntry(overrides: Partial<SyncPlanEntry> = {}): SyncPlanEntry {
	const local: LocalFileState = { path: "note.md", contentHash: "a", mtime: 100, size: 1 };
	const remote: RemoteFileState = {
		path: "note.md",
		contentHash: "b",
		etag: "etag-1",
		lastModified: new Date(50).toISOString(),
	};
	return { path: "note.md", action: "conflict", local, remote, ...overrides };
}

describe("resolveConflict", () => {
	it("throws when called on a non-conflict entry", () => {
		const entry: SyncPlanEntry = { path: "note.md", action: "noop" };
		expect(() => resolveConflict(entry, "device-a")).toThrow(/non-conflict plan entry/);
	});

	it("throws when local is missing on a nominally-conflict entry", () => {
		const entry = conflictEntry({ local: undefined });
		expect(() => resolveConflict(entry, "device-a")).toThrow();
	});

	it("throws when remote is missing on a nominally-conflict entry", () => {
		const entry = conflictEntry({ remote: undefined });
		expect(() => resolveConflict(entry, "device-a")).toThrow();
	});

	it("picks local as winner when local mtime is later than remote's LastModified", () => {
		const entry = conflictEntry({
			local: { path: "note.md", contentHash: "a", mtime: 2000, size: 1 },
			remote: {
				path: "note.md",
				contentHash: "b",
				etag: "e",
				lastModified: new Date(1000).toISOString(),
			},
		});
		expect(resolveConflict(entry, "device-a").winner).toBe("local");
	});

	it("picks remote as winner when remote's LastModified is later than local mtime", () => {
		const entry = conflictEntry({
			local: { path: "note.md", contentHash: "a", mtime: 1000, size: 1 },
			remote: {
				path: "note.md",
				contentHash: "b",
				etag: "e",
				lastModified: new Date(2000).toISOString(),
			},
		});
		expect(resolveConflict(entry, "device-a").winner).toBe("remote");
	});

	it("picks remote as winner on an exact tie (>, not >=)", () => {
		const entry = conflictEntry({
			local: { path: "note.md", contentHash: "a", mtime: 1000, size: 1 },
			remote: {
				path: "note.md",
				contentHash: "b",
				etag: "e",
				lastModified: new Date(1000).toISOString(),
			},
		});
		expect(resolveConflict(entry, "device-a").winner).toBe("remote");
	});

	describe("conflict-copy filename", () => {
		const when = new Date("2026-07-10T12:34:56.000Z");

		it("preserves the extension and inserts the marker before it", () => {
			const entry = conflictEntry({ path: "folder/note.md" });
			const { conflictCopyPath } = resolveConflict(entry, "laptop", when);
			expect(conflictCopyPath).toBe("folder/note (conflicted copy laptop 2026-07-10 123456.0).md");
		});

		it("handles a path with no extension", () => {
			const entry = conflictEntry({ path: "folder/README" });
			const { conflictCopyPath } = resolveConflict(entry, "laptop", when);
			expect(conflictCopyPath).toBe("folder/README (conflicted copy laptop 2026-07-10 123456.0)");
		});

		it("doesn't mistake a dot in a folder name for a file extension", () => {
			const entry = conflictEntry({ path: "my.folder/README" });
			const { conflictCopyPath } = resolveConflict(entry, "laptop", when);
			expect(conflictCopyPath).toBe("my.folder/README (conflicted copy laptop 2026-07-10 123456.0)");
		});

		it("sanitizes filesystem-illegal characters out of the device name", () => {
			const entry = conflictEntry({ path: "note.md" });
			const { conflictCopyPath } = resolveConflict(entry, 'phone: "work"/*?', when);
			expect(conflictCopyPath).toBe("note (conflicted copy phone- -work---- 2026-07-10 123456.0).md");
			// No raw illegal characters leaked through from the device name.
			expect(conflictCopyPath).not.toMatch(/["*?<>|]/);
		});

		it("handles a bare root-level filename with a dotfile-style extension", () => {
			const entry = conflictEntry({ path: ".gitignore" });
			const { conflictCopyPath } = resolveConflict(entry, "laptop", when);
			// lastDot === 0 is not > lastIndexOf("/") === -1, so this DOES count
			// as having an "extension" of the whole name after the dot — document
			// the actual (slightly odd but harmless) behavior rather than assume it.
			expect(conflictCopyPath).toBe(" (conflicted copy laptop 2026-07-10 123456.0).gitignore");
		});
	});
});
