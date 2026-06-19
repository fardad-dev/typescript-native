// Stage 4: hand the generated C++ to clang++, which compiles + links a native binary.

import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

// -Werror=return-type turns "non-void function may not return a value" into a
// hard error, so control-flow paths that forget to return fail the build.
const CLANG_ARGS = (cppPath: string, outPath: string) => [
  "-std=c++17",
  "-Werror=return-type",
  cppPath,
  "-o",
  outPath,
];

export function buildExecutable(cppPath: string, outPath: string): void {
  execFileSync("clang++", CLANG_ARGS(cppPath, outPath), { stdio: "inherit" });
}

// Async variant: clang++ runs as a child process without blocking the event
// loop, so independent builds (e.g. the parallel test suite) overlap. On
// failure we surface clang++'s stderr, since stdio isn't inherited here.
export async function buildExecutableAsync(cppPath: string, outPath: string): Promise<void> {
  try {
    await execFileP("clang++", CLANG_ARGS(cppPath, outPath));
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(e.stderr?.trim() || e.message);
  }
}
