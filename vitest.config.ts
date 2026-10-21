import { defineConfig } from "vitest/config";

export default defineConfig({
  // Unit tests run the Full edition (src/env.d.ts).
  define: { __FULL__: true, __EXTRA_COPY_IDS__: [] },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "bridge/**/*.test.ts"],
  },
});
