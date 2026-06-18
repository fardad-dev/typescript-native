import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { compile } from "../src/driver";

// Each `cases/<name>.ts` is compiled to a native binary, run, and its stdout
// compared against `cases/<name>.expected`. This exercises the whole pipeline:
// parse -> lower -> emit LLVM IR -> clang -> run.
const casesDir = path.join(__dirname, "cases");

describe("e2e: compile a .ts case to a native binary and run it", () => {
  const names = fs
    .readdirSync(casesDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.basename(f, ".ts"));

  for (const name of names) {
    it(`${name}.ts prints its expected stdout`, () => {
      const input = path.join(casesDir, `${name}.ts`);
      const expected = fs.readFileSync(path.join(casesDir, `${name}.expected`), "utf8");
      const out = path.join(os.tmpdir(), `tsn-${name}-${process.pid}`);

      compile({ input, output: out, emitLlvm: false });
      const stdout = execFileSync(out, { encoding: "utf8" });
      fs.rmSync(out, { force: true });

      expect(stdout).toBe(expected);
    });
  }
});
