import { defineConfig } from "vitest/config";

// The e2e cases are marked `it.concurrent` (see tests/e2e.test.ts) and their
// heavy steps (clang++ compile + running the binary) are async child processes.
// Raise the per-file concurrency cap above vitest's default of 5 so more cases
// compile in parallel — the suite is CPU/IO bound on clang++, not the event loop.
export default defineConfig({
  test: {
    maxConcurrency: 12,
  },
});
