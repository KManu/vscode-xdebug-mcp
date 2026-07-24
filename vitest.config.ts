import { defineConfig } from "vitest/config";
import * as path from "node:path";

export default defineConfig({
	test: {
		environment: "node",
		pool: "forks",
		globals: true,
		setupFiles: ["./src/__tests__/setup.ts"],
		exclude: [
			"src/test/**",
			"out/test/**",
			"node_modules/**",
			"**/node_modules/**",
			".vscode-test/**",
		],
	},
	resolve: {
		alias: {
			src: path.resolve(__dirname, "./src"),
		},
	},
});
