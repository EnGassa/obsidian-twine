/**
 * Normalizes a vault-relative path to Unicode NFC. macOS/iOS filesystem APIs
 * report filenames in NFD while Linux/Android/Windows typically use NFC — so
 * the same logical filename (e.g. "Café.md") can arrive as two different
 * byte sequences depending on which device reported it. Without normalizing
 * before it's used for HMAC object keys, manifest keys, or path comparisons,
 * the two forms look like two entirely different files to the sync engine.
 * ASCII paths are unaffected: NFC and NFD are identical for ASCII text.
 * See BACKLOG.md #3.
 */
export function normalizePath(path: string): string {
	return path.normalize("NFC");
}
