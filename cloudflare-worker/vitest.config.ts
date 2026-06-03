import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "src/google-tokens.ts",
        "src/auth/google.ts",
        "src/index.ts",
        "src/mcp-worker.ts",
        "src/workers/shared.ts",
        "src/google.ts",
      ],
      all: true,
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
});
