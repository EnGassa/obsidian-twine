import { requestUrl } from "obsidian";
import { Fetcher } from "./s3-client";

/**
 * Obsidian's plugin renderer enforces standard browser CORS on `fetch()`.
 * R2/S3 buckets don't send `Access-Control-Allow-Origin` for arbitrary
 * origins by default, so plain fetch() gets blocked at the preflight before
 * a single request reaches the bucket (confirmed empirically 2026-07-09 —
 * "blocked by CORS policy" in Obsidian's console on desktop).
 *
 * `requestUrl()` is Obsidian's own API for exactly this situation: it issues
 * the request outside the renderer's fetch stack (via Electron's net module
 * on desktop, a native bridge on mobile), so it isn't subject to CORS at
 * all. This adapter is the only thing that makes s3-client.ts safe to use
 * from inside the actual plugin — the Node-based spike script and tests
 * don't need it, since Node's fetch never enforced CORS to begin with.
 */
export const obsidianFetcher: Fetcher = async (url, init) => {
	const response = await requestUrl({
		url,
		method: init.method,
		headers: init.headers,
		body: init.body ? toArrayBuffer(init.body) : undefined,
		throw: false,
	});

	return {
		ok: response.status >= 200 && response.status < 300,
		status: response.status,
		headers: {
			get: (name: string) => response.headers[name.toLowerCase()] ?? response.headers[name] ?? null,
			forEach: (callback: (value: string, name: string) => void) => {
				for (const [name, value] of Object.entries(response.headers)) callback(value, name);
			},
		},
		arrayBuffer: async () => response.arrayBuffer,
		text: async () => response.text,
	};
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
