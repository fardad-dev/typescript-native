// Stage 4: hand the generated C++ to clang++, which compiles + links a native binary.

import { execFileSync } from "child_process";

export function buildExecutable(cppPath: string, outPath: string): void {
  execFileSync("clang++", ["-std=c++17", cppPath, "-o", outPath], { stdio: "inherit" });
}
