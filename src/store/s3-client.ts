/**
 * Minimal hand-rolled S3-compatible REST client (AWS SigV4 signing via
 * WebCrypto HMAC-SHA256). Deliberately NOT using the AWS SDK for JS: it
 * assumes Node APIs that don't exist in Obsidian's mobile WebView sandbox.
 * Works against any S3-compatible endpoint (Cloudflare R2, Backblaze B2) by
 * making the endpoint/region configurable rather than hardcoding a provider.
 */

import { asBufferSource } from "../util/bytes";

/** Minimal shape both native `fetch`'s Response and an Obsidian requestUrl()
 * adapter can satisfy, so this client works identically under Node (spike
 * scripts, tests) and inside Obsidian (where plain fetch is CORS-blocked). */
export interface FetchLikeResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: {
		get(name: string): string | null;
		forEach(callback: (value: string, name: string) => void): void;
	};
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
}

export type Fetcher = (
	url: string,
	init: { method: string; headers: Record<string, string>; body?: Uint8Array }
) => Promise<FetchLikeResponse>;

const defaultFetcher: Fetcher = (url, init) =>
	fetch(url, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined });

export interface S3Config {
	endpoint: string; // e.g. "https://<accountid>.r2.cloudflarestorage.com"
	region: string; // "auto" for R2
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Defaults to global fetch. Obsidian plugin code should pass the
	 * requestUrl()-based fetcher from obsidian-fetcher.ts, since plain fetch
	 * is subject to CORS inside Obsidian's renderer and R2/S3 buckets don't
	 * allow arbitrary cross-origin requests by default. */
	fetcher?: Fetcher;
}

export interface PutOptions {
	/** Arbitrary string metadata stored as `x-amz-meta-*` headers. */
	metadata?: Record<string, string>;
	/** Conditional write: only succeed if the current object's ETag matches. */
	ifMatch?: string;
	/** Conditional write: only succeed if the object does not already exist. */
	ifNoneMatch?: "*";
	contentType?: string;
}

export interface PutResult {
	etag: string;
}

export interface GetResult {
	body: Uint8Array;
	etag: string;
	metadata: Record<string, string>;
}

export interface ListedObject {
	key: string;
	etag: string;
	size: number;
	lastModified: string;
}

export class PreconditionFailedError extends Error {
	constructor() {
		super("Precondition failed (412): object changed since last known ETag");
		this.name = "PreconditionFailedError";
	}
}

export class NotFoundError extends Error {
	constructor(key: string) {
		super(`Object not found: ${key}`);
		this.name = "NotFoundError";
	}
}

function hexEncode(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", asBufferSource(new Uint8Array(data)));
	return hexEncode(digest);
}

async function hmacSha256(key: Uint8Array | ArrayBuffer, message: string): Promise<ArrayBuffer> {
	const keyBytes = key instanceof Uint8Array ? key : new Uint8Array(key);
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		asBufferSource(keyBytes),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	return crypto.subtle.sign("HMAC", cryptoKey, asBufferSource(new TextEncoder().encode(message)));
}

function amzDate(): { amzDate: string; dateStamp: string } {
	const now = new Date();
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
	const dateStamp = amzDate.slice(0, 8);
	return { amzDate, dateStamp };
}

function uriEncode(str: string, encodeSlash = true): string {
	return encodeURIComponent(str)
		.replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
		.replace(/%2F/g, encodeSlash ? "%2F" : "/");
}

async function deriveSigningKey(
	secretAccessKey: string,
	dateStamp: string,
	region: string,
	service: string
): Promise<ArrayBuffer> {
	const kDate = await hmacSha256(new TextEncoder().encode("AWS4" + secretAccessKey), dateStamp);
	const kRegion = await hmacSha256(kDate, region);
	const kService = await hmacSha256(kRegion, service);
	return hmacSha256(kService, "aws4_request");
}

interface SignedRequestInit {
	method: string;
	key: string; // object key, already the final (e.g. HMAC'd) key, NOT vault path
	query?: Record<string, string>;
	headers?: Record<string, string>;
	body?: Uint8Array;
}

