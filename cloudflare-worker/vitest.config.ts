import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/jwt.ts", "src/oauth.ts", "src/index.ts", "src/mcp-agent.ts"],
      all: true,
      thresholds: {
        lines: 99,
        functions: 94,
        branches: 92,
        statements: 99,
      },
    },
  },
});
