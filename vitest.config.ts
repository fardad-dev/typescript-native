import { defineConfig } from "vitest/config";

// The e2e cases are marked `it.concurrent` (see tests/e2e.test.ts) and their
// heavy steps (clang++ compile + running the binary) are async child processes.
// Raise the per-file concurrency cap above vitest's default of 5 so more cases
// compile in parallel — the suite is CPU/IO bound on clang++, not the event loop.
export default defineConfig({
  test: {
    maxConcurrency: 12,
    // Each case compiles a real binary with `clang++ -O3` (see src/backend/clang.ts).
    // -O3 trades compile time for fast output; under concurrency a few cases can
    // exceed vitest's 5s default, so give the compile+run step generous headroom.
    testTimeout: 30000,
  },
});
