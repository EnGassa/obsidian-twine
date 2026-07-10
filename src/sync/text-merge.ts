type Diff3Segment = { ok: string[] } | { conflict: unknown };

// diff3@0.0.4 predates bundled TypeScript declarations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const diff3Merge = require("diff3") as (local: string[], base: string[], remote: string[]) => Diff3Segment[];

export type TextMergeResult = { status: "merged"; text: string } | { status: "conflict" };

function normalize(value: string): { lines: string[]; trailingNewline: boolean } {
	const normalized = value.replace(/\r\n?/g, "\n");
	const trailingNewline = normalized.endsWith("\n");
	if (normalized === "") return { lines: [], trailingNewline: false };
	const lines = normalized.split("\n");
	if (trailingNewline) lines.pop();
	return { lines, trailingNewline };
}

function normalizedValue(parts: { lines: string[]; trailingNewline: boolean }): string {
	const text = parts.lines.join("\n");
	return parts.trailingNewline ? `${text}\n` : text;
}

export function mergeText(base: string, local: string, remote: string): TextMergeResult {
	if (typeof base !== "string" || typeof local !== "string" || typeof remote !== "string") {
		return { status: "conflict" };
	}

	try {
		const baseParts = normalize(base);
		const localParts = normalize(local);
		const remoteParts = normalize(remote);
		const result = diff3Merge(localParts.lines, baseParts.lines, remoteParts.lines);
		if (!Array.isArray(result) || result.some((segment) => !segment || !("ok" in segment))) {
			return { status: "conflict" };
		}

		const text = result.flatMap((segment) => ("ok" in segment ? segment.ok : [])).join("\n");
		const normalizedBase = normalizedValue(baseParts);
		const normalizedLocal = normalizedValue(localParts);
		const normalizedRemote = normalizedValue(remoteParts);
		const trailingNewline = localParts.trailingNewline === remoteParts.trailingNewline
			? localParts.trailingNewline
			: normalizedLocal === normalizedBase
				? remoteParts.trailingNewline
				: normalizedRemote === normalizedBase
					? localParts.trailingNewline
					: localParts.trailingNewline || remoteParts.trailingNewline;
		return { status: "merged", text: trailingNewline ? `${text}\n` : text };
	} catch {
		return { status: "conflict" };
	}
}
