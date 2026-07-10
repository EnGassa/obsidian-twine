import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
	test: {
		environment: "node",
		alias: {
			obsidian: path.resolve(__dirname, "./test/mock-obsidian.ts"),
		},
	},
});
