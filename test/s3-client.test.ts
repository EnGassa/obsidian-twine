import { describe, expect, it } from "vitest";
import { deleteObject, Fetcher, FetchLikeResponse, PreconditionFailedError, S3Config } from "../src/store/s3-client";

function textResponse(status: number, body: string): FetchLikeResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: () => null, forEach: () => {} },
		arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
		text: async () => body,
	};
}

function makeConfig(fetcher: Fetcher): S3Config {
	return {
		endpoint: "https://fake-bucket.example.com",
		region: "auto",
		bucket: "my-bucket",
		accessKeyId: "AKIA_FAKE",
		secretAccessKey: "fake-secret",
		fetcher,
	};
}

describe("deleteObject error handling", () => {
	it("throws PreconditionFailedError on 412", async () => {
		const config = makeConfig(async () => textResponse(412, "Precondition Failed"));
		await expect(deleteObject(config, "some-key")).rejects.toThrow(PreconditionFailedError);
	});

	it("treats 404 as success (object already gone is an acceptable outcome for delete)", async () => {
		const config = makeConfig(async () => textResponse(404, "Not Found"));
		await expect(deleteObject(config, "some-key")).resolves.toBeUndefined();
	});

	it("throws a descriptive error on an unexpected server error (5xx)", async () => {
		const config = makeConfig(async () => textResponse(500, "Internal Server Error"));
		await expect(deleteObject(config, "some-key")).rejects.toThrow(/DELETE.*failed.*500/);
	});

	it("succeeds on 200/204", async () => {
		const config200 = makeConfig(async () => textResponse(200, ""));
		await expect(deleteObject(config200, "some-key")).resolves.toBeUndefined();

		const config204 = makeConfig(async () => textResponse(204, ""));
		await expect(deleteObject(config204, "some-key")).resolves.toBeUndefined();
	});
});
