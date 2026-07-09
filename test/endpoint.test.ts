import { describe, expect, it } from "vitest";
import { splitEndpointAndBucket } from "../src/util/endpoint";

describe("splitEndpointAndBucket", () => {
	it("splits a combined endpoint+bucket URL", () => {
		const result = splitEndpointAndBucket("https://abc123.r2.cloudflarestorage.com/my-bucket");
		expect(result).toEqual({ endpoint: "https://abc123.r2.cloudflarestorage.com", bucket: "my-bucket" });
	});

	it("strips a trailing slash after the bucket", () => {
		const result = splitEndpointAndBucket("https://abc123.r2.cloudflarestorage.com/my-bucket/");
		expect(result).toEqual({ endpoint: "https://abc123.r2.cloudflarestorage.com", bucket: "my-bucket" });
	});

	it("returns null for a bare endpoint with no bucket path", () => {
		expect(splitEndpointAndBucket("https://abc123.r2.cloudflarestorage.com")).toBeNull();
		expect(splitEndpointAndBucket("https://abc123.r2.cloudflarestorage.com/")).toBeNull();
	});

	it("returns null for an invalid or partial URL (e.g. mid-typing)", () => {
		expect(splitEndpointAndBucket("https://")).toBeNull();
		expect(splitEndpointAndBucket("not a url")).toBeNull();
		expect(splitEndpointAndBucket("")).toBeNull();
	});

	it("URL-decodes a bucket name with special characters", () => {
		const result = splitEndpointAndBucket("https://abc123.r2.cloudflarestorage.com/my%20bucket");
		expect(result).toEqual({ endpoint: "https://abc123.r2.cloudflarestorage.com", bucket: "my bucket" });
	});
});
