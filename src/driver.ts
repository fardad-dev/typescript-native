// Orchestrates the four pipeline stages: read -> lower -> emit C++ -> build.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { lower } from "./frontend/lower";
import { emit } from "./codegen/emit";
import { buildExecutable, buildExecutableAsync } from "./backend/clang";

export interface Options {
  input: string;
  output: string;
  emitCpp: boolean;
}

// Stages 1-3: read source -> lower to IR -> emit C++ -> write the .cpp to disk.
// Returns the path of the C++ file the backend should compile.
function emitCppFile(opts: Options): string {
  const source = fs.readFileSync(opts.input, "utf8");
  const mod = lower(opts.input, source); // stages 1 + 2: parse + lower to IR
  const cpp = emit(mod); // stage 3: IR -> C++ source

  const cppPath = opts.emitCpp
    ? `${opts.output}.cpp`
    : path.join(
        os.tmpdir(),
        `${path.basename(opts.output)}.${process.pid}.cpp`,
      );

  fs.writeFileSync(cppPath, cpp);
  return cppPath;
}

export function compile(opts: Options): void {
  const cppPath = emitCppFile(opts);
  buildExecutable(cppPath, opts.output); // stage 4: clang++ -> executable
  if (!opts.emitCpp) fs.unlinkSync(cppPath);
}

// Same pipeline as compile(), but the clang++ step runs as a non-blocking child
// process so independent compiles can overlap (used by the parallel test suite).
export async function compileAsync(opts: Options): Promise<void> {
  const cppPath = emitCppFile(opts);
  await buildExecutableAsync(cppPath, opts.output); // stage 4: clang++ -> executable
  if (!opts.emitCpp) fs.unlinkSync(cppPath);
}
