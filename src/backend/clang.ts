// Stage 4: hand the generated C++ to clang++, which compiles + links a native binary.

import { execFileSync } from "child_process";

export function buildExecutable(cppPath: string, outPath: string): void {
  // -Werror=return-type turns "non-void function may not return a value" into a
  // hard error, so control-flow paths that forget to return fail the build.
  execFileSync("clang++", ["-std=c++17", "-Werror=return-type", cppPath, "-o", outPath], {
    stdio: "inherit",
  });
}
