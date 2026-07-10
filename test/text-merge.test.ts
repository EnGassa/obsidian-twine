import { describe, expect, it } from "vitest";
import { mergeText } from "../src/sync/text-merge";

describe("mergeText", () => {
	it("merges non-overlapping line edits", () => {
		const result = mergeText("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
		expect(result).toEqual({ status: "merged", text: "A\nb\nC\n" });
	});

	it("accepts identical edits", () => {
		expect(mergeText("a\n", "A\n", "A\n")).toEqual({ status: "merged", text: "A\n" });
	});

	it("reports overlapping edits as a conflict", () => {
		expect(mergeText("a\nb\n", "A\nb\n", "B\nb\n")).toEqual({ status: "conflict" });
	});

	it("handles empty values", () => {
		expect(mergeText("", "", "")).toEqual({ status: "merged", text: "" });
		expect(mergeText("", "x", "")).toEqual({ status: "merged", text: "x" });
		expect(mergeText("\n", "\n", "\n")).toEqual({ status: "merged", text: "\n" });
	});

	it("normalizes CRLF and bare CR line endings", () => {
		expect(mergeText("a\r\nb\r\n", "A\r\nb\r\n", "a\nb\n")).toEqual({ status: "merged", text: "A\nb\n" });
		expect(mergeText("a\rb\r", "A\rb\r", "a\rb\r")).toEqual({ status: "merged", text: "A\nb\n" });
		expect(mergeText("a\n", "a\r\n", "A")).toEqual({ status: "merged", text: "A" });
	});

	it("returns conflict for malformed or unsupported input", () => {
		expect(mergeText(null as unknown as string, "a", "a")).toEqual({ status: "conflict" });
		expect(mergeText("a", 1 as unknown as string, "a")).toEqual({ status: "conflict" });
	});
});
