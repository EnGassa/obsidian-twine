/**
 * TS's DOM lib types WebCrypto methods as requiring `BufferSource` backed by
 * a plain `ArrayBuffer`, but `Uint8Array`'s generic `ArrayBufferLike` (which
 * also covers `SharedArrayBuffer`) doesn't structurally satisfy that overload.
 * At runtime any `Uint8Array` works fine here — this cast just satisfies the
 * type checker.
 */
export function asBufferSource(bytes: Uint8Array): BufferSource {
	return bytes as unknown as BufferSource;
}
