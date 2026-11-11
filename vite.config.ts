import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset URLs let the build run from any sub-path, e.g. https://<user>.github.io/<repo>/
  base: "./",
  build: {
    target: "es2022",
    // Keep every UI icon embedded in the stylesheet as a data URI: no extra requests.
    assetsInlineLimit: 8192,
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "src/**/*.worker.ts"],
      reporter: ["text", "html"],
      // The DOM layer is covered by the Playwright suite in e2e/; gate the pure logic here.
      thresholds: {
        "src/core/**": { lines: 95, functions: 95, branches: 85, statements: 95 },
        "src/render/encode-core.ts": { lines: 90, functions: 90, branches: 80, statements: 90 },
      },
    },
  },
});
