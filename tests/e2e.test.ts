import { describe, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { compileAsync } from "../src/driver";

// Each `cases/<name>.ts` is compiled to a native binary, run, and its stdout
// compared against `cases/<name>.expected`. This exercises the whole pipeline:
// parse -> lower -> emit C++ -> clang++ -> run.
//
// Cases run with `it.concurrent`, and the slow steps (clang++ compile, running
// the binary) use async child processes — so several cases compile in parallel
// instead of blocking the event loop one at a time.
const run = promisify(execFile);
const casesDir = path.join(__dirname, "cases");

describe("e2e: compile a .ts case to a native binary and run it", () => {
  const names = fs
    .readdirSync(casesDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.basename(f, ".ts"));

  for (const name of names) {
    it.concurrent(`${name}.ts prints its expected stdout`, async ({ expect }) => {
      const input = path.join(casesDir, `${name}.ts`);
      const expected = fs.readFileSync(path.join(casesDir, `${name}.expected`), "utf8");
      // Unique per case, so concurrent runs never collide on the same path.
      const out = path.join(os.tmpdir(), `tsn-${name}-${process.pid}`);

      await compileAsync({ input, output: out, emitCpp: false });
      const { stdout } = await run(out, { encoding: "utf8" });
      fs.rmSync(out, { force: true });

      expect(stdout).toBe(expected);
    });
  }
});
