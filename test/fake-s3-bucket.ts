import { Fetcher, FetchLikeResponse } from "../src/store/s3-client";

interface StoredObject {
	body: Uint8Array;
	etag: string;
	metadata: Record<string, string>;
}

function xmlEscape(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function textResponse(status: number, body: string, headers: Record<string, string> = {}): FetchLikeResponse {
	const lowerHeaders = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: {
			get: (name: string) => lowerHeaders.get(name.toLowerCase()) ?? null,
			forEach: (cb: (value: string, name: string) => void) => lowerHeaders.forEach((v, k) => cb(v, k)),
		},
		arrayBuffer: async () => {
			const bytes = new TextEncoder().encode(body);
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		},
		text: async () => body,
	};
}

function binaryResponse(status: number, body: Uint8Array, headers: Record<string, string> = {}): FetchLikeResponse {
	const lowerHeaders = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: {
			get: (name: string) => lowerHeaders.get(name.toLowerCase()) ?? null,
			forEach: (cb: (value: string, name: string) => void) => lowerHeaders.forEach((v, k) => cb(v, k)),
		},
		arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
		text: async () => new TextDecoder().decode(body),
	};
}

/**
 * Minimal in-memory stand-in for an S3-compatible bucket, implementing just
 * enough of the REST surface (list-type=2 LIST, GET/HEAD/PUT/DELETE with
 * If-Match/If-None-Match, x-amz-meta-* metadata) for S3RemoteAdapter and
 * s3-client.ts to operate against without a live network or the AWS SDK.
 * Tracks per-verb request counts so tests can assert on request volume
 * (see BACKLOG.md #6's HEAD-elimination test).
 */
export class FakeS3Bucket {
	private objects = new Map<string, StoredObject>();
	private etagCounter = 0;
	requestCounts = { GET: 0, PUT: 0, DELETE: 0, HEAD: 0, LIST: 0 };

	fetcher: Fetcher = async (url, init) => {
		const parsed = new URL(url);
		// canonicalUri is "/<bucket>/<key>" — key may be empty for LIST requests.
		const key = decodeURIComponent(parsed.pathname.split("/").slice(2).join("/"));
		const headers = new Map(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));

		if (parsed.searchParams.get("list-type") === "2") {
			this.requestCounts.LIST++;
			return this.handleList(parsed.searchParams.get("prefix") ?? "");
		}

		switch (init.method) {
			case "PUT":
				this.requestCounts.PUT++;
				return this.handlePut(key, init.body ?? new Uint8Array(), headers);
			case "GET":
				this.requestCounts.GET++;
				return this.handleGet(key);
			case "HEAD":
				this.requestCounts.HEAD++;
				return this.handleHead(key);
			case "DELETE":
				this.requestCounts.DELETE++;
				return this.handleDelete(key, headers);
			default:
				throw new Error(`FakeS3Bucket: unsupported method ${init.method}`);
		}
	};

	private handleList(prefix: string): FetchLikeResponse {
		const entries = Array.from(this.objects.entries()).filter(([key]) => key.startsWith(prefix));
		const contents = entries
			.map(
				([key, obj]) => `<Contents>
	<Key>${xmlEscape(key)}</Key>
	<ETag>"${obj.etag}"</ETag>
	<Size>${obj.body.byteLength}</Size>
	<LastModified>${new Date().toISOString()}</LastModified>
</Contents>`
			)
			.join("");
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
		return textResponse(200, xml);
	}

	private handleGet(key: string): FetchLikeResponse {
		const obj = this.objects.get(key);
		if (!obj) return textResponse(404, "Not Found");
		return binaryResponse(200, obj.body, this.responseHeaders(obj));
	}

	private handleHead(key: string): FetchLikeResponse {
		const obj = this.objects.get(key);
		if (!obj) return textResponse(404, "Not Found");
		return textResponse(200, "", this.responseHeaders(obj));
	}

	private handlePut(key: string, body: Uint8Array, headers: Map<string, string>): FetchLikeResponse {
		const existing = this.objects.get(key);
		const ifMatch = headers.get("if-match");
		const ifNoneMatch = headers.get("if-none-match");

		if (ifMatch !== undefined && existing?.etag !== ifMatch) {
			return textResponse(412, "Precondition Failed");
		}
		if (ifNoneMatch === "*" && existing !== undefined) {
			return textResponse(412, "Precondition Failed");
		}

		const metadata: Record<string, string> = {};
		for (const [k, v] of headers) {
			if (k.startsWith("x-amz-meta-")) metadata[k.slice("x-amz-meta-".length)] = v;
		}

		const etag = `etag-${++this.etagCounter}`;
		this.objects.set(key, { body, etag, metadata });
		return textResponse(200, "", { etag: `"${etag}"` });
	}

	private handleDelete(key: string, headers: Map<string, string>): FetchLikeResponse {
		const existing = this.objects.get(key);
		const ifMatch = headers.get("if-match");
		if (ifMatch !== undefined && existing?.etag !== ifMatch) {
			return textResponse(412, "Precondition Failed");
		}
		this.objects.delete(key);
		return textResponse(204, "");
	}

	private responseHeaders(obj: StoredObject): Record<string, string> {
		const headers: Record<string, string> = { etag: `"${obj.etag}"` };
		for (const [k, v] of Object.entries(obj.metadata)) headers[`x-amz-meta-${k}`] = v;
		return headers;
	}

	/** Test helper: inspect the raw stored object keys (bypassing HMAC/decrypt),
	 * e.g. to assert a legacy key was actually deleted after reconciliation. */
	hasRawKey(key: string): boolean {
		return this.objects.has(key);
	}

	rawKeys(): string[] {
		return Array.from(this.objects.keys());
	}

	/** Test helper: seed an object directly under a specific raw key, bypassing
	 * PUT semantics — used to simulate a pre-existing legacy-format object. */
	seedRaw(key: string, body: Uint8Array, metadata: Record<string, string>): void {
		this.objects.set(key, { body, etag: `etag-${++this.etagCounter}`, metadata });
	}
}
