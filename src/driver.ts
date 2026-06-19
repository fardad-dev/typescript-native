// Orchestrates the four pipeline stages: read -> lower -> emit C++ -> build.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { lower } from "./frontend/lower";
import { emit } from "./codegen/emit";
import { buildExecutable } from "./backend/clang";

export interface Options {
  input: string;
  output: string;
  emitCpp: boolean;
}

export function compile(opts: Options): void {
  const source = fs.readFileSync(opts.input, "utf8");
  const mod = lower(opts.input, source); // stages 1 + 2: parse + lower to IR
  const cpp = emit(mod); // stage 3: IR -> C++ source

  const cppPath = opts.emitCpp
    ? `${opts.output}.cpp`
    : path.join(os.tmpdir(), `${path.basename(opts.output)}.${process.pid}.cpp`);

  fs.writeFileSync(cppPath, cpp);
  buildExecutable(cppPath, opts.output); // stage 4: clang++ -> executable

  if (!opts.emitCpp) fs.unlinkSync(cppPath);
}
