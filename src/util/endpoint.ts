/**
 * Cloudflare's dashboard shows a bucket's "public URL"/S3 endpoint with the
 * bucket name already appended to the path (e.g.
 * "https://<accountid>.r2.cloudflarestorage.com/<bucket>"), which is what
 * people naturally copy-paste — but S3Config wants those as two separate
 * fields. Detects that shape and splits it, instead of making the user
 * figure out the split themselves (real friction hit setting this up).
 */
export function splitEndpointAndBucket(value: string): { endpoint: string; bucket: string } | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}

	const pathSegment = url.pathname.replace(/^\/+|\/+$/g, "");
	if (!pathSegment) return null;

	return { endpoint: url.origin, bucket: decodeURIComponent(pathSegment) };
}
