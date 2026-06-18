// Stage 4: hand the LLVM IR to clang, which assembles + links a native binary.
// clang compiles .ll directly, so no separate llc/opt step is needed.

import { execFileSync } from "child_process";

export function buildExecutable(llPath: string, outPath: string): void {
  execFileSync("clang", [llPath, "-o", outPath], { stdio: "inherit" });
}
