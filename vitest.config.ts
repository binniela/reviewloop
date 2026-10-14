import { defineConfig } from "vitest/config";
// Each test boots its own PGlite database; on a busy laptop or a 2-core CI runner that alone can take
// several seconds, so the timeouts leave room rather than flake.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000, maxWorkers: 2 } });