async function signedRequest(config: S3Config, req: SignedRequestInit): Promise<FetchLikeResponse> {
	const service = "s3";
	const { amzDate: date, dateStamp } = amzDate();
	const bodyHash = await sha256Hex(req.body ?? new Uint8Array());

	const url = new URL(config.endpoint);
	const host = url.host;
	const canonicalUri = `/${config.bucket}/${uriEncode(req.key, false)}`;

	const query = req.query ?? {};
	const canonicalQuery = Object.keys(query)
		.sort()
		.map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
		.join("&");

	const allHeaders: Record<string, string> = {
		host,
		"x-amz-content-sha256": bodyHash,
		"x-amz-date": date,
		...(req.headers ?? {}),
	};

	const sortedHeaderKeys = Object.keys(allHeaders)
		.map((k) => k.toLowerCase())
		.sort();
	const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${allHeaders[k].trim()}\n`).join("");
	const signedHeaders = sortedHeaderKeys.join(";");

	const canonicalRequest = [
		req.method,
		canonicalUri,
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		bodyHash,
	].join("\n");

	const credentialScope = `${dateStamp}/${config.region}/${service}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		date,
		credentialScope,
		await sha256Hex(new TextEncoder().encode(canonicalRequest)),
	].join("\n");

	const signingKey = await deriveSigningKey(config.secretAccessKey, dateStamp, config.region, service);
	const signature = hexEncode(await hmacSha256(signingKey, stringToSign));

	const authHeader =
		`AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, ` +
		`SignedHeaders=${signedHeaders}, Signature=${signature}`;

	const fetchUrl = `${config.endpoint}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
	const fetchHeaders: Record<string, string> = {
		...(req.headers ?? {}),
		"x-amz-content-sha256": bodyHash,
		"x-amz-date": date,
		authorization: authHeader,
	};

	const fetcher = config.fetcher ?? defaultFetcher;
	return fetcher(fetchUrl, { method: req.method, headers: fetchHeaders, body: req.body });
}

const METADATA_PREFIX = "x-amz-meta-";

export async function putObject(
	config: S3Config,
	key: string,
	body: Uint8Array,
	options: PutOptions = {}
): Promise<PutResult> {
	const headers: Record<string, string> = {};
	if (options.contentType) headers["content-type"] = options.contentType;
	if (options.ifMatch) headers["if-match"] = options.ifMatch;
	if (options.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;
	for (const [k, v] of Object.entries(options.metadata ?? {})) {
		headers[`${METADATA_PREFIX}${k}`] = v;
	}

	const res = await signedRequest(config, { method: "PUT", key, headers, body });

	if (res.status === 412) throw new PreconditionFailedError();
	if (!res.ok) throw new Error(`PUT ${key} failed: ${res.status} ${await res.text()}`);

	const etag = (res.headers.get("etag") ?? "").replace(/"/g, "");
	return { etag };
}

export async function getObject(config: S3Config, key: string): Promise<GetResult> {
	const res = await signedRequest(config, { method: "GET", key });

	if (res.status === 404) throw new NotFoundError(key);
	if (!res.ok) throw new Error(`GET ${key} failed: ${res.status} ${await res.text()}`);

	const body = new Uint8Array(await res.arrayBuffer());
	const etag = (res.headers.get("etag") ?? "").replace(/"/g, "");
	const metadata: Record<string, string> = {};
	res.headers.forEach((value, name) => {
		if (name.toLowerCase().startsWith(METADATA_PREFIX)) {
			metadata[name.slice(METADATA_PREFIX.length)] = value;
		}
	});

	return { body, etag, metadata };
}

export interface HeadResult {
	etag: string;
	metadata: Record<string, string>;
}

/** Cheaper than getObject() when only headers/metadata are needed, not the body. */
export async function headObject(config: S3Config, key: string): Promise<HeadResult> {
	const res = await signedRequest(config, { method: "HEAD", key });

	if (res.status === 404) throw new NotFoundError(key);
	if (!res.ok) throw new Error(`HEAD ${key} failed: ${res.status}`);

	const etag = (res.headers.get("etag") ?? "").replace(/"/g, "");
	const metadata: Record<string, string> = {};
	res.headers.forEach((value, name) => {
		if (name.toLowerCase().startsWith(METADATA_PREFIX)) {
			metadata[name.slice(METADATA_PREFIX.length)] = value;
		}
	});

	return { etag, metadata };
}

export async function deleteObject(config: S3Config, key: string, ifMatch?: string): Promise<void> {
	const headers: Record<string, string> = {};
	if (ifMatch) headers["if-match"] = ifMatch;

	const res = await signedRequest(config, { method: "DELETE", key, headers });

	if (res.status === 412) throw new PreconditionFailedError();
	if (!res.ok && res.status !== 404) {
		throw new Error(`DELETE ${key} failed: ${res.status} ${await res.text()}`);
	}
}

/** Lists all objects under a prefix, transparently paginating via ListObjectsV2. */
export async function listObjects(config: S3Config, prefix = ""): Promise<ListedObject[]> {
	const results: ListedObject[] = [];
	let continuationToken: string | undefined;

	do {
		const query: Record<string, string> = { "list-type": "2", prefix };
		if (continuationToken) query["continuation-token"] = continuationToken;

		const res = await signedRequest(config, { method: "GET", key: "", query });
		if (!res.ok) throw new Error(`LIST ${prefix} failed: ${res.status} ${await res.text()}`);

		const xml = await res.text();
		results.push(...parseListObjectsXml(xml));

		const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
		const tokenMatch = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
		continuationToken = truncated && tokenMatch ? tokenMatch[1] : undefined;
	} while (continuationToken);

	return results;
}

function parseListObjectsXml(xml: string): ListedObject[] {
	const objects: ListedObject[] = [];
	const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
	let match: RegExpExecArray | null;

	while ((match = contentsRegex.exec(xml)) !== null) {
		const block = match[1];
		const key = block.match(/<Key>([^<]*)<\/Key>/)?.[1] ?? "";
		const etag = (block.match(/<ETag>"?([^<"]*)"?<\/ETag>/)?.[1] ?? "").replace(/"/g, "");
		const size = Number(block.match(/<Size>([^<]*)<\/Size>/)?.[1] ?? "0");
		const lastModified = block.match(/<LastModified>([^<]*)<\/LastModified>/)?.[1] ?? "";
		objects.push({ key: decodeXmlEntities(key), etag, size, lastModified });
	}

	return objects;
}

function decodeXmlEntities(str: string): string {
	return str
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}
