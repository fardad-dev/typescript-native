// Orchestrates the four pipeline stages: read -> lower -> emit -> build.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { lower } from "./frontend/lower";
import { emit } from "./codegen/emit";
import { buildExecutable } from "./backend/clang";

export interface Options {
  input: string;
  output: string;
  emitLlvm: boolean;
}

export function compile(opts: Options): void {
  const source = fs.readFileSync(opts.input, "utf8");
  const mod = lower(opts.input, source); // stages 1 + 2: parse + lower to IR
  const ir = emit(mod); // stage 3: IR -> LLVM IR text

  const llPath = opts.emitLlvm
    ? `${opts.output}.ll`
    : path.join(os.tmpdir(), `${path.basename(opts.output)}.${process.pid}.ll`);

  fs.writeFileSync(llPath, ir);
  buildExecutable(llPath, opts.output); // stage 4: clang -> executable

  if (!opts.emitLlvm) fs.unlinkSync(llPath);
}
